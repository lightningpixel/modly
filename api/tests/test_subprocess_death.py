"""#369: a dead extension subprocess must say why it died."""
import io
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest.mock import patch

from services import extension_process
from services.extension_process import ExtensionProcess
from services.subprocess_death import describe_death, describe_exit_code, relevant_lines


class DescribeDeathTests(unittest.TestCase):
    def test_cuda_oom_is_named_and_quoted(self) -> None:
        msg = describe_death("triposg/generate", "while loading the model", 1, [
            "Loading pipeline components...:  40%|████      | 2/5 [00:01<00:02,  1.20it/s]",
            "torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB",
        ])
        self.assertIn("[triposg/generate] Subprocess died while loading the model (exit code 1).", msg)
        self.assertIn("GPU ran out of memory (VRAM)", msg)
        self.assertIn("Tried to allocate 2.00 GiB", msg)
        self.assertNotIn("it/s", msg)  # progress bars are noise

    def test_windows_access_violation_without_stderr(self) -> None:
        msg = describe_death("x", "during generation", 0xC0000005, [])
        self.assertIn("(exit code 0xC0000005).", msg)
        self.assertIn("Likely cause: access violation", msg)
        self.assertEqual(msg.count("access violation"), 1)
        self.assertIn("wrote nothing", msg)

    def test_signed_windows_code_is_recognized(self) -> None:
        self.assertEqual(describe_exit_code(-1073741819), "0xC0000005")
        self.assertEqual(describe_exit_code(-9), "signal 9")
        self.assertEqual(describe_exit_code(3), "3")

    def test_sigkill_points_at_the_oom_killer(self) -> None:
        msg = describe_death("x", "while loading the model", -9, ["Loading weights"])
        self.assertIn("signal 9", msg)
        self.assertIn("out-of-memory killer", msg)

    def test_dll_failure_is_named_when_python_exited_normally(self) -> None:
        msg = describe_death("x", "while starting", 1, ["ImportError: DLL load failed while importing _C"])
        self.assertIn("Likely cause: a system library (DLL)", msg)

    def test_missing_module_names_the_module(self) -> None:
        msg = describe_death("x", "while starting", 1, ["ModuleNotFoundError: No module named 'xatlas'"])
        self.assertIn("(xatlas)", msg)
        self.assertIn("Repair the extension", msg)

    def test_windows_paging_file(self) -> None:
        msg = describe_death("x", "while loading the model", 1,
                             ["OSError: [WinError 1455] The paging file is too small for this operation to complete"])
        self.assertIn("virtual memory", msg)

    def test_unknown_cause_still_quotes_the_output(self) -> None:
        msg = describe_death("x", "during generation", 1, ["something odd happened"])
        self.assertNotIn("Likely cause", msg)
        self.assertIn("  something odd happened", msg)

    def test_earlier_import_warning_does_not_hide_a_native_crash(self) -> None:
        # xformers prints this on every Windows import, then works fine.
        msg = describe_death("x", "during generation", 0xC0000005, [
            "A matching Triton is not available, some optimizations will not be enabled",
            "ModuleNotFoundError: No module named 'triton'",
        ])
        self.assertIn("Likely cause: access violation", msg)
        self.assertNotIn("Repair the extension", msg)

    def test_clear_stderr_cause_beats_a_native_exit_code(self) -> None:
        msg = describe_death("x", "while loading the model", 0xC0000409,
                             ["torch.OutOfMemoryError: CUDA out of memory."])
        self.assertIn("GPU ran out of memory", msg)

    def test_cause_found_beyond_the_cut(self) -> None:
        long_line = "OSError: " + "C:\\models\\x" * 60 + " Error while deserializing header: HeaderTooLarge"
        msg = describe_death("x", "while loading the model", 1, [long_line])
        self.assertIn("corrupted or incomplete", msg)

    def test_tail_is_bounded(self) -> None:
        lines = relevant_lines([f"line {i}" for i in range(100)] + ["x" * 1000])
        self.assertEqual(len(lines), 20)
        self.assertEqual(lines[0], "line 81")
        self.assertLess(len(lines[-1]), 400)


# A stand-in for runner.py: says ready, then dies the way it is told to.
_FAKE_RUNNER = textwrap.dedent("""
    import json, os, signal, sys
    mode = os.environ["FAKE_DEATH"]
    print(json.dumps({"type": "ready"}), flush=True)
    sys.stdin.readline()  # the load request
    if mode == "oom":
        sys.stderr.write("Loading checkpoint shards:  50%|#####     | 1/2 [00:01<00:01]\\r")
        sys.stderr.write("torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 4.00 GiB\\n")
        sys.stderr.flush()
        os._exit(1)
    if mode == "sigkill":
        os.kill(os.getpid(), signal.SIGKILL)
    if mode == "silent":
        os._exit(3)
""")


def _reap(proc: ExtensionProcess) -> None:
    child = proc._proc
    if child is not None and child.poll() is None:
        child.kill()
        child.wait(timeout=10)


class RealSubprocessDeathTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        runner = Path(self.tmp.name) / "runner.py"
        runner.write_text(_FAKE_RUNNER, encoding="utf-8")
        patches = [
            patch.object(extension_process, "_venv_python", lambda _dir: Path(sys.executable)),
            patch.object(extension_process, "_RUNNER_PATH", runner),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(self.tmp.cleanup)

    def _load_with(self, mode: str) -> tuple[ExtensionProcess, str]:
        proc = ExtensionProcess(ext_dir=Path(self.tmp.name), manifest={"id": "fake/generate"})
        # StringIO, not a file: the stderr thread may still print after the test.
        with patch.dict(os.environ, {"FAKE_DEATH": mode}), patch("sys.stderr", new=io.StringIO()):
            with self.assertRaises(RuntimeError) as ctx:
                proc.load()
        self.addCleanup(_reap, proc)
        return proc, str(ctx.exception)

    def test_crash_during_load_reports_its_stderr(self) -> None:
        proc, msg = self._load_with("oom")
        self.assertIn("Subprocess died while loading the model (exit code 1)", msg)
        self.assertIn("GPU ran out of memory", msg)
        self.assertIn("Tried to allocate 4.00 GiB", msg)
        self.assertFalse(proc.is_loaded())

    def test_silent_crash_reports_the_exit_code(self) -> None:
        _, msg = self._load_with("silent")
        self.assertIn("(exit code 3)", msg)
        self.assertIn("wrote nothing", msg)

    @unittest.skipIf(sys.platform == "win32", "no SIGKILL on Windows")
    def test_killed_process_is_reported_as_killed(self) -> None:
        _, msg = self._load_with("sigkill")
        self.assertIn("signal 9", msg)

    def test_stop_by_modly_is_not_reported_as_a_crash(self) -> None:
        proc = ExtensionProcess(ext_dir=Path(self.tmp.name), manifest={"id": "fake/generate"})
        with patch.dict(os.environ, {"FAKE_DEATH": "never"}):
            proc._start()
        proc.stop()
        proc._queue.put(None)
        with self.assertRaises(RuntimeError) as ctx:
            proc._recv(timeout=1.0, phase="during generation")
        self.assertIn("stopped by Modly", str(ctx.exception))
        self.assertNotIn("killer", str(ctx.exception))

    def test_failed_stop_keeps_reporting_real_crashes(self) -> None:
        proc = ExtensionProcess(ext_dir=Path(self.tmp.name), manifest={"id": "fake/generate"})
        with patch.dict(os.environ, {"FAKE_DEATH": "silent"}):
            proc._start()
        self.addCleanup(_reap, proc)
        child = proc._proc
        with patch.object(child, "kill", side_effect=PermissionError("denied")):
            with self.assertRaises(RuntimeError):
                proc.stop()
        self.assertFalse(proc._run.stopped_by_modly)

    def test_a_restart_does_not_borrow_the_new_process_output(self) -> None:
        proc = ExtensionProcess(ext_dir=Path(self.tmp.name), manifest={"id": "fake/generate"})
        with patch.dict(os.environ, {"FAKE_DEATH": "oom"}), patch("sys.stderr", new=io.StringIO()):
            proc._start()
            old_run = proc._run
            proc._send({"action": "load"})
            old_run.proc.wait(timeout=10)
            old_run.stderr_thread.join(timeout=5)
        with patch.dict(os.environ, {"FAKE_DEATH": "never"}):
            proc._start()  # a new worker replaces the dead one
        self.addCleanup(proc.stop)
        msg = str(proc._death_error("during generation", old_run))
        self.assertIn("(exit code 1)", msg)
        self.assertIn("Tried to allocate 4.00 GiB", msg)

    def test_worker_that_closed_stdout_but_lives_on_is_killed(self) -> None:
        proc = ExtensionProcess(ext_dir=Path(self.tmp.name), manifest={"id": "fake/generate"})
        with patch.dict(os.environ, {"FAKE_DEATH": "never"}):
            proc._start()
        self.addCleanup(_reap, proc)
        run = proc._run
        with patch.object(run.proc, "wait", side_effect=[subprocess.TimeoutExpired("py", 5), None]), \
                patch.object(run.proc, "kill", wraps=run.proc.kill) as kill:
            proc._death_error("during generation", run)
        kill.assert_called_once()
        run.proc.wait(timeout=10)


if __name__ == "__main__":
    unittest.main()

import io
import platform
import queue
import unittest
from pathlib import Path

from services.extension_process import ExtensionProcess, _venv_python


def _make_proc() -> ExtensionProcess:
    return ExtensionProcess(ext_dir=None, manifest={"id": "demo"})  # type: ignore[arg-type]


class ExtensionProcessTests(unittest.TestCase):
    def test_read_loop_writes_sentinel_to_own_queue_only(self) -> None:
        proc = _make_proc()

        old_queue: queue.Queue = queue.Queue()
        new_queue: queue.Queue = queue.Queue()
        proc._queue = new_queue

        fake_proc = type("FakeProc", (), {"stdout": io.StringIO("")})()

        proc._read_loop(fake_proc, old_queue)

        self.assertFalse(old_queue.empty())
        self.assertTrue(new_queue.empty())

    def test_stop_kills_and_verifies_subprocess_exit(self) -> None:
        proc = _make_proc()

        class FakeProcess:
            def __init__(self) -> None:
                self.alive = True
                self.kill_called = False
                self.wait_called = False

            def poll(self):
                return None if self.alive else -9

            def kill(self) -> None:
                self.kill_called = True
                self.alive = False

            def wait(self, timeout: float):
                self.wait_called = True
                return -9

        child = FakeProcess()
        proc._proc = child  # type: ignore[assignment]
        proc._loaded = True

        proc.stop()

        self.assertTrue(child.kill_called)
        self.assertTrue(child.wait_called)
        self.assertIsNone(proc._proc)
        self.assertFalse(proc._loaded)

    def test_stop_failure_keeps_live_process_reference_and_raises(self) -> None:
        proc = _make_proc()

        class StuckProcess:
            def poll(self):
                return None

            def kill(self) -> None:
                raise PermissionError("cannot kill")

            def wait(self, timeout: float):
                raise AssertionError("wait must not run after kill failure")

        child = StuckProcess()
        proc._proc = child  # type: ignore[assignment]
        proc._loaded = True

        with self.assertRaisesRegex(RuntimeError, "Could not stop"):
            proc.stop()

        self.assertIs(proc._proc, child)
        self.assertFalse(proc._loaded)


class VenvPythonTests(unittest.TestCase):
    def test_resolves_interpreter_path_for_current_platform(self) -> None:
        result = _venv_python(Path("/tmp/ext"))
        if platform.system() == "Windows":
            self.assertEqual(result, Path("/tmp/ext") / "venv" / "Scripts" / "python.exe")
        else:
            self.assertEqual(result, Path("/tmp/ext") / "venv" / "bin" / "python")


class MissingModuleExtractionTests(unittest.TestCase):
    def test_extracts_module_name_from_message(self) -> None:
        proc = _make_proc()
        name = proc._extract_missing_module({"message": "No module named 'PIL'"})
        self.assertEqual(name, "PIL")

    def test_extracts_module_name_from_traceback(self) -> None:
        proc = _make_proc()
        name = proc._extract_missing_module(
            {"message": "boom", "traceback": "...\nModuleNotFoundError: No module named \"numpy\"\n"}
        )
        self.assertEqual(name, "numpy")

    def test_returns_none_when_no_missing_module(self) -> None:
        proc = _make_proc()
        self.assertIsNone(proc._extract_missing_module({"message": "some other error"}))


class AutoRepairPackageTests(unittest.TestCase):
    """Safety: only known modules map to a package; never guess arbitrary names."""

    def test_maps_known_module_to_package(self) -> None:
        proc = _make_proc()
        self.assertEqual(proc._resolve_auto_repair_package("PIL"), "Pillow")

    def test_maps_known_module_via_root_package(self) -> None:
        proc = _make_proc()
        self.assertEqual(proc._resolve_auto_repair_package("PIL.Image"), "Pillow")

    def test_returns_none_for_unknown_module(self) -> None:
        proc = _make_proc()
        self.assertIsNone(proc._resolve_auto_repair_package("totally_unknown_pkg"))


class RecvTests(unittest.TestCase):
    def test_returns_message_from_queue(self) -> None:
        proc = _make_proc()
        proc._queue.put({"type": "ready"})
        self.assertEqual(proc._recv(timeout=1.0), {"type": "ready"})

    def test_none_sentinel_raises_runtime_error(self) -> None:
        proc = _make_proc()
        proc._queue.put(None)
        with self.assertRaises(RuntimeError):
            proc._recv(timeout=1.0)

    def test_empty_queue_raises_timeout_error(self) -> None:
        proc = _make_proc()
        with self.assertRaises(TimeoutError):
            proc._recv(timeout=0.05)


class GenerateErrorLoadedFlagTests(unittest.TestCase):
    """
    Issue #239: a generation that fails during lazy texture setup leaves the
    worker without a model. If _loaded stays True, GeneratorRegistry.get_active()
    skips load() forever and every later run reuses the broken worker.
    """

    def _failing_generate(self, error_msg: dict) -> ExtensionProcess:
        proc = _make_proc()
        proc._loaded = True
        proc._send = lambda msg: None  # type: ignore[assignment]
        proc._queue.put(error_msg)
        with self.assertRaises(RuntimeError):
            proc.generate(b"", {})
        return proc

    def test_clears_loaded_when_worker_reports_model_lost(self) -> None:
        proc = self._failing_generate(
            {"type": "error", "message": "No module named 'xatlas'", "loaded": False}
        )
        self.assertFalse(proc._loaded)

    def test_keeps_loaded_when_worker_still_has_its_model(self) -> None:
        proc = self._failing_generate(
            {"type": "error", "message": "bad input image", "loaded": True}
        )
        self.assertTrue(proc._loaded)

    def test_keeps_loaded_when_worker_reports_no_state(self) -> None:
        proc = self._failing_generate({"type": "error", "message": "boom"})
        self.assertTrue(proc._loaded)

    def test_error_still_propagates_the_original_cause(self) -> None:
        proc = _make_proc()
        proc._loaded = True
        proc._send = lambda msg: None  # type: ignore[assignment]
        proc._queue.put(
            {"type": "error", "message": "short", "traceback": "full traceback here",
             "loaded": False}
        )
        with self.assertRaises(RuntimeError) as ctx:
            proc.generate(b"", {})
        self.assertIn("full traceback here", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()

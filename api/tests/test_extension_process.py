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


if __name__ == "__main__":
    unittest.main()

import importlib
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

llm_server = importlib.import_module("services.llm_server")

_ASSETS = [
    {"name": "llama-b1-bin-win-cuda-12.4-x64.zip"},
    {"name": "cudart-llama-bin-win-cuda-12.4-x64.zip"},
    {"name": "llama-b1-bin-win-vulkan-x64.zip"},
    {"name": "llama-b1-bin-win-cpu-x64.zip"},
]


def _smi(returncode: int, stdout: str = "") -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(["nvidia-smi", "-L"], returncode, stdout, "")


class HasNvidiaGpuTests(unittest.TestCase):
    """nvidia-smi on PATH is not proof of a usable NVIDIA GPU (#386): on an AMD
    machine with a leftover nvidia-smi.exe, the CUDA build was installed and
    llama-server ran on CPU."""

    def setUp(self) -> None:
        llm_server.has_nvidia_gpu.cache_clear()
        self.addCleanup(llm_server.has_nvidia_gpu.cache_clear)

    def _detect(self, which, run) -> bool:
        with mock.patch.object(llm_server.shutil, "which", return_value=which), \
             mock.patch.object(llm_server.subprocess, "run", **run):
            return llm_server.has_nvidia_gpu()

    def test_no_binary(self) -> None:
        self.assertFalse(self._detect(None, {"side_effect": AssertionError("must not run")}))

    def test_binary_without_driver(self) -> None:
        out = _smi(9, "NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver.")
        self.assertFalse(self._detect("C:/nvidia-smi.exe", {"return_value": out}))

    def test_binary_lists_no_gpu(self) -> None:
        self.assertFalse(self._detect("C:/nvidia-smi.exe", {"return_value": _smi(0, "No devices found.")}))

    def test_binary_crashes(self) -> None:
        self.assertFalse(self._detect("C:/nvidia-smi.exe", {"side_effect": OSError("boom")}))

    def test_working_gpu(self) -> None:
        out = _smi(0, "GPU 0: NVIDIA GeForce RTX 5070 (UUID: GPU-1234)\n")
        self.assertTrue(self._detect("C:/nvidia-smi.exe", {"return_value": out}))


class PickAssetsWindowsTests(unittest.TestCase):
    def _pick(self, nvidia: bool) -> list[str]:
        with mock.patch.object(llm_server.sys, "platform", "win32"), \
             mock.patch.object(llm_server, "has_nvidia_gpu", return_value=nvidia), \
             mock.patch.object(llm_server, "_driver_cuda_version", return_value=(12, 8)):
            return [a["name"] for a in llm_server._pick_assets(_ASSETS)]

    def test_no_usable_nvidia_gpu_gets_vulkan(self) -> None:
        self.assertEqual(self._pick(False), ["llama-b1-bin-win-vulkan-x64.zip"])

    def test_nvidia_gpu_gets_cuda_and_runtime(self) -> None:
        self.assertEqual(
            self._pick(True),
            ["llama-b1-bin-win-cuda-12.4-x64.zip", "cudart-llama-bin-win-cuda-12.4-x64.zip"],
        )


class RepairEngineTests(unittest.TestCase):
    """Repair swaps a wrong build for the right one: the old backend DLLs must
    go, and neither a failed download nor a file still locked by a running
    llama-server may destroy the engine that still works."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        root = Path(self._tmp.name)
        self.bin_dir = root / "bin"
        self.bin_dir.mkdir()
        (self.bin_dir / "ggml-cuda.dll").write_bytes(b"old")
        self.archive = root / "vulkan.zip"
        self.archive.write_bytes(b"zip")

        def extract(tmp: Path, name: str, dest: Path) -> int:
            dest.mkdir(exist_ok=True)
            (dest / "ggml-vulkan.dll").write_bytes(b"new")
            (dest / llm_server.binary_path().name).write_bytes(b"new")
            return 2

        self.unload_all = mock.Mock()
        for patcher in (
            mock.patch.object(llm_server, "BIN_DIR", self.bin_dir),
            mock.patch.object(llm_server, "_fetch_release", return_value={"tag_name": "b1", "assets": []}),
            mock.patch.object(llm_server, "_pick_assets", return_value=[{"name": "vulkan.zip"}]),
            mock.patch.object(llm_server, "_extract_archive", side_effect=extract),
            mock.patch.object(llm_server.llama_pool, "unload_all", self.unload_all),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_repair_replaces_the_old_build(self) -> None:
        with mock.patch.object(llm_server, "_download_asset", return_value=self.archive):
            llm_server.install_binary(lambda _: None, lambda: None, clean=True)
        self.assertEqual(
            sorted(p.name for p in self.bin_dir.iterdir()),
            sorted(["ggml-vulkan.dll", llm_server.binary_path().name]),
        )
        self.unload_all.assert_called_once_with(force=True)
        self.assertFalse(self.archive.exists())

    def test_failed_download_keeps_the_installed_engine(self) -> None:
        with mock.patch.object(llm_server, "_download_asset", side_effect=OSError("offline")):
            with self.assertRaises(OSError):
                llm_server.install_binary(lambda _: None, lambda: None, clean=True)
        self.assertTrue((self.bin_dir / "ggml-cuda.dll").exists())
        self.unload_all.assert_not_called()

    def test_locked_engine_is_left_in_place(self) -> None:
        rename = Path.rename

        def locked(path: Path, target):
            if path == self.bin_dir:
                raise PermissionError("in use")
            return rename(path, target)

        with mock.patch.object(llm_server, "_download_asset", return_value=self.archive),              mock.patch.object(Path, "rename", locked),              mock.patch.object(llm_server.time, "sleep"):
            with self.assertRaises(RuntimeError):
                llm_server.install_binary(lambda _: None, lambda: None, clean=True)
        self.assertEqual([p.name for p in self.bin_dir.iterdir()], ["ggml-cuda.dll"])
        self.assertEqual(sorted(p.name for p in self.bin_dir.parent.iterdir()), ["bin"])

    def test_plain_install_keeps_existing_files(self) -> None:
        with mock.patch.object(llm_server, "_download_asset", return_value=self.archive):
            llm_server.install_binary(lambda _: None, lambda: None)
        self.assertTrue((self.bin_dir / "ggml-cuda.dll").exists())
        self.unload_all.assert_not_called()


if __name__ == "__main__":
    unittest.main()

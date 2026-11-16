import hashlib
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import services.generator_registry as registry
from services.image_ops import ImageOpExecutionError
from services.image_ops import requirements as reqs


def _model_req(content: bytes) -> reqs.HFFileRequirement:
    return reqs.HFFileRequirement(
        id="tiny-model",
        label="Tiny model",
        repo_id="org/repo",
        filename="onnx/model.onnx",
        revision="abc",
        size=len(content),
        sha256=hashlib.sha256(content).hexdigest(),
    )


class HFFileRequirementTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.models = Path(self._tmp.name) / "models"
        self._patch = patch.object(registry, "MODELS_DIR", self.models)
        self._patch.start()

    def tearDown(self) -> None:
        self._patch.stop()
        self._tmp.cleanup()

    def test_path_follows_models_dir_at_call_time(self) -> None:
        req = _model_req(b"weights")
        self.assertEqual(req.path, self.models / "tiny-model" / "model.onnx")
        moved = Path(self._tmp.name) / "moved"
        with patch.object(registry, "MODELS_DIR", moved):
            self.assertEqual(req.path, moved / "tiny-model" / "model.onnx")

    def test_ready_only_when_file_has_expected_size(self) -> None:
        req = _model_req(b"weights")
        self.assertFalse(req.is_ready())
        self.assertEqual(req.download_bytes(), 7)
        req.path.parent.mkdir(parents=True)
        req.path.write_bytes(b"wei")  # truncated
        self.assertFalse(req.is_ready())
        req.path.write_bytes(b"weights")
        self.assertTrue(req.is_ready())
        self.assertIsNone(req.download_bytes())

    def test_download_bytes_discounts_a_resumable_part_file(self) -> None:
        req = _model_req(b"0123456789")
        req.path.parent.mkdir(parents=True)
        req.path.with_suffix(".onnx.part").write_bytes(b"0123")
        self.assertEqual(req.download_bytes(), 6)

    def _fake_download(self, content: bytes):
        calls = []

        def download(*, url, filename, dest_dir, progress_cb, **_):
            calls.append(url)
            progress_cb({"status": "Downloading… 50%", "bytesDownloaded": len(content) // 2, "totalBytes": len(content)})
            Path(dest_dir).mkdir(parents=True, exist_ok=True)  # as the real downloader does
            (Path(dest_dir) / filename).write_bytes(content)
            return len(content)

        return download, calls

    def test_install_downloads_pinned_revision_and_verifies(self) -> None:
        req = _model_req(b"weights!")
        download, calls = self._fake_download(b"weights!")
        frames = []
        with patch("routers.model._download_file_streamed", download):
            req.install(frames.append)
        self.assertTrue(req.is_ready())
        self.assertIn("org/repo", calls[0])
        self.assertIn("/abc/", calls[0])  # pinned revision
        self.assertEqual(frames[-1]["percent"], 100)
        self.assertEqual(frames[0]["percent"], 50)
        self.assertEqual(frames[0]["status"], "Downloading Tiny model… 50%")

    def test_install_rejects_a_corrupted_download(self) -> None:
        req = _model_req(b"weights")
        download, _ = self._fake_download(b"WEIGHTS")  # right size, wrong bytes
        with patch("routers.model._download_file_streamed", download):
            with self.assertRaisesRegex(ImageOpExecutionError, "checksum"):
                req.install(lambda msg: None)
        self.assertFalse(req.path.exists())

    def test_install_reports_network_failure_clearly(self) -> None:
        req = _model_req(b"weights")

        def download(**_):
            raise RuntimeError("Failed to download model.onnx: <urlopen error getaddrinfo failed>")

        with patch("routers.model._download_file_streamed", download):
            with self.assertRaisesRegex(ImageOpExecutionError, "internet connection"):
                req.install(lambda msg: None)

    def test_install_is_a_noop_when_ready(self) -> None:
        req = _model_req(b"weights")
        req.path.parent.mkdir(parents=True)
        req.path.write_bytes(b"weights")
        with patch("routers.model._download_file_streamed", side_effect=AssertionError("no download")):
            req.install(lambda msg: None)

    def test_offline_mode_fails_without_network(self) -> None:
        req = _model_req(b"weights")
        with patch.dict("os.environ", {"HF_HUB_OFFLINE": "1"}), \
             patch("routers.model._download_file_streamed", side_effect=AssertionError("no download")):
            with self.assertRaisesRegex(ImageOpExecutionError, "HF_HUB_OFFLINE"):
                req.install(lambda msg: None)


class FakePopen:
    def __init__(self, lines, code):
        self.stdout = iter(line + "\n" for line in lines)
        self._code = code

    def wait(self):
        return self._code


class PipPackageRequirementTests(unittest.TestCase):
    def setUp(self) -> None:
        self.req = reqs.PipPackageRequirement(
            id="definitely_not_installed_pkg", label="Fake runtime",
            pip_spec="definitely_not_installed_pkg==1.0", approx_bytes=123,
        )

    def test_not_ready_reports_approximate_size(self) -> None:
        self.assertFalse(self.req.is_ready())
        self.assertEqual(self.req.download_bytes(), 123)

    def test_already_installed_skips_pip(self) -> None:
        req = reqs.PipPackageRequirement(id="json", label="json", pip_spec="json", approx_bytes=1)
        self.assertTrue(req.is_ready())
        self.assertIsNone(req.download_bytes())
        with patch.object(subprocess, "Popen", side_effect=AssertionError("pip must not run")):
            req.install(lambda msg: None)

    def test_pip_failure_raises_a_clear_error(self) -> None:
        lines = [
            "Collecting definitely_not_installed_pkg==1.0",
            "WARNING: Retrying ... NewConnectionError: Failed to establish a new connection",
            "ERROR: Could not find a version that satisfies the requirement definitely_not_installed_pkg==1.0",
            "ERROR: No matching distribution found for definitely_not_installed_pkg==1.0",
        ]
        frames = []
        with patch.object(subprocess, "Popen", return_value=FakePopen(lines, 1)) as popen:
            with self.assertRaises(ImageOpExecutionError) as caught:
                self.req.install(frames.append)
        message = str(caught.exception)
        self.assertIn("pip exited with code 1", message)
        self.assertIn("internet connection", message)
        self.assertIn("No matching distribution", message)
        command = popen.call_args.args[0]
        self.assertEqual(command[1:4], ["-m", "pip", "install"])
        self.assertIn("definitely_not_installed_pkg==1.0", command)
        self.assertTrue(any(f["percent"] > 0 for f in frames))

    def test_success_without_importable_module_is_an_error(self) -> None:
        with patch.object(subprocess, "Popen", return_value=FakePopen(["Successfully installed x"], 0)):
            with self.assertRaisesRegex(ImageOpExecutionError, "cannot be found"):
                self.req.install(lambda msg: None)

    def test_onnxruntime_is_pinned_and_not_in_requirements_txt(self) -> None:
        self.assertRegex(reqs.ONNXRUNTIME.pip_spec, r"^onnxruntime==\d+\.\d+\.\d+$")
        requirements_txt = (Path(__file__).resolve().parents[1] / "requirements.txt").read_text()
        self.assertNotIn("onnxruntime", requirements_txt)


if __name__ == "__main__":
    unittest.main()

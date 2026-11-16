import hashlib
import importlib
import tempfile
import unittest
from pathlib import Path
from unittest import mock

llm_server = importlib.import_module("services.llm_server")
llm_router = importlib.import_module("routers.llm")

_VISION = {
    "id": "vl",
    "hf_filename": "weights.gguf",
    "hf_mmproj_filename": "mmproj-F16.gguf",
}


class DiscardIncompleteTests(unittest.TestCase):
    """Cancelling a download has to leave nothing behind. A vision model fetches
    weights then projector, so a cancel during the second one used to leave the
    finished weights on disk under a model still reported `downloaded: false` —
    the UI offers no trash button for those, so the space was unreclaimable."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self._orig = llm_server.LLM_MODELS_DIR
        llm_server.LLM_MODELS_DIR = Path(self._tmp.name)

    def tearDown(self) -> None:
        llm_server.LLM_MODELS_DIR = self._orig
        self._tmp.cleanup()

    def _touch(self, name: str) -> Path:
        p = llm_server.LLM_MODELS_DIR / name
        p.write_bytes(b"x")
        return p

    def test_removes_a_part_file(self):
        self._touch("weights.gguf.part")
        removed = llm_router._discard_incomplete(_VISION)
        self.assertEqual(removed, ["weights.gguf.part"])
        self.assertEqual(list(llm_server.LLM_MODELS_DIR.iterdir()), [])

    def test_removes_a_sibling_that_finished_before_the_cancel(self):
        self._touch("weights.gguf")                       # done
        self._touch("mmproj-vl.gguf.part")                # in flight
        removed = llm_router._discard_incomplete(_VISION)
        self.assertIn("weights.gguf", removed)
        self.assertIn("mmproj-vl.gguf.part", removed)
        self.assertEqual(list(llm_server.LLM_MODELS_DIR.iterdir()), [])

    def test_leaves_a_complete_model_alone(self):
        self._touch("weights.gguf")
        self._touch("mmproj-vl.gguf")
        self.assertEqual(llm_router._discard_incomplete(_VISION), [])
        self.assertEqual(len(list(llm_server.LLM_MODELS_DIR.iterdir())), 2)

    def test_nothing_on_disk_is_not_an_error(self):
        self.assertEqual(llm_router._discard_incomplete(_VISION), [])


class _FakeResponse:
    def __init__(self, body: bytes) -> None:
        self._body = body
        self.headers = {"Content-Length": str(len(body))}

    def read(self, _size: int) -> bytes:
        chunk, self._body = self._body, b""
        return chunk

    def __enter__(self):
        return self

    def __exit__(self, *_exc) -> None:
        return None


class EngineDigestTests(unittest.TestCase):
    """The engine archive's files are executed, so a download whose bytes differ
    from the digest GitHub published for the asset must be refused — and must
    not be left behind in the temp folder."""

    BODY = b"llama-server archive bytes"

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        tmp_dir = self._tmp.name
        real_mkstemp = tempfile.mkstemp  # llm_server.tempfile is this same module
        patches = [
            mock.patch.object(llm_server, "urlopen", lambda *_a, **_k: _FakeResponse(self.BODY)),
            mock.patch.object(llm_server.tempfile, "mkstemp", lambda suffix="": real_mkstemp(suffix=suffix, dir=tmp_dir)),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _download(self, digest):
        asset = {"name": "llama-bin-win-x64.zip", "browser_download_url": "https://example.invalid/a.zip"}
        if digest is not None:
            asset["digest"] = digest
        return llm_server._download_asset(asset, lambda _msg: None, lambda: None, "engine")

    def test_matching_digest_keeps_the_archive(self):
        path = self._download("sha256:" + hashlib.sha256(self.BODY).hexdigest())
        self.assertEqual(path.read_bytes(), self.BODY)

    def test_mismatching_digest_is_refused_and_removed(self):
        with self.assertRaises(RuntimeError):
            self._download("sha256:" + "0" * 64)
        self.assertEqual(list(Path(self._tmp.name).iterdir()), [])

    def test_asset_without_digest_is_still_accepted(self):
        path = self._download(None)
        self.assertEqual(path.read_bytes(), self.BODY)


if __name__ == "__main__":
    unittest.main()

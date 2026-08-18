import importlib
import tempfile
import unittest
from pathlib import Path

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


if __name__ == "__main__":
    unittest.main()

import io
import sys
import tempfile
import types
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from services.generators.base import BaseGenerator


class _DownloadGen(BaseGenerator):
    MODEL_ID = "download-test"

    def load(self) -> None:
        pass

    def generate(self, image_bytes, params, progress_cb=None, cancel_event=None) -> Path:
        raise NotImplementedError


class AutoDownloadPrintTests(unittest.TestCase):
    def test_download_progress_print_is_ascii_safe(self) -> None:
        """Regression: Unicode in the print crashes on cp1252/cp932 Windows."""
        fake_hub = types.ModuleType("huggingface_hub")
        fake_hub.snapshot_download = lambda **kwargs: None

        with tempfile.TemporaryDirectory() as tmp:
            gen = _DownloadGen(Path(tmp) / "model", Path(tmp) / "out")
            gen.hf_repo = "org/repo"

            out = io.StringIO()
            with (
                patch.dict(sys.modules, {"huggingface_hub": fake_hub}),
                redirect_stdout(out),
            ):
                gen._auto_download()

        printed = out.getvalue()
        first_line = printed.splitlines()[0]
        self.assertTrue(first_line.startswith("[_DownloadGen] Downloading org/repo ->"))
        self.assertTrue(first_line.endswith("..."))
        self.assertTrue(all(ord(ch) < 128 for ch in printed))


if __name__ == "__main__":
    unittest.main()
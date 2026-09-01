import io
import sys
import unittest
from unittest.mock import patch

from services.stdio_utf8 import ensure_utf8_stdio


class _RecordingStream:
    def __init__(self) -> None:
        self.reconfigure_calls: list[dict] = []

    def reconfigure(self, **kwargs) -> None:
        self.reconfigure_calls.append(kwargs)


class StdioUtf8Tests(unittest.TestCase):
    def test_reconfigures_all_streams_to_utf8(self) -> None:
        fake = _RecordingStream()
        with (
            patch.object(sys, "stdin", fake),
            patch.object(sys, "stdout", fake),
            patch.object(sys, "stderr", fake),
        ):
            ensure_utf8_stdio()

        self.assertEqual(
            fake.reconfigure_calls,
            [
                {"encoding": "utf-8", "errors": "replace"},
                {"encoding": "utf-8", "errors": "replace"},
                {"encoding": "utf-8", "errors": "replace"},
            ],
        )

    def test_skips_streams_without_reconfigure_without_raising(self) -> None:
        with (
            patch.object(sys, "stdin", io.StringIO()),
            patch.object(sys, "stdout", io.StringIO()),
            patch.object(sys, "stderr", io.StringIO()),
        ):
            ensure_utf8_stdio()  # must not raise

    def test_ignores_reconfigure_errors(self) -> None:
        class _FailingStream:
            def reconfigure(self, **kwargs):
                raise ValueError("closed stream")

        with (
            patch.object(sys, "stdin", _FailingStream()),
            patch.object(sys, "stdout", _FailingStream()),
            patch.object(sys, "stderr", _FailingStream()),
        ):
            ensure_utf8_stdio()  # must not raise


if __name__ == "__main__":
    unittest.main()
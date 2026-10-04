import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from services.artifact_input import revalidate_artifact_input, validate_artifact_input
from services.video_input import validate_video_input


MP4 = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2"


class VideoInputTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.workspace = Path(self.tmp.name) / "workspace"
        self.video = self.workspace / "Workflows" / "Videos" / "clip.mp4"
        self.video.parent.mkdir(parents=True)
        self.video.write_bytes(MP4)

    def tearDown(self):
        self.tmp.cleanup()

    def test_accepts_supported_video_signatures_as_canonical_regular_files(self):
        samples = {
            "clip.mp4": MP4,
            "clip.mov": b"\x00\x00\x00\x14ftypqt  \x00\x00\x00\x00",
            "clip.webm": b"\x1aE\xdf\xa3\x9fB\x86\x81\x01",
            "clip.mkv": b"\x1aE\xdf\xa3\x9fB\x86\x81\x01",
            "clip.avi": b"RIFF\x10\x00\x00\x00AVI LIST",
        }
        for name, payload in samples.items():
            path = self.video.parent / name
            path.write_bytes(payload)
            with self.subTest(name=name):
                self.assertEqual(validate_video_input(self.workspace, f"Workflows/Videos/{name}")[0], path.resolve())

    def test_rejects_traversal_absolute_encoded_symlink_and_non_regular_paths(self):
        outside = Path(self.tmp.name) / "outside.mp4"
        outside.write_bytes(MP4)
        (self.video.parent / "link.mp4").symlink_to(outside)
        for value in ("../outside.mp4", "/etc/passwd", "C:/outside.mp4", "Workflows/%2e%2e/out.mp4", "Workflows/Videos/link.mp4", "Workflows/Videos"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_video_input(self.workspace, value)

    def test_rejects_extension_magic_mismatch_empty_and_oversized_files(self):
        bad = self.video.parent / "bad.mp4"
        bad.write_bytes(b"not a video")
        empty = self.video.parent / "empty.webm"
        empty.write_bytes(b"")
        unsupported = self.video.parent / "clip.exe"
        unsupported.write_bytes(MP4)
        for value in (bad, empty, unsupported):
            with self.subTest(value=value.name), self.assertRaises(ValueError):
                validate_video_input(self.workspace, value.relative_to(self.workspace).as_posix())
        with patch("services.video_input.MAX_VIDEO_BYTES", len(MP4) - 1):
            with self.assertRaisesRegex(ValueError, "size limit"):
                validate_video_input(self.workspace, "Workflows/Videos/clip.mp4")

    def test_snapshot_detects_replacement_before_inference(self):
        artifact = validate_artifact_input(self.workspace, "video", "Workflows/Videos/clip.mp4")
        replacement = self.video.with_suffix(".replacement")
        replacement.write_bytes(MP4 + b"changed")
        os.replace(replacement, self.video)
        with self.assertRaisesRegex(ValueError, "changed"):
            revalidate_artifact_input(self.workspace, artifact)

import json
import tempfile
import unittest
from pathlib import Path

from services.scene_input import validate_scene_input, revalidate_scene_manifest


class SceneInputTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.workspace = Path(self.tmp.name) / "workspace"
        self.scene = self.workspace / "Workflows" / "room"
        self.scene.mkdir(parents=True)
        (self.scene / "model.glb").write_bytes(b"mesh")
        self.manifest = self.scene / "scene-manifest.json"
        self.manifest.write_text(json.dumps({
            "schema": "modly.scene-manifest.v1",
            "sceneRoot": ".",
            "assets": [{"path": "model.glb"}],
        }))

    def tearDown(self):
        self.tmp.cleanup()

    def test_directory_and_manifest_are_canonical_paths(self):
        expected = self.manifest.resolve()
        self.assertEqual(validate_scene_input(self.workspace, "Workflows/room"), expected)
        self.assertEqual(validate_scene_input(self.workspace, "Workflows/room/scene-manifest.json"), expected)
        self.assertEqual(revalidate_scene_manifest(self.workspace, expected), expected)

    def test_rejects_traversal_absolute_encoded_and_non_manifest_json(self):
        for path in ("../outside", "/etc/passwd", "C:/outside", "Workflows/room/../room", "Workflows/room/other.json", "Workflows/%2e%2e"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                validate_scene_input(self.workspace, path)

    def test_rejects_symlinks_missing_assets_and_oversized_manifest(self):
        outside = Path(self.tmp.name) / "outside"
        outside.mkdir()
        (outside / "scene-manifest.json").write_text(self.manifest.read_text())
        (self.workspace / "Workflows" / "link").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError):
            validate_scene_input(self.workspace, "Workflows/link")

        data = json.loads(self.manifest.read_text())
        data["assets"] = [{"path": "missing.glb"}]
        self.manifest.write_text(json.dumps(data))
        with self.assertRaises(ValueError):
            validate_scene_input(self.workspace, "Workflows/room")

        self.manifest.write_text(" " * (1024 * 1024 + 1))
        with self.assertRaises(ValueError):
            validate_scene_input(self.workspace, "Workflows/room")

    def test_rejects_malformed_manifest_and_asset_paths(self):
        original = json.loads(self.manifest.read_text())
        for patch in (
            {"schema": "wrong"},
            {"assets": "bad"},
            {"assets": [{"path": "../escape.glb"}]},
            {"preview": {"image": None}},
            {"initialView": {"position": [0, 0, 0], "target": [0, 0, 0]}},
        ):
            with self.subTest(patch=patch):
                self.manifest.write_text(json.dumps({**original, **patch}))
                with self.assertRaises(ValueError):
                    validate_scene_input(self.workspace, "Workflows/room")

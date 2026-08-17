import os
import tempfile
import unittest
from pathlib import Path

from services.local_paths import (
    assert_safe_extension_id,
    is_modly_temp_file,
    is_within_directory,
    resolve_readable_mesh_path,
    resolve_workspace_file,
)


class LocalPathsTests(unittest.TestCase):
    def test_workspace_relative_ok(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "Default").mkdir()
            target = root / "Default" / "mesh.glb"
            target.write_bytes(b"glb")
            self.assertEqual(resolve_workspace_file(root, "Default/mesh.glb"), target.resolve())

    def test_workspace_rejects_traversal(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            with self.assertRaises(ValueError):
                resolve_workspace_file(root, "../secret.glb")
            with self.assertRaises(ValueError):
                resolve_workspace_file(root, "Default/../../etc/passwd")
            with self.assertRaises(ValueError):
                resolve_workspace_file(root, "/etc/passwd")

    def test_readable_path_allows_modly_temp(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            workspace = Path(td) / "workspace"
            workspace.mkdir()
            tmp = Path(tempfile.mkdtemp(prefix="modly_import_", dir=tempfile.gettempdir()))
            self.addCleanup(lambda: __import__("shutil").rmtree(tmp, ignore_errors=True))
            mesh = tmp / "mesh.glb"
            mesh.write_bytes(b"glb")
            self.assertTrue(is_modly_temp_file(mesh))
            self.assertEqual(resolve_readable_mesh_path(workspace, str(mesh)), mesh.resolve())

    def test_readable_path_rejects_other_absolute(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            workspace = Path(td) / "workspace"
            workspace.mkdir()
            outsider = Path(td) / "secret.glb"
            outsider.write_bytes(b"no")
            with self.assertRaises(ValueError):
                resolve_readable_mesh_path(workspace, str(outsider))

    def test_within_directory(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            child = root / "a" / "b"
            child.mkdir(parents=True)
            self.assertTrue(is_within_directory(root, child))
            self.assertFalse(is_within_directory(root, Path(os.path.dirname(td))))

    def test_extension_id(self) -> None:
        self.assertEqual(assert_safe_extension_id("mesh-optimizer"), "mesh-optimizer")
        with self.assertRaises(ValueError):
            assert_safe_extension_id("../escape")
        with self.assertRaises(ValueError):
            assert_safe_extension_id("Bad Id")


if __name__ == "__main__":
    unittest.main()

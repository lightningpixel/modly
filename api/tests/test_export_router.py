import base64
import io
import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException

# The export router imports trimesh at module load; skip the whole suite (rather
# than breaking `unittest discover`) in minimal environments without it.
try:
    import numpy as np
    import trimesh

    import routers.export as export_router

    HAVE_TRIMESH = True
except Exception:  # noqa: BLE001
    HAVE_TRIMESH = False


def _token(rel_path: str) -> str:
    return base64.urlsafe_b64encode(rel_path.encode("utf-8")).decode("ascii").rstrip("=")


def _load_stl(resp) -> "trimesh.Trimesh":
    return trimesh.load(io.BytesIO(resp.body), file_type="stl")


@unittest.skipUnless(HAVE_TRIMESH, "trimesh not installed")
class ExportForSlicerTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.workspace = Path(self._tmp.name).resolve()
        self._orig_workspace = export_router.WORKSPACE_DIR
        export_router.WORKSPACE_DIR = self.workspace
        # A box that is tallest along Y (glTF up-axis). Exported to GLB, it
        # reloads as a Scene so the flatten path is exercised too.
        box = trimesh.creation.box(extents=[10.0, 30.0, 10.0])
        self.rel = "Workflows/hero.glb"
        (self.workspace / "Workflows").mkdir(parents=True, exist_ok=True)
        box.export(str(self.workspace / self.rel))

    def tearDown(self) -> None:
        export_router.WORKSPACE_DIR = self._orig_workspace
        self._tmp.cleanup()

    def test_converts_glb_to_stl_with_download_filename(self) -> None:
        resp = export_router.export_for_slicer("stl", _token(self.rel), "model.stl")
        self.assertEqual(resp.media_type, "model/stl")
        self.assertIn('filename="model.stl"', resp.headers["content-disposition"])
        mesh = _load_stl(resp)
        self.assertGreater(len(mesh.faces), 0)

    def test_reorients_y_up_to_z_up(self) -> None:
        # The box is tallest in Y; after the Y->Z rotation it must be tallest in
        # Z so it imports standing upright on the slicer bed.
        resp = export_router.export_for_slicer("stl", _token(self.rel), "model.stl")
        ex = _load_stl(resp).extents
        self.assertEqual(int(np.argmax(ex)), 2, f"expected Z to be the tallest axis, got extents {ex}")

    def test_normalizes_longest_edge_to_default_print_size(self) -> None:
        resp = export_router.export_for_slicer("stl", _token(self.rel), "model.stl")
        longest = float(max(_load_stl(resp).extents))
        self.assertAlmostEqual(longest, export_router.DEFAULT_PRINT_LONGEST_MM, places=3)

    def test_rejects_unsupported_format(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            export_router.export_for_slicer("glb", _token(self.rel), "model.glb")
        self.assertEqual(ctx.exception.status_code, 400)

    def test_rejects_filename_extension_mismatch(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            export_router.export_for_slicer("stl", _token(self.rel), "model.obj")
        self.assertEqual(ctx.exception.status_code, 400)

    def test_rejects_malformed_token(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            export_router.export_for_slicer("stl", "!!!not-base64!!!", "model.stl")
        self.assertEqual(ctx.exception.status_code, 400)

    def test_rejects_path_traversal(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            export_router.export_for_slicer("stl", _token("../escape.glb"), "model.stl")
        self.assertEqual(ctx.exception.status_code, 400)

    def test_rejects_sibling_prefix_escape(self) -> None:
        # A sibling dir whose name starts with the workspace dir name must not be
        # reachable — the old str.startswith containment guard would allow it.
        sibling = self.workspace.parent / (self.workspace.name + "-secret")
        sibling.mkdir(parents=True, exist_ok=True)
        (sibling / "x.glb").write_bytes(b"nope")
        rel = f"../{self.workspace.name}-secret/x.glb"
        with self.assertRaises(HTTPException) as ctx:
            export_router.export_for_slicer("stl", _token(rel), "model.stl")
        self.assertEqual(ctx.exception.status_code, 400)

    def test_missing_file_is_404(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            export_router.export_for_slicer("stl", _token("Workflows/nope.glb"), "model.stl")
        self.assertEqual(ctx.exception.status_code, 404)


@unittest.skipUnless(HAVE_TRIMESH, "trimesh not installed")
class FlattenAndScaleHelperTests(unittest.TestCase):
    def test_flatten_bakes_scene_node_transforms(self) -> None:
        # Two boxes placed at different positions via scene-graph transforms.
        # util.concatenate(geometry.values()) would ignore the transforms; the
        # scene-level flatten must reflect them in the combined bounds.
        scene = trimesh.Scene()
        scene.add_geometry(trimesh.creation.box(extents=[2, 2, 2]), transform=trimesh.transformations.translation_matrix([0, 0, 0]))
        scene.add_geometry(trimesh.creation.box(extents=[2, 2, 2]), transform=trimesh.transformations.translation_matrix([100, 0, 0]))
        mesh = export_router._to_single_mesh(scene)
        self.assertIsInstance(mesh, trimesh.Trimesh)
        # Combined X extent spans both boxes: ~101 (from -1 to 101).
        self.assertGreater(mesh.extents[0], 100.0)

    def test_scale_to_print_size(self) -> None:
        mesh = trimesh.creation.box(extents=[1.0, 2.0, 4.0])
        export_router._scale_to_print_size(mesh, longest_mm=80.0)
        self.assertAlmostEqual(float(max(mesh.extents)), 80.0, places=3)

    def test_scale_ignores_degenerate_mesh(self) -> None:
        # A single point cloud has zero extent; scaling must not divide by zero.
        mesh = trimesh.Trimesh(vertices=[[0, 0, 0]], faces=[])
        export_router._scale_to_print_size(mesh)  # must not raise


if __name__ == "__main__":
    unittest.main()

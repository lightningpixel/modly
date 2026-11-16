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
    from services import imported_sources

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
        self._orig_workspace = export_router.registry.WORKSPACE_DIR
        export_router.registry.WORKSPACE_DIR = self.workspace
        # A box that is tallest along Y (glTF up-axis) and unit-sized, matching
        # what image-to-3D generators emit. Exported to GLB, it reloads as a
        # Scene so the flatten path is exercised too.
        box = trimesh.creation.box(extents=[0.3, 1.0, 0.3])
        self.rel = "Workflows/hero.glb"
        (self.workspace / "Workflows").mkdir(parents=True, exist_ok=True)
        box.export(str(self.workspace / self.rel))

    def tearDown(self) -> None:
        export_router.registry.WORKSPACE_DIR = self._orig_workspace
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

    def test_leaves_a_real_world_sized_mesh_alone(self) -> None:
        # A mesh that already carries a physical size is the user's own: silently
        # shrinking a 180 mm part to 50 mm would waste a print.
        big = trimesh.creation.box(extents=[40.0, 180.0, 40.0])
        rel = "Workflows/part.glb"
        big.export(str(self.workspace / rel))
        resp = export_router.export_for_slicer("stl", _token(rel), "model.stl")
        self.assertAlmostEqual(float(max(_load_stl(resp).extents)), 180.0, places=2)

    def test_does_not_rotate_a_z_up_stl_source(self) -> None:
        # STL is conventionally Z-up already; the glTF Y->Z rotation would lay an
        # upright model on its side.
        rel = "Workflows/upright.stl"
        trimesh.creation.box(extents=[10.0, 10.0, 30.0]).export(str(self.workspace / rel))
        resp = export_router.export_for_slicer("stl", _token(rel), "model.stl")
        ex = _load_stl(resp).extents
        self.assertEqual(int(np.argmax(ex)), 2, f"expected Z to stay the tallest axis, got extents {ex}")

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


@unittest.skipUnless(HAVE_TRIMESH, "trimesh not installed")
class ImportedSourceSlicerTests(unittest.TestCase):
    """Meshes imported from outside the workspace are sliceable — but only the
    exact files the user picked, and never with the wrong up-axis."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.outside = Path(self._tmp.name).resolve()
        self._orig_workspace = export_router.registry.WORKSPACE_DIR
        # A workspace elsewhere, so nothing here is reachable as a relative path.
        self._ws_tmp = tempfile.TemporaryDirectory()
        export_router.registry.WORKSPACE_DIR = Path(self._ws_tmp.name).resolve()
        imported_sources.clear()
        # Unit-sized and tallest along Y, as a glTF export would be.
        self.mesh_path = self.outside / "imported.glb"
        trimesh.creation.box(extents=[0.3, 1.0, 0.3]).export(str(self.mesh_path))

    def tearDown(self) -> None:
        export_router.registry.WORKSPACE_DIR = self._orig_workspace
        imported_sources.clear()
        self._tmp.cleanup()
        self._ws_tmp.cleanup()

    def test_rejects_an_absolute_path_that_was_never_imported(self) -> None:
        # The whole point of the registry: an absolute path alone buys nothing.
        with self.assertRaises(HTTPException) as ctx:
            export_router.export_for_slicer("stl", _token(str(self.mesh_path)), "model.stl")
        self.assertEqual(ctx.exception.status_code, 400)

    def test_serves_a_registered_import(self) -> None:
        imported_sources.register(self.mesh_path, self.mesh_path)
        resp = export_router.export_for_slicer("stl", _token(str(self.mesh_path)), "model.stl")
        self.assertEqual(resp.media_type, "model/stl")
        self.assertGreater(len(_load_stl(resp).faces), 0)

    def test_rotates_a_registered_gltf_import(self) -> None:
        imported_sources.register(self.mesh_path, self.mesh_path)
        resp = export_router.export_for_slicer("stl", _token(str(self.mesh_path)), "model.stl")
        ex = _load_stl(resp).extents
        self.assertEqual(int(np.argmax(ex)), 2, f"expected Z to be the tallest axis, got extents {ex}")

    def test_does_not_rotate_an_import_that_was_stl_before_conversion(self) -> None:
        # `import-by-path` converts STL/OBJ/PLY to GLB without touching the axes,
        # so the .glb container here still holds Z-up data. Rotating it would be
        # exactly the bug the rotation exists to prevent.
        imported_sources.register(self.mesh_path, self.outside / "original.stl")
        resp = export_router.export_for_slicer("stl", _token(str(self.mesh_path)), "model.stl")
        ex = _load_stl(resp).extents
        self.assertEqual(int(np.argmax(ex)), 1, f"expected Y to stay the tallest axis, got extents {ex}")

    def test_registered_but_deleted_file_is_404(self) -> None:
        imported_sources.register(self.mesh_path, self.mesh_path)
        self.mesh_path.unlink()
        with self.assertRaises(HTTPException) as ctx:
            export_router.export_for_slicer("stl", _token(str(self.mesh_path)), "model.stl")
        self.assertEqual(ctx.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()

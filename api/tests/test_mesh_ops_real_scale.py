import base64
import io
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
import trimesh

import routers.export as export_router
import routers.optimize as optimize_router
from services.mesh_ops import MeshOp, MeshOpContext, MeshOpResult, MeshOpsRegistry, mesh_ops_registry
from services.mesh_ops import real_scale
from services.mesh_ops.real_scale import (
    is_calibrated,
    read_real_scale,
    write_real_scale,
)


def _extents(path: Path) -> np.ndarray:
    return trimesh.load(str(path), force="mesh").extents


def _stl_extents(body: bytes) -> np.ndarray:
    return trimesh.load(io.BytesIO(body), file_type="stl").extents


class SetRealScaleTests(unittest.TestCase):
    def setUp(self) -> None:
        self._directory = tempfile.TemporaryDirectory()
        self.workspace = Path(self._directory.name)
        self.context = MeshOpContext(workspace_dir=self.workspace, temp_dir=self.workspace)
        self.mesh = self.workspace / "mesh.glb"
        # Generator output: about one unit, no real size.
        trimesh.creation.box(extents=[2.0, 1.0, 0.5]).export(str(self.mesh))

    def tearDown(self) -> None:
        self._directory.cleanup()

    def _set(self, path: Path, **params) -> MeshOpResult:
        output = self.workspace / "out" / f"{len(list(self.workspace.rglob('*')))}.glb"
        context = MeshOpContext(self.workspace, self.workspace, output_path=output)
        return mesh_ops_registry.run("set_real_scale", path, params, context)

    def test_a_generated_mesh_is_not_calibrated(self) -> None:
        self.assertIsNone(read_real_scale(self.mesh))

    def test_declaring_a_size_rescales_the_mesh_in_metres_and_marks_it(self) -> None:
        result = self._set(self.mesh, size=30, unit="cm")

        np.testing.assert_allclose(_extents(result.file_path), [0.3, 0.15, 0.075], atol=1e-6)
        self.assertEqual(read_real_scale(result.file_path), {"unit": "m"})
        np.testing.assert_allclose(result.details["dimensions_mm"], [300, 150, 75], atol=1e-3)
        self.assertEqual(
            result.details["steps"][0]["summary"],
            "Declared the longest side as 30 cm: the mesh is now at real size.",
        )
        # The input is left as it was.
        self.assertFalse(is_calibrated(self.mesh))

    def test_a_dimension_other_than_the_longest_can_be_declared(self) -> None:
        result = self._set(self.mesh, size=50, unit="mm", dimension="y")

        np.testing.assert_allclose(_extents(result.file_path), [0.1, 0.05, 0.025], atol=1e-6)

    def test_the_declaration_survives_later_ops(self) -> None:
        calibrated = self._set(self.mesh, size=30, unit="cm").file_path

        # An op that rebuilds the file and loses its extras, like a repair.
        def rebuild(input_path, params, context):
            output = self.workspace / "rebuilt.glb"
            trimesh.load(str(input_path), force="mesh").export(str(output))
            return MeshOpResult(output)

        registry = MeshOpsRegistry([MeshOp("rebuild", "Rebuild", (), rebuild, "repair")])
        rebuilt = registry.run("rebuild", calibrated, {}, self.context).file_path
        self.assertTrue(is_calibrated(rebuilt))

        # ...but an uncalibrated input never comes out calibrated.
        rebuilt = registry.run("rebuild", self.mesh, {}, self.context).file_path
        self.assertFalse(is_calibrated(rebuilt))

    def test_rescaling_a_calibrated_mesh_keeps_it_calibrated(self) -> None:
        calibrated = self._set(self.mesh, size=30, unit="cm").file_path
        output = self.workspace / "scaled.glb"
        context = MeshOpContext(self.workspace, self.workspace, output_path=output)

        mesh_ops_registry.run("normalize_scale", calibrated, {"size": 12, "unit": "cm"}, context)

        self.assertTrue(is_calibrated(output))
        self.assertAlmostEqual(float(max(_extents(output))), 0.12, places=6)

    def test_writing_the_declaration_keeps_the_rest_of_the_file(self) -> None:
        scene = trimesh.Scene(trimesh.creation.box(extents=[1.0, 2.0, 3.0]))
        scene.metadata["author"] = "someone"
        path = self.workspace / "extras.glb"
        scene.export(str(path))

        write_real_scale(path)

        reloaded = trimesh.load(str(path))
        self.assertEqual(reloaded.metadata["author"], "someone")
        self.assertEqual(reloaded.metadata["modly"], {"real_scale": {"unit": "m"}})
        np.testing.assert_allclose(_extents(path), [1.0, 2.0, 3.0], atol=1e-6)

    def test_files_that_are_not_glb_are_never_calibrated(self) -> None:
        stl = self.workspace / "mesh.stl"
        trimesh.creation.box().export(str(stl))
        junk = self.workspace / "junk.glb"
        junk.write_bytes(b"not a glb")

        self.assertIsNone(read_real_scale(stl))
        self.assertIsNone(read_real_scale(junk))
        self.assertIsNone(read_real_scale(self.workspace / "missing.glb"))

    def test_reading_the_declaration_stops_after_the_json_chunk(self) -> None:
        path = self.workspace / "real.glb"
        trimesh.creation.box().export(str(path))
        write_real_scale(path)
        data = path.read_bytes()
        json_length = int.from_bytes(data[12:16], "little")
        # Keep the header and JSON chunk only: the binary data is never needed.
        path.write_bytes(data[:20 + json_length])

        self.assertEqual(read_real_scale(path), {"unit": "m"})

    def test_carrying_never_reads_the_output_of_an_uncalibrated_input(self) -> None:
        output = self.workspace / "out.glb"
        trimesh.creation.box().export(str(output))

        with mock.patch.object(real_scale, "read_real_scale", wraps=real_scale.read_real_scale) as read:
            real_scale.carry_real_scale(self.mesh, output)

        self.assertEqual([call.args[0] for call in read.call_args_list], [self.mesh])

    def test_the_op_is_offered_in_the_registry(self) -> None:
        described = {op["id"]: op for op in mesh_ops_registry.describe()}["set_real_scale"]

        self.assertEqual(described["category"], "transform")
        self.assertEqual(
            [schema["id"] for schema in described["params_schema"]],
            ["size", "unit", "dimension"],
        )
        with self.assertRaises(ValueError):
            mesh_ops_registry.resolve_params("set_real_scale", {"unit": "inch"})


class RealScaleExportTests(unittest.TestCase):
    def setUp(self) -> None:
        self._directory = tempfile.TemporaryDirectory()
        self.workspace = Path(self._directory.name).resolve()
        self._original = export_router.registry.WORKSPACE_DIR
        export_router.registry.WORKSPACE_DIR = self.workspace
        # 0.3 m tall: a calibrated 30 cm figurine, or 0.3 arbitrary units.
        trimesh.creation.box(extents=[0.1, 0.3, 0.2]).export(str(self.workspace / "raw.glb"))
        trimesh.creation.box(extents=[0.1, 0.3, 0.2]).export(str(self.workspace / "real.glb"))
        write_real_scale(self.workspace / "real.glb")

    def tearDown(self) -> None:
        export_router.registry.WORKSPACE_DIR = self._original
        self._directory.cleanup()

    def test_a_calibrated_stl_export_is_in_millimetres(self) -> None:
        body = export_router.export_mesh("stl", "real.glb").body
        np.testing.assert_allclose(_stl_extents(body), [100, 300, 200], atol=1e-3)

        body = optimize_router.export_mesh(path="real.glb", format="stl").body
        np.testing.assert_allclose(_stl_extents(body), [100, 300, 200], atol=1e-3)

    def test_an_uncalibrated_export_keeps_its_units(self) -> None:
        body = export_router.export_mesh("stl", "raw.glb").body
        np.testing.assert_allclose(_stl_extents(body), [0.1, 0.3, 0.2], atol=1e-6)

    def test_the_slicer_gets_the_real_size_instead_of_the_default(self) -> None:
        token = base64.urlsafe_b64encode(b"real.glb").decode("ascii").rstrip("=")

        body = export_router.export_for_slicer("stl", token, "model.stl").body

        # Y-up to Z-up, in millimetres, not resized to the 50 mm default.
        np.testing.assert_allclose(_stl_extents(body), [100, 200, 300], atol=1e-3)


def _stored_extents(path: Path) -> np.ndarray:
    """Extents of the vertices as stored, ignoring any node transform."""
    loaded = trimesh.load(str(path))
    geometries = loaded.geometry.values() if isinstance(loaded, trimesh.Scene) else [loaded]
    return np.ptp(np.vstack([g.vertices for g in geometries]), axis=0)


class RealScaleEndToEndTests(unittest.TestCase):
    """set_real_scale, then the ops and exports a user runs next, on real files."""

    def setUp(self) -> None:
        self._directory = tempfile.TemporaryDirectory()
        self.workspace = Path(self._directory.name).resolve()
        self._original = export_router.registry.WORKSPACE_DIR
        export_router.registry.WORKSPACE_DIR = self.workspace
        # Generator output: 2 × 1 × 0.5 units, no real size.
        trimesh.creation.box(extents=[2.0, 1.0, 0.5]).export(str(self.workspace / "raw.glb"))

    def tearDown(self) -> None:
        export_router.registry.WORKSPACE_DIR = self._original
        self._directory.cleanup()

    def _run(self, op_id: str, input_name: str, output_name: str, **params) -> Path:
        output = self.workspace / output_name
        context = MeshOpContext(self.workspace, self.workspace, output_path=output)
        result = mesh_ops_registry.run(op_id, self.workspace / input_name, params, context)
        return result.file_path

    def _slicer_extents(self, name: str) -> np.ndarray:
        token = base64.urlsafe_b64encode(name.encode()).decode("ascii").rstrip("=")
        return _stl_extents(export_router.export_for_slicer("stl", token, "model.stl").body)

    def test_the_declared_size_is_baked_into_the_vertices(self) -> None:
        self._run("set_real_scale", "raw.glb", "real.glb", size=30, unit="cm")

        np.testing.assert_allclose(_stored_extents(self.workspace / "real.glb"), [0.3, 0.15, 0.075], atol=1e-6)

    def test_an_stl_export_after_set_real_scale_measures_the_declared_size(self) -> None:
        self._run("set_real_scale", "raw.glb", "real.glb", size=30, unit="cm")

        body = export_router.export_mesh("stl", "real.glb").body
        np.testing.assert_allclose(_stl_extents(body), [300, 150, 75], atol=1e-3)
        body = optimize_router.export_mesh(path="real.glb", format="stl").body
        np.testing.assert_allclose(_stl_extents(body), [300, 150, 75], atol=1e-3)
        # Y-up to Z-up for the slicer.
        np.testing.assert_allclose(self._slicer_extents("real.glb"), [300, 75, 150], atol=1e-3)

    def test_repair_and_smooth_keep_the_declared_size(self) -> None:
        # A sphere: smoothing a box would round its corners off.
        trimesh.creation.icosphere(subdivisions=3).export(str(self.workspace / "sphere.glb"))
        self._run("set_real_scale", "sphere.glb", "real.glb", size=30, unit="cm")

        for op_id in ("repair", "smooth"):
            with self.subTest(op=op_id):
                self._run(op_id, "real.glb", f"{op_id}.glb")
                self.assertTrue(is_calibrated(self.workspace / f"{op_id}.glb"))
                body = export_router.export_mesh("stl", f"{op_id}.glb").body
                self.assertAlmostEqual(float(max(_stl_extents(body))), 300.0, delta=10.0)

    def test_ops_read_node_transforms_of_any_glb(self) -> None:
        # A GLB from elsewhere whose size lives in a node matrix.
        scene = trimesh.Scene()
        scene.add_geometry(trimesh.creation.box(extents=[2.0, 1.0, 0.5]), transform=np.diag([0.1, 0.1, 0.1, 1.0]))
        scene.export(str(self.workspace / "nodes.glb"))

        self._run("repair", "nodes.glb", "nodes-repaired.glb")

        np.testing.assert_allclose(_stored_extents(self.workspace / "nodes-repaired.glb"), [0.2, 0.1, 0.05], atol=1e-6)
        body = export_router.export_mesh("stl", "nodes.glb").body
        np.testing.assert_allclose(_stl_extents(body), [0.2, 0.1, 0.05], atol=1e-6)

    def test_normalize_scale_declares_a_real_size(self) -> None:
        self._run("normalize_scale", "raw.glb", "scaled.glb", size=12, unit="cm")

        self.assertTrue(is_calibrated(self.workspace / "scaled.glb"))
        self.assertAlmostEqual(float(max(self._slicer_extents("scaled.glb"))), 120.0, places=3)

    def test_prepare_for_printing_reaches_the_slicer_at_the_requested_size(self) -> None:
        self._run("prepare_for_printing", "raw.glb", "print.glb", size_mm=100)

        self.assertTrue(is_calibrated(self.workspace / "print.glb"))
        self.assertAlmostEqual(float(max(self._slicer_extents("print.glb"))), 100.0, places=3)


if __name__ == "__main__":
    unittest.main()

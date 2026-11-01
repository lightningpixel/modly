import hashlib
import importlib.util
import tempfile
import unittest
from pathlib import Path

import numpy as np
import trimesh

from services.mesh_ops import MeshOpContext, MeshOpExecutionError, mesh_ops_registry
from services.mesh_ops.inspection import (
    DECIMATE_TARGET_FACES,
    HIGH_FACE_COUNT,
    fixes_for_report,
)


HAS_PYMESHLAB = importlib.util.find_spec("pymeshlab") is not None


def _box(offset=(0.0, 0.0, 0.0)) -> trimesh.Trimesh:
    mesh = trimesh.creation.box()
    mesh.apply_translation(offset)
    return mesh


class InspectMeshTests(unittest.TestCase):
    def setUp(self) -> None:
        self._directory = tempfile.TemporaryDirectory()
        self.workspace = Path(self._directory.name)
        self.context = MeshOpContext(
            workspace_dir=self.workspace,
            temp_dir=self.workspace,
        )

    def tearDown(self) -> None:
        self._directory.cleanup()

    def _export(self, geometry, name="mesh.glb", **kwargs) -> Path:
        path = self.workspace / name
        geometry.export(str(path), **kwargs)
        return path

    def _inspect(self, path: Path, **params) -> dict:
        result = mesh_ops_registry.run("inspect_mesh", path, params, self.context)
        self.assertIsNone(result.file_path)
        return dict(result.details)

    def test_closed_box_is_printable(self) -> None:
        path = self._export(_box(), include_normals=True)

        report = self._inspect(path)

        self.assertTrue(report["is_watertight"])
        self.assertTrue(report["is_winding_consistent"])
        self.assertTrue(report["is_manifold"])
        self.assertEqual(report["face_count"], 12)
        self.assertEqual(report["component_count"], 1)
        self.assertEqual(report["hole_count"], 0)
        self.assertAlmostEqual(report["volume"], 1.0, places=6)
        self.assertAlmostEqual(report["surface_area"], 6.0, places=6)
        np.testing.assert_allclose(report["dimensions"], [1.0, 1.0, 1.0])
        self.assertTrue(report["has_normals"])
        self.assertFalse(report["has_uvs"])
        if HAS_PYMESHLAB:
            self.assertEqual(report["self_intersecting_face_count"], 0)
            self.assertTrue(report["printable"])
            self.assertEqual(report["issues"], [])

    def test_open_box_reports_its_hole_and_no_volume(self) -> None:
        mesh = _box()
        mesh.update_faces(np.arange(1, len(mesh.faces)))
        path = self._export(mesh)

        report = self._inspect(path, check_self_intersections=False)

        self.assertFalse(report["is_watertight"])
        self.assertFalse(report["printable"])
        self.assertEqual(report["hole_count"], 1)
        self.assertEqual(report["boundary_edge_count"], 3)
        self.assertEqual(report["largest_hole_edges"], 3)
        self.assertIsNone(report["volume"])
        self.assertIsNone(report["self_intersecting_face_count"])
        self.assertTrue(any("hole" in issue for issue in report["issues"]))
        self.assertFalse(report["has_normals"])

    def test_unchecked_self_intersections_leave_printability_unknown(self) -> None:
        path = self._export(_box())

        report = self._inspect(path, check_self_intersections=False)

        self.assertTrue(report["is_watertight"])
        self.assertIsNone(report["printable"])
        self.assertIn("self-intersections were not checked", report["issues"])

    def test_normals_are_read_from_the_file_format(self) -> None:
        cases = {
            "normals.obj": (dict(include_normals=True), True),
            "plain.obj": (dict(include_normals=False), False),
            "normals.ply": (dict(vertex_normal=True), True),
            "mesh.stl": ({}, False),
        }
        for name, (kwargs, expected) in cases.items():
            with self.subTest(name=name):
                path = self._export(_box(), name=name, **kwargs)
                report = self._inspect(path, check_self_intersections=False)
                self.assertIs(report["has_normals"], expected)

    def test_uv_seams_do_not_count_as_holes(self) -> None:
        mesh = _box()
        mesh.unmerge_vertices()
        uv = np.random.default_rng(0).random((len(mesh.vertices), 2))
        mesh.visual = trimesh.visual.TextureVisuals(uv=uv)
        path = self._export(mesh)

        report = self._inspect(path, check_self_intersections=False)

        self.assertTrue(report["has_uvs"])
        self.assertEqual(report["vertex_count"], 36)
        self.assertTrue(report["is_watertight"])
        self.assertEqual(report["hole_count"], 0)

    def test_scene_parts_are_counted_in_world_space(self) -> None:
        scene = trimesh.Scene()
        scene.add_geometry(_box(), node_name="a")
        scene.add_geometry(
            _box(),
            node_name="b",
            transform=trimesh.transformations.translation_matrix([3.0, 0.0, 0.0]),
        )
        path = self._export(scene)

        report = self._inspect(path, check_self_intersections=False)

        self.assertEqual(report["component_count"], 2)
        self.assertEqual(report["face_count"], 24)
        np.testing.assert_allclose(report["dimensions"], [4.0, 1.0, 1.0])
        self.assertAlmostEqual(report["volume"], 2.0, places=6)

    @unittest.skipUnless(HAS_PYMESHLAB, "pymeshlab is not installed")
    def test_overlapping_parts_are_self_intersecting(self) -> None:
        mesh = trimesh.util.concatenate([_box(), _box((0.5, 0.3, 0.2))])
        path = self._export(mesh)

        report = self._inspect(path)

        self.assertGreater(report["self_intersecting_face_count"], 0)
        self.assertFalse(report["printable"])

    def test_inspection_never_modifies_the_input(self) -> None:
        mesh = _box()
        mesh.update_faces(np.arange(1, len(mesh.faces)))
        path = self._export(mesh)
        before = hashlib.sha256(path.read_bytes()).hexdigest()
        mtime = path.stat().st_mtime_ns

        self._inspect(path)
        mesh_ops_registry.run("suggest_fixes", path, {}, self.context)

        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), before)
        self.assertEqual(path.stat().st_mtime_ns, mtime)
        self.assertEqual([p.name for p in self.workspace.iterdir()], ["mesh.glb"])

    def test_file_without_triangles_is_rejected(self) -> None:
        path = self._export(trimesh.PointCloud(np.zeros((3, 3))), name="cloud.ply")

        with self.assertRaises(MeshOpExecutionError):
            self._inspect(path)

    def test_suggest_fixes_proposes_a_repair_for_holes(self) -> None:
        mesh = _box()
        mesh.update_faces(np.arange(1, len(mesh.faces)))
        path = self._export(mesh)

        result = mesh_ops_registry.run(
            "suggest_fixes",
            path,
            {"check_self_intersections": False},
            self.context,
        )

        self.assertIsNone(result.file_path)
        self.assertEqual(result.details["report"]["hole_count"], 1)
        fixes = result.details["fixes"]
        self.assertEqual([fix["op"] for fix in fixes], ["repair_mesh"])
        self.assertIn("fill 1 hole(s)", fixes[0]["reason"])

    def test_inside_out_mesh_is_reported(self) -> None:
        mesh = _box()
        mesh.invert()
        path = self._export(mesh)

        report = self._inspect(path, check_self_intersections=False)

        self.assertTrue(report["is_watertight"])
        self.assertTrue(report["is_inside_out"])
        self.assertFalse(report["printable"])
        self.assertIn("inside-out (every normal points inwards)", report["issues"])


class FixesForReportTests(unittest.TestCase):
    CLEAN = {
        "face_count": 12,
        "component_count": 1,
        "is_winding_consistent": True,
        "is_inside_out": False,
        "hole_count": 0,
        "largest_hole_edges": 0,
        "non_manifold_edge_count": 0,
        "degenerate_face_count": 0,
        "self_intersecting_face_count": 0,
    }

    def test_clean_mesh_needs_nothing(self) -> None:
        self.assertEqual(fixes_for_report(self.CLEAN), ([], []))

    def test_suggested_params_are_valid_for_the_registry(self) -> None:
        report = {
            **self.CLEAN,
            "face_count": HIGH_FACE_COUNT + 1,
            "hole_count": 2,
            "largest_hole_edges": 50_000,
            "non_manifold_edge_count": 4,
            "degenerate_face_count": 1,
        }

        fixes, notes = fixes_for_report(report)

        self.assertEqual([fix["op"] for fix in fixes], ["repair_mesh", "decimate"])
        self.assertEqual(fixes[1]["params"], {"target_faces": DECIMATE_TARGET_FACES})
        self.assertEqual(notes, [])
        for fix in fixes:
            declared = {
                schema["id"] for schema in mesh_ops_registry.get(fix["op"]).params_schema
            }
            self.assertLessEqual(set(fix["params"]), declared)

    def test_flipped_or_inside_out_faces_call_for_a_repair(self) -> None:
        for flaw in ({"is_winding_consistent": False}, {"is_inside_out": True}):
            with self.subTest(flaw=flaw):
                fixes, _ = fixes_for_report({**self.CLEAN, **flaw})
                self.assertEqual([fix["op"] for fix in fixes], ["repair_mesh"])
                self.assertIn("re-orient", fixes[0]["reason"])

    def test_problems_without_an_op_become_notes(self) -> None:
        report = {
            **self.CLEAN,
            "self_intersecting_face_count": 7,
            "component_count": 3,
        }

        fixes, notes = fixes_for_report(report)

        self.assertEqual(fixes, [])
        self.assertEqual(len(notes), 2)


class InspectionRegistryTests(unittest.TestCase):
    def test_analysis_ops_are_registered_as_read_only(self) -> None:
        described = {op["id"]: op for op in mesh_ops_registry.describe()}

        for op_id in ("inspect_mesh", "suggest_fixes"):
            self.assertEqual(described[op_id]["category"], "analysis")
            self.assertFalse(described[op_id]["destructive"])


if __name__ == "__main__":
    unittest.main()

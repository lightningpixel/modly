import hashlib
import importlib.util
import tempfile
import unittest
from pathlib import Path

import numpy as np
import trimesh

from services.mesh_ops import MeshOpContext, MeshOpExecutionError, mesh_ops_registry


HAS_PYMESHLAB = importlib.util.find_spec("pymeshlab") is not None


def _holed_sphere_with_fin() -> trimesh.Trimesh:
    """A sphere missing a patch of faces, with a fin making one edge non-manifold."""
    sphere = trimesh.creation.icosphere(subdivisions=3)
    sphere.update_faces(np.arange(20, len(sphere.faces)))
    edge = sphere.edges_unique[100]
    return trimesh.Trimesh(
        vertices=np.vstack([sphere.vertices, [[0.0, 2.0, 0.0]]]),
        faces=np.vstack([sphere.faces, [[edge[0], edge[1], len(sphere.vertices)]]]),
        process=False,
    )


def _half_open_sphere() -> trimesh.Trimesh:
    sphere = trimesh.creation.icosphere(subdivisions=4)
    sphere.update_faces(sphere.triangles_center[:, 1] > -0.5)
    return sphere


@unittest.skipUnless(HAS_PYMESHLAB, "pymeshlab is not installed")
class RepairMeshTests(unittest.TestCase):
    def setUp(self) -> None:
        self._directory = tempfile.TemporaryDirectory()
        self.workspace = Path(self._directory.name)
        self.context = MeshOpContext(
            workspace_dir=self.workspace,
            temp_dir=self.workspace,
        )

    def tearDown(self) -> None:
        self._directory.cleanup()

    def _export(self, geometry, name="mesh.glb") -> Path:
        path = self.workspace / name
        geometry.export(str(path))
        return path

    def _repair(self, geometry, **params):
        return mesh_ops_registry.run(
            "repair_mesh", self._export(geometry), params, self.context
        )

    def _assert_closed_and_manifold(self, path: Path) -> dict:
        # Judged by the same diagnostic the user and the agent see.
        report = mesh_ops_registry.run(
            "inspect_mesh", path, {"check_self_intersections": False}, self.context
        ).details
        self.assertTrue(report["is_watertight"], report["issues"])
        self.assertTrue(report["is_manifold"], report["issues"])
        self.assertTrue(report["is_winding_consistent"], report["issues"])
        self.assertFalse(report["is_inside_out"], report["issues"])
        return report

    def test_holed_non_manifold_mesh_becomes_watertight_and_manifold(self) -> None:
        result = self._repair(_holed_sphere_with_fin())

        details = result.details
        self.assertTrue(details["repaired"])
        self.assertFalse(details["before"]["is_watertight"])
        self.assertFalse(details["before"]["is_manifold"])
        self.assertIn("fix_non_manifold", details["steps"])
        self.assertIn("fill_holes", details["steps"])
        self.assertLessEqual(details["passes"], 3)
        self.assertTrue(details["after"]["is_watertight"])
        self._assert_closed_and_manifold(result.file_path)

    def test_large_hole_is_closed_without_a_size_limit(self) -> None:
        result = self._repair(_half_open_sphere())

        self.assertEqual(result.details["steps"], ["fill_holes"])
        self.assertEqual(result.details["remaining_issues"], [])
        self._assert_closed_and_manifold(result.file_path)

    def test_flipped_faces_are_reoriented(self) -> None:
        sphere = trimesh.creation.icosphere(subdivisions=3)
        faces = sphere.faces.copy()
        faces[:50] = faces[:50, ::-1]

        result = self._repair(trimesh.Trimesh(sphere.vertices, faces, process=False))

        self.assertIn("reorient_faces", result.details["steps"])
        report = self._assert_closed_and_manifold(result.file_path)
        self.assertGreater(report["volume"], 0)

    def test_inside_out_mesh_is_turned_the_right_way(self) -> None:
        sphere = trimesh.creation.icosphere(subdivisions=3)
        sphere.invert()

        result = self._repair(sphere)

        self.assertTrue(result.details["before"]["is_inside_out"])
        self.assertEqual(result.details["steps"], ["flip_normals"])
        self._assert_closed_and_manifold(result.file_path)

    def test_sound_mesh_is_left_alone(self) -> None:
        result = self._repair(trimesh.creation.box())

        self.assertIsNone(result.file_path)
        self.assertFalse(result.details["repaired"])
        self.assertEqual(result.details["remaining_issues"], [])
        self.assertEqual(sorted(p.name for p in self.workspace.iterdir()), ["mesh.glb"])

    def test_holes_are_kept_when_filling_is_off(self) -> None:
        result = self._repair(_half_open_sphere(), fill_holes=False)

        self.assertFalse(result.details["repaired"])
        self.assertTrue(
            any("hole" in issue for issue in result.details["remaining_issues"])
        )

    def test_without_hole_filling_no_face_is_removed(self) -> None:
        # Fixing the fin would delete faces and open a hole that may not be
        # filled, so the mesh is left as it is and the issues reported.
        result = self._repair(_holed_sphere_with_fin(), fill_holes=False)

        self.assertFalse(result.details["repaired"])
        self.assertIsNone(result.file_path)
        remaining = result.details["remaining_issues"]
        self.assertTrue(any("non-manifold" in issue for issue in remaining))
        self.assertTrue(any("hole" in issue for issue in remaining))

    def test_without_hole_filling_flipped_faces_are_still_fixed(self) -> None:
        mesh = _half_open_sphere()
        faces = mesh.faces.copy()
        faces[:40] = faces[:40, ::-1]

        result = self._repair(
            trimesh.Trimesh(mesh.vertices, faces, process=False), fill_holes=False
        )

        self.assertEqual(result.details["steps"], ["reorient_faces"])
        self.assertTrue(result.details["after"]["is_winding_consistent"])
        self.assertEqual(result.details["face_count"], len(faces))
        self.assertEqual(result.details["after"]["hole_count"], 1)

    def test_textured_input_reports_that_textures_are_dropped(self) -> None:
        mesh = _half_open_sphere()
        mesh.unmerge_vertices()
        uv = np.random.default_rng(0).random((len(mesh.vertices), 2))
        mesh.visual = trimesh.visual.TextureVisuals(uv=uv)

        result = self._repair(mesh)

        # UV seams were merged, so only the real hole was filled.
        self.assertEqual(result.details["before"]["hole_count"], 1)
        self.assertTrue(result.details["textures_dropped"])
        self._assert_closed_and_manifold(result.file_path)

    def test_input_file_is_left_untouched(self) -> None:
        path = self._export(_holed_sphere_with_fin())
        before = hashlib.sha256(path.read_bytes()).hexdigest()

        result = mesh_ops_registry.run("repair_mesh", path, {}, self.context)

        self.assertNotEqual(result.file_path, path)
        self.assertEqual(result.file_path.parent, self.workspace / "Workflows")
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), before)

    def test_file_without_triangles_is_rejected(self) -> None:
        path = self._export(trimesh.PointCloud(np.zeros((3, 3))), name="cloud.ply")

        with self.assertRaises(MeshOpExecutionError):
            mesh_ops_registry.run("repair_mesh", path, {}, self.context)


if __name__ == "__main__":
    unittest.main()

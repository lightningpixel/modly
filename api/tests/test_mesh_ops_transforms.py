import hashlib
import tempfile
import unittest
from pathlib import Path

import numpy as np
import trimesh

from services.mesh_ops import MeshOpContext, mesh_ops_registry
from services.mesh_ops.transforms import apply_transforms


def _tilted_plate() -> trimesh.Trimesh:
    """A 2 × 0.2 × 1 plate, tilted 30° about Z and moved off the origin."""
    plate = trimesh.creation.box(extents=[2.0, 0.2, 1.0])
    plate.apply_transform(
        trimesh.transformations.rotation_matrix(np.radians(30), [0, 0, 1])
    )
    plate.apply_translation([3.0, 4.0, 5.0])
    return plate


def _world_bounds(path: Path) -> np.ndarray:
    return trimesh.load(str(path)).bounds


class ApplyTransformsTests(unittest.TestCase):
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

    def _apply(self, path: Path, *step_ids: str, **params) -> tuple[Path, dict]:
        steps = [
            (step_id, mesh_ops_registry.resolve_params(step_id, params.get(step_id)))
            for step_id in step_ids
        ]
        output = self.workspace / "out" / f"{len(list(self.workspace.rglob('*')))}.glb"
        result = apply_transforms(path, steps, output, self.context)
        self.assertEqual(result.file_path, output)
        return output, dict(result.details)

    def test_ground_center_and_lay_flat_in_one_pass_whatever_the_order(self) -> None:
        path = self._export(_tilted_plate())

        output, details = self._apply(path, "drop_to_ground", "recenter", "auto_orient")

        self.assertEqual(details["applied"], ["auto_orient", "recenter", "drop_to_ground"])
        bounds = _world_bounds(output)
        # Laid flat: the 0.2 thickness is now the height, and the long side
        # keeps its heading (no spin about the vertical axis).
        np.testing.assert_allclose(bounds[1] - bounds[0], [2.0, 0.2, 1.0], atol=1e-5)
        self.assertAlmostEqual(bounds[0][1], 0.0, places=5)
        np.testing.assert_allclose((bounds[0] + bounds[1])[[0, 2]] / 2, [0, 0], atol=1e-5)
        np.testing.assert_allclose(details["dimensions"], [2.0, 0.2, 1.0], atol=1e-5)

    def test_recenter_moves_the_centroid_to_the_origin(self) -> None:
        path = self._export(_tilted_plate())

        output, _ = self._apply(path, "recenter")

        centroid = trimesh.load(str(output), force="mesh").centroid
        np.testing.assert_allclose(centroid, [0, 0, 0], atol=1e-5)

    def test_drop_to_ground_only_moves_vertically(self) -> None:
        path = self._export(_tilted_plate())
        before = _world_bounds(path)

        output, _ = self._apply(path, "drop_to_ground")

        after = _world_bounds(output)
        self.assertAlmostEqual(after[0][1], 0.0, places=5)
        np.testing.assert_allclose(after[:, [0, 2]], before[:, [0, 2]], atol=1e-5)

    def test_auto_orient_leaves_a_mesh_without_a_flat_side_alone(self) -> None:
        cube = trimesh.creation.box()
        cube.apply_transform(
            trimesh.transformations.rotation_matrix(np.radians(20), [1, 1, 0])
        )
        path = self._export(cube)

        output, _ = self._apply(path, "auto_orient")

        np.testing.assert_allclose(_world_bounds(output), _world_bounds(path), atol=1e-5)

    def test_auto_orient_does_not_flip_a_mesh_over(self) -> None:
        # A shallow bowl (open hemisphere-like dish) opening upwards.
        bowl = trimesh.creation.icosphere(subdivisions=3)
        bowl.update_faces(bowl.triangles_center[:, 1] < -0.3)
        # update_faces keeps the cut-away vertices, which would still be
        # exported and measured below as the top of a whole sphere.
        bowl.remove_unreferenced_vertices()
        bowl.apply_scale([1.0, 0.3, 1.0])
        bowl.apply_transform(
            trimesh.transformations.rotation_matrix(np.radians(10), [1, 0, 0])
        )
        path = self._export(bowl)

        output, _ = self._apply(path, "auto_orient")

        mesh = trimesh.load(str(output), force="mesh")
        # Still opening upwards: the rim is above the bottom of the dish.
        rim_height = mesh.vertices[:, 1].max()
        lowest = mesh.vertices[:, 1].min()
        center_height = mesh.vertices[np.argmin(np.linalg.norm(mesh.vertices[:, [0, 2]], axis=1)), 1]
        self.assertLess(center_height - lowest, rim_height - center_height)

    def test_normalize_scale_to_real_units(self) -> None:
        path = self._export(_tilted_plate())

        _, longest = self._apply(path, "normalize_scale", normalize_scale={"size": 20, "unit": "cm"})
        _, height = self._apply(
            path,
            "normalize_scale",
            normalize_scale={"size": 5, "unit": "mm", "dimension": "y"},
        )

        self.assertAlmostEqual(max(longest["dimensions"]), 0.2, places=5)
        self.assertAlmostEqual(height["dimensions"][1], 0.005, places=6)

    def test_scaling_keeps_a_grounded_mesh_on_the_ground(self) -> None:
        path = self._export(_tilted_plate())

        output, details = self._apply(
            path,
            "drop_to_ground",
            "normalize_scale",
            normalize_scale={"size": 3},
        )

        self.assertEqual(details["applied"], ["normalize_scale", "drop_to_ground"])
        self.assertAlmostEqual(_world_bounds(output)[0][1], 0.0, places=5)
        self.assertAlmostEqual(max(details["dimensions"]), 3.0, places=4)

    def test_scene_node_transforms_are_measured_in_world_space(self) -> None:
        scene = trimesh.Scene()
        scene.add_geometry(
            trimesh.creation.box(),
            node_name="raised",
            transform=trimesh.transformations.translation_matrix([0.0, 7.0, 0.0]),
        )
        path = self._export(scene)

        output, _ = self._apply(path, "drop_to_ground")

        self.assertAlmostEqual(_world_bounds(output)[0][1], 0.0, places=5)

    def test_textures_survive_the_transform(self) -> None:
        mesh = trimesh.creation.box()
        mesh.unmerge_vertices()
        uv = np.random.default_rng(0).random((len(mesh.vertices), 2))
        mesh.visual = trimesh.visual.TextureVisuals(uv=uv)
        path = self._export(mesh)

        output, _ = self._apply(path, "drop_to_ground")

        geometry = next(iter(trimesh.load(str(output)).geometry.values()))
        self.assertIsInstance(geometry.visual, trimesh.visual.TextureVisuals)
        self.assertEqual(len(geometry.visual.uv), len(uv))

    def test_input_file_is_left_untouched(self) -> None:
        path = self._export(_tilted_plate())
        before = hashlib.sha256(path.read_bytes()).hexdigest()

        output, _ = self._apply(path, "auto_orient", "recenter", "drop_to_ground")

        self.assertNotEqual(output, path)
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), before)

    def test_invalid_steps_are_rejected(self) -> None:
        path = self._export(_tilted_plate())
        output = self.workspace / "never.glb"

        with self.assertRaises(ValueError):
            apply_transforms(path, [], output, self.context)
        with self.assertRaises(ValueError):
            apply_transforms(path, [("repair", {})], output, self.context)
        with self.assertRaises(ValueError):
            mesh_ops_registry.resolve_params("normalize_scale", {"unit": "inch"})
        self.assertFalse(output.exists())

    def test_registry_ops_write_a_new_file(self) -> None:
        path = self._export(_tilted_plate())

        result = mesh_ops_registry.run("drop_to_ground", path, {}, self.context)

        self.assertTrue(result.file_path.is_file())
        self.assertEqual(result.file_path.parent, self.workspace / "Workflows")
        self.assertAlmostEqual(_world_bounds(result.file_path)[0][1], 0.0, places=5)


class TransformRegistryTests(unittest.TestCase):
    def test_transform_ops_are_registered(self) -> None:
        described = {op["id"]: op for op in mesh_ops_registry.describe()}

        for op_id in ("recenter", "drop_to_ground", "auto_orient", "normalize_scale"):
            self.assertEqual(described[op_id]["category"], "transform")
            self.assertFalse(described[op_id]["destructive"])
        self.assertEqual(
            [schema["id"] for schema in described["normalize_scale"]["params_schema"]],
            ["size", "unit", "dimension"],
        )


if __name__ == "__main__":
    unittest.main()

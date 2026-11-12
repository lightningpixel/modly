import asyncio
import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import httpx
import numpy as np
import trimesh

import routers.agent as agent
from services.mesh_ops import MeshOpContext, MeshOpResult, mesh_ops_registry
from services.mesh_ops import presets
from services.mesh_ops.inspection import _file_has_normals


HAS_PYMESHLAB = importlib.util.find_spec("pymeshlab") is not None
PRESET_IDS = ("prepare_for_printing", "prepare_for_game", "prepare_for_web")


def _holed_tilted_plate() -> trimesh.Trimesh:
    """A 2 × 0.2 × 1 plate missing one face, tilted 30° and moved off the origin."""
    plate = trimesh.creation.box(extents=[2.0, 0.2, 1.0])
    plate.update_faces(np.arange(1, len(plate.faces)))
    plate.apply_transform(
        trimesh.transformations.rotation_matrix(np.radians(30), [0, 0, 1])
    )
    plate.apply_translation([3.0, 4.0, 5.0])
    return plate


def _sphere_with_inverted_normals(radius: float = 1.5) -> trimesh.Trimesh:
    sphere = trimesh.creation.icosphere(subdivisions=3, radius=radius)
    sphere.vertex_normals = -sphere.vertex_normals
    return sphere


def _fake_decimate(calls: list):
    """Stands in for the Node/meshoptimizer backend: copies the mesh as is."""

    def decimate(input_path, params, context):
        calls.append({"input": Path(input_path), "params": dict(params)})
        loaded = trimesh.load(str(input_path))
        loaded.export(str(context.output_path))
        faces = sum(len(g.faces) for g in loaded.geometry.values())
        return MeshOpResult(file_path=Path(context.output_path), details={"face_count": faces})

    return decimate


def _stored_normals(path: Path) -> tuple[np.ndarray, np.ndarray]:
    """The vertices and the normals written in the file (not recomputed)."""
    scene = trimesh.load(str(path), process=False)
    geometry = next(iter(scene.geometry.values()))
    return np.asarray(geometry.vertices), np.asarray(geometry.vertex_normals)


class PresetRegistryTests(unittest.TestCase):
    def test_presets_are_registered_in_their_own_category(self) -> None:
        descriptions = {d["id"]: d for d in mesh_ops_registry.describe()}
        for preset_id in PRESET_IDS:
            with self.subTest(preset_id):
                description = descriptions[preset_id]
                self.assertEqual(description["category"], "presets")
                self.assertTrue(description["undoable"])
                self.assertFalse(description["destructive"])
                self.assertIsNotNone(mesh_ops_registry.get(preset_id).agent)

    def test_param_schemas_expose_the_intent_knobs(self) -> None:
        def params(op_id):
            return {p["id"]: p for p in mesh_ops_registry.get(op_id).params_schema}

        printing = params("prepare_for_printing")
        self.assertEqual(set(printing), {"size_mm", "dimension"})
        self.assertEqual(printing["size_mm"]["default"], 100.0)

        game = params("prepare_for_game")
        self.assertEqual(set(game), {"target_faces", "size_m", "dimension"})

        web = params("prepare_for_web")
        self.assertEqual(set(web), {"target_faces"})
        # "Aggressive": the web budget is well below the game one.
        self.assertLess(web["target_faces"]["default"], game["target_faces"]["default"])

    def test_presets_become_agent_tools_and_are_named_in_the_prompt(self) -> None:
        tools = {t["function"]["name"]: t["function"] for t in agent.registry_tools(mesh_ops_registry)}
        for preset_id in PRESET_IDS:
            with self.subTest(preset_id):
                self.assertIn(preset_id, tools)
                self.assertIn(preset_id, agent.SYSTEM_PROMPT)
        self.assertIn("size_mm", tools["prepare_for_printing"]["parameters"]["properties"])
        self.assertIn("target_faces", tools["prepare_for_web"]["parameters"]["properties"])


class _PresetCase(unittest.TestCase):
    def setUp(self) -> None:
        self._directory = tempfile.TemporaryDirectory()
        self.workspace = Path(self._directory.name)
        self.context = MeshOpContext(workspace_dir=self.workspace, temp_dir=self.workspace)

    def tearDown(self) -> None:
        self._directory.cleanup()

    def _export(self, geometry, name="mesh.glb", **kwargs) -> Path:
        path = self.workspace / name
        geometry.export(str(path), **kwargs)
        return path

    def _run(self, op_id: str, path: Path, **params) -> MeshOpResult:
        files_before = set(self.workspace.rglob("*"))
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        result = mesh_ops_registry.run(op_id, path, params, self.context)

        self.assertIsNotNone(result.file_path)
        self.assertTrue(result.file_path.is_file())
        # One output file, no leftover intermediates, input untouched.
        new_files = {p for p in self.workspace.rglob("*") if p.is_file()} - files_before
        self.assertEqual(new_files, {result.file_path})
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), digest)
        json.dumps(dict(result.details))
        return result


@unittest.skipUnless(HAS_PYMESHLAB, "pymeshlab is not installed")
class PrepareForPrintingTests(_PresetCase):
    def test_holed_tilted_mesh_becomes_printable_flat_grounded_and_sized(self) -> None:
        result = self._run("prepare_for_printing", self._export(_holed_tilted_plate()), size_mm=50)
        details = result.details

        self.assertEqual(
            [step["op"] for step in details["steps"]],
            ["repair_mesh", "auto_orient", "normalize_scale", "drop_to_ground"],
        )
        self.assertTrue(details["steps"][0]["repaired"])
        self.assertTrue(details["watertight"])
        self.assertEqual(details["remaining_issues"], [])

        report = mesh_ops_registry.run(
            "inspect_mesh", result.file_path, {"check_self_intersections": False}, self.context
        ).details
        self.assertTrue(report["is_watertight"], report["issues"])
        self.assertTrue(report["is_manifold"], report["issues"])
        bounds = np.asarray([report["bounds"]["min"], report["bounds"]["max"]])
        extents = bounds[1] - bounds[0]
        # Longest side 50 mm (glTF stores metres), lying flat on the ground.
        self.assertAlmostEqual(float(extents.max()), 0.05, places=6)
        self.assertAlmostEqual(float(bounds[0][1]), 0.0, places=6)
        self.assertAlmostEqual(float(extents[1]), 0.005, places=5)
        np.testing.assert_allclose(details["dimensions_mm"], extents * 1000, atol=1e-6)

    def test_sound_mesh_skips_the_repair_but_is_still_arranged(self) -> None:
        box = trimesh.creation.box(extents=[1.0, 2.0, 3.0])
        box.apply_translation([0.0, 5.0, 0.0])
        result = self._run("prepare_for_printing", self._export(box))

        repair = result.details["steps"][0]
        self.assertEqual(repair["op"], "repair_mesh")
        self.assertFalse(repair["repaired"])
        self.assertTrue(result.details["watertight"])
        bounds = trimesh.load(str(result.file_path)).bounds
        self.assertAlmostEqual(float((bounds[1] - bounds[0]).max()), 0.1, places=6)
        self.assertAlmostEqual(float(bounds[0][1]), 0.0, places=6)


class PrepareForGameAndWebTests(_PresetCase):
    def setUp(self) -> None:
        super().setUp()
        self.decimate_calls: list = []
        patcher = mock.patch.object(presets, "decimate_mesh", _fake_decimate(self.decimate_calls))
        patcher.start()
        self.addCleanup(patcher.stop)

    def _assert_outward_normals(self, path: Path) -> None:
        self.assertTrue(_file_has_normals(path))
        vertices, normals = _stored_normals(path)
        centre = vertices.mean(axis=0)
        dots = np.einsum("ij,ij->i", normals, vertices - centre)
        self.assertTrue(np.all(dots > 0), "normals were not recomputed outwards")

    def test_game_decimates_to_the_budget_scales_in_metres_and_fixes_normals(self) -> None:
        path = self._export(_sphere_with_inverted_normals(), include_normals=True)
        result = self._run("prepare_for_game", path, target_faces=640, size_m=2.0)

        self.assertEqual(len(self.decimate_calls), 1)
        self.assertEqual(self.decimate_calls[0]["input"], path)
        self.assertEqual(self.decimate_calls[0]["params"], {"target_faces": 640})
        self.assertEqual(
            [step["op"] for step in result.details["steps"]],
            ["decimate", "normalize_scale", "recompute_normals"],
        )
        self.assertEqual(result.details["face_count"], 1280)
        extents = trimesh.load(str(result.file_path)).extents
        self.assertAlmostEqual(float(extents.max()), 2.0, places=6)
        np.testing.assert_allclose(result.details["dimensions"], extents, atol=1e-6)
        self._assert_outward_normals(result.file_path)

    def test_web_decimates_aggressively_and_keeps_the_scale(self) -> None:
        path = self._export(_sphere_with_inverted_normals(radius=1.5), include_normals=True)
        result = self._run("prepare_for_web", path)

        default_budget = mesh_ops_registry.resolve_params("prepare_for_web", {})["target_faces"]
        self.assertEqual(self.decimate_calls[0]["params"], {"target_faces": default_budget})
        self.assertEqual(
            [step["op"] for step in result.details["steps"]],
            ["decimate", "recompute_normals"],
        )
        extents = trimesh.load(str(result.file_path)).extents
        self.assertAlmostEqual(float(extents.max()), 3.0, places=2)
        self._assert_outward_normals(result.file_path)

    def test_textures_survive_the_web_preset(self) -> None:
        from PIL import Image

        box = trimesh.creation.box()
        image = Image.new("RGB", (4, 4), (255, 0, 0))
        uv = np.random.default_rng(0).random((len(box.vertices), 2))
        box.visual = trimesh.visual.TextureVisuals(uv=uv, image=image)
        result = self._run("prepare_for_web", self._export(box))

        geometry = next(iter(trimesh.load(str(result.file_path)).geometry.values()))
        self.assertIsInstance(geometry.visual, trimesh.visual.TextureVisuals)
        self.assertIsNotNone(geometry.visual.uv)


class PresetAgentToolTests(unittest.TestCase):
    def _run(self, name: str, arguments: dict, response: dict):
        requests = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, json=response)

        real_client = httpx.AsyncClient

        def factory(*args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(handler)
            return real_client(*args, **kwargs)

        with mock.patch.object(agent.httpx, "AsyncClient", factory):
            text, payload = asyncio.run(agent.execute_tool(name, arguments, {}))
        return text, payload, requests

    def test_printing_preset_runs_in_one_call_and_reports_each_step(self) -> None:
        text, payload, requests = self._run(
            "prepare_for_printing",
            {"path": "Default/mesh.glb", "size_mm": 80},
            {
                "path": "Default/mesh_prepare_for_printing_1.glb",
                "url": "/workspace/Default/mesh_prepare_for_printing_1.glb",
                "steps": [
                    {"op": "repair_mesh", "summary": "Repaired in 1 pass(es) (fill_holes).", "repaired": True},
                    {"op": "auto_orient", "summary": "Laid flat on its widest side."},
                    {"op": "normalize_scale", "summary": "Scaled the longest side to 80 mm."},
                    {"op": "drop_to_ground", "summary": "Dropped onto the build plate."},
                ],
                "watertight": True,
                "remaining_issues": [],
                "face_count": 12,
                "dimensions_mm": [80.0, 8.0, 40.0],
                "textures_dropped": True,
            },
        )

        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0].url.path, "/optimize/op/prepare_for_printing")
        self.assertEqual(
            json.loads(requests[0].content),
            {"path": "Default/mesh.glb", "params": {"size_mm": 80}},
        )
        self.assertIn("Repaired in 1 pass(es)", text)
        self.assertIn("Scaled the longest side to 80 mm", text)
        self.assertIn("watertight", text)
        self.assertIn("80 × 8 × 40 mm", text)
        self.assertIn("New mesh path: Default/mesh_prepare_for_printing_1.glb", text)
        self.assertIn("textures and UVs were dropped", text)
        self.assertEqual(payload["type"], "mesh_update")

    def test_open_issues_left_after_printing_prep_are_reported(self) -> None:
        text, _, _ = self._run(
            "prepare_for_printing",
            {"path": "Default/mesh.glb"},
            {
                "path": "Default/out.glb",
                "url": "/workspace/Default/out.glb",
                "steps": [],
                "watertight": False,
                "remaining_issues": ["1 hole(s) (40 open boundary edges)"],
                "face_count": 12,
            },
        )
        self.assertIn("NOT watertight", text)
        self.assertIn("1 hole(s)", text)


if __name__ == "__main__":
    unittest.main()

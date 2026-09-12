import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import trimesh
from fastapi import HTTPException

import routers.export as export_router
import routers.optimize as optimize_router
import services.generator_registry as registry
from services.mesh_ops import MeshOpResult

IDENTITY = [
    [1.0, 0.0, 0.0, 0.0],
    [0.0, 1.0, 0.0, 0.0],
    [0.0, 0.0, 1.0, 0.0],
    [0.0, 0.0, 0.0, 1.0],
]


class MeshRoutersAfterWorkspaceMoveTests(unittest.TestCase):
    """Export and mesh-edit endpoints must resolve paths against the workspace as
    it is *now*. POST /settings/paths rebinds registry.WORKSPACE_DIR when the user
    moves the workspace; a name captured at import keeps pointing at the old
    folder, so a model generated after the move can't be exported or edited."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self._prev_ws = registry.WORKSPACE_DIR
        # The user moved the workspace: the registry global now points here.
        registry.WORKSPACE_DIR = self.root / "new_workspace"
        # Keep the test hermetic against import-time bindings: if a router still
        # holds its own WORKSPACE_DIR name, point it at an empty "old" folder in
        # the temp tree so the assertions -- not the real workspace -- catch it.
        (self.root / "old_workspace").mkdir()
        self._stale = []
        for module in (export_router, optimize_router):
            if hasattr(module, "WORKSPACE_DIR"):
                self._stale.append((module, module.WORKSPACE_DIR))
                module.WORKSPACE_DIR = self.root / "old_workspace"

        mesh_dir = registry.WORKSPACE_DIR / "MyColl"
        mesh_dir.mkdir(parents=True)
        trimesh.creation.box().export(mesh_dir / "mesh.glb")

    def tearDown(self) -> None:
        registry.WORKSPACE_DIR = self._prev_ws
        for module, value in self._stale:
            module.WORKSPACE_DIR = value
        self._tmp.cleanup()

    def test_export_router_converts_a_mesh_in_the_moved_workspace(self) -> None:
        response = export_router.export_mesh("stl", "MyColl/mesh.glb")
        self.assertEqual(response.status_code, 200)
        self.assertGreater(len(response.body), 0)

    def test_optimize_export_converts_a_mesh_in_the_moved_workspace(self) -> None:
        response = optimize_router.export_mesh(path="MyColl/mesh.glb", format="obj")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"v ", response.body)

    def test_transform_writes_its_result_into_the_moved_workspace(self) -> None:
        result = optimize_router.transform_mesh(
            optimize_router.TransformRequest(path="MyColl/mesh.glb", matrix=IDENTITY)
        )
        self.assertTrue(result["url"].startswith("/workspace/MyColl/mesh_xf_"))
        written = registry.WORKSPACE_DIR / result["url"].removeprefix("/workspace/")
        self.assertTrue(written.is_file())

    def test_decimate_and_smooth_read_their_input_from_the_moved_workspace(self) -> None:
        # /optimize/mesh and /optimize/smooth resolve their input through this helper.
        resolved = optimize_router._resolve_input_path("MyColl/mesh.glb")
        self.assertEqual(resolved, (registry.WORKSPACE_DIR / "MyColl" / "mesh.glb").resolve())

    def test_decimate_and_smooth_write_their_result_into_the_moved_workspace(self) -> None:
        # The backends (meshoptimizer, pymeshlab) aren't available here, so stand in
        # for the mesh-ops registry and check the router's own path handling: the
        # workspace it hands the operation, where the output goes, and the URL.
        class _RecordingRegistry:
            def __init__(self) -> None:
                self.contexts = []

            def run(self, operation_id, input_path, params, context):
                self.contexts.append(context)
                context.output_path.touch()
                return MeshOpResult(context.output_path, {"face_count": 12})

        ops = _RecordingRegistry()
        with patch.object(optimize_router, "mesh_ops_registry", ops):
            decimated = optimize_router.optimize_mesh(
                optimize_router.OptimizeRequest(path="MyColl/mesh.glb", target_faces=500)
            )
            smoothed = optimize_router.smooth_mesh(
                optimize_router.SmoothRequest(path="MyColl/mesh.glb", iterations=2)
            )

        self.assertEqual(decimated["url"], "/workspace/MyColl/mesh_opt500.glb")
        self.assertEqual(smoothed["url"], "/workspace/MyColl/mesh_smooth2.glb")
        for context in ops.contexts:
            self.assertEqual(context.workspace_dir, registry.WORKSPACE_DIR)
            self.assertEqual(context.output_path.parent, registry.WORKSPACE_DIR / "MyColl")

    def test_a_path_leaving_the_workspace_is_still_refused(self) -> None:
        # Reading the live workspace must not loosen the containment check.
        trimesh.creation.box().export(self.root / "outside.glb")
        calls = (
            lambda: export_router.export_mesh("stl", "../outside.glb"),
            lambda: optimize_router.export_mesh(path="../outside.glb", format="obj"),
        )
        for call in calls:
            with self.assertRaises(HTTPException) as raised:
                call()
            self.assertEqual(raised.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()

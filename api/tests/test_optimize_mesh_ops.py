import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

from routers import optimize
from services.mesh_ops import (
    MeshOp,
    MeshOpExecutionError,
    MeshOpNotFoundError,
    MeshOpResult,
    MeshOpsRegistry,
)


class _FakeRegistry:
    def __init__(self, output_path: Path) -> None:
        self.output_path = output_path
        self.calls = []

    def describe(self):
        return [{"id": "repair", "category": "repair", "params_schema": []}]

    def run(self, operation_id, input_path, params, context):
        self.calls.append((operation_id, input_path, params, context))
        output_path = context.output_path or self.output_path
        return MeshOpResult(output_path, {"face_count": 42})


class OptimizeMeshOpsRouteTests(unittest.TestCase):
    def test_generic_list_and_run_routes_use_the_shared_registry(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            input_path = workspace / "input.glb"
            output_path = workspace / "Workflows" / "output.glb"
            input_path.touch()
            registry = _FakeRegistry(output_path)

            with (
                patch.object(optimize.registry, "WORKSPACE_DIR", workspace),
                patch.object(optimize, "mesh_ops_registry", registry),
            ):
                descriptions = optimize.list_mesh_operations()
                response = optimize.run_mesh_operation(
                    "repair",
                    optimize.MeshOpRequest(
                        path="input.glb",
                        params={"fill_holes": False},
                    ),
                )

        self.assertEqual(descriptions[0]["id"], "repair")
        self.assertEqual(
            response,
            {
                "path": "Workflows/output.glb",
                "url": "/workspace/Workflows/output.glb",
                "face_count": 42,
            },
        )
        self.assertEqual(registry.calls[0][0:3], (
            "repair",
            input_path,
            {"fill_holes": False},
        ))

    def test_legacy_routes_delegate_with_their_existing_clamps_and_names(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            input_path = workspace / "model.glb"
            fallback_output = workspace / "Workflows" / "unused.glb"
            input_path.touch()
            registry = _FakeRegistry(fallback_output)

            with (
                patch.object(optimize.registry, "WORKSPACE_DIR", workspace),
                patch.object(optimize, "mesh_ops_registry", registry),
            ):
                optimize_response = optimize.optimize_mesh(
                    optimize.OptimizeRequest(path="model.glb", target_faces=2)
                )
                smooth_response = optimize.smooth_mesh(
                    optimize.SmoothRequest(path="model.glb", iterations=99)
                )

        optimize_call, smooth_call = registry.calls
        self.assertEqual(optimize_call[0], "decimate")
        self.assertEqual(optimize_call[2], {"target_faces": 100})
        self.assertEqual(
            optimize_call[3].output_path,
            workspace / "model_opt100.glb",
        )
        self.assertEqual(smooth_call[0], "smooth")
        self.assertEqual(
            smooth_call[2],
            {"iterations": 20, "lambda_": 0.5, "mode": "laplacian"},
        )
        self.assertEqual(
            smooth_call[3].output_path,
            workspace / "model_smooth20.glb",
        )
        self.assertTrue(smooth_call[3].preserve_visuals)
        self.assertEqual(optimize_response["face_count"], 42)
        self.assertEqual(smooth_response["url"], "/workspace/model_smooth20.glb")

    def test_unknown_generic_operation_is_a_404(self) -> None:
        class MissingRegistry:
            def run(self, operation_id, input_path, params, context):
                raise MeshOpNotFoundError(operation_id)

        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            input_path = workspace / "input.glb"
            input_path.touch()
            with (
                patch.object(optimize.registry, "WORKSPACE_DIR", workspace),
                patch.object(optimize, "mesh_ops_registry", MissingRegistry()),
                self.assertRaises(HTTPException) as raised,
            ):
                optimize.run_mesh_operation(
                    "missing",
                    optimize.MeshOpRequest(path="input.glb"),
                )

        self.assertEqual(raised.exception.status_code, 404)

    def test_generic_run_route_enforces_registry_bounds(self) -> None:
        calls = []

        def operation(input_path, params, context):
            calls.append(params)
            return MeshOpResult(input_path)

        registry = MeshOpsRegistry(
            [
                MeshOp(
                    id="bounded",
                    label="Bounded",
                    params_schema=(
                        {
                            "id": "amount",
                            "type": "int",
                            "default": 3,
                            "min": 1,
                            "max": 5,
                        },
                    ),
                    fn=operation,
                    category="test",
                )
            ]
        )

        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            input_path = workspace / "input.glb"
            input_path.touch()
            with (
                patch.object(optimize.registry, "WORKSPACE_DIR", workspace),
                patch.object(optimize, "mesh_ops_registry", registry),
            ):
                optimize.run_mesh_operation(
                    "bounded",
                    optimize.MeshOpRequest(
                        path="input.glb",
                        params={"amount": 99},
                    ),
                )

        self.assertEqual(calls, [{"amount": 5}])

    def test_missing_input_during_execution_is_a_404(self) -> None:
        class MissingInputRegistry:
            def run(self, operation_id, input_path, params, context):
                raise FileNotFoundError(f"Input mesh not found: {input_path}")

        self._assert_operation_error(MissingInputRegistry(), 404)

    def test_backend_execution_failure_is_a_503(self) -> None:
        class FailedBackendRegistry:
            def run(self, operation_id, input_path, params, context):
                raise MeshOpExecutionError("mesh-optimizer exited with code 1")

        self._assert_operation_error(FailedBackendRegistry(), 503)

    def _assert_operation_error(self, registry, expected_status: int) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            input_path = workspace / "input.glb"
            input_path.touch()
            with (
                patch.object(optimize.registry, "WORKSPACE_DIR", workspace),
                patch.object(optimize, "mesh_ops_registry", registry),
                self.assertRaises(HTTPException) as raised,
            ):
                optimize.run_mesh_operation(
                    "decimate",
                    optimize.MeshOpRequest(path="input.glb"),
                )

        self.assertEqual(raised.exception.status_code, expected_status)


if __name__ == "__main__":
    unittest.main()

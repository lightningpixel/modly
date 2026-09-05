import io
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from services.mesh_ops import MeshOpContext
from services.mesh_ops import operations


class _FakeGeometry:
    def __init__(self, faces=None) -> None:
        self.faces = faces if faces is not None else [1, 2, 3]
        self.vertices = [1, 2, 3, 4]
        self.exports = []

    def export(self, path) -> None:
        self.exports.append(str(path))
        Path(path).touch()


class _FakeScene:
    pass


class _FakeMesh:
    def vertex_number(self) -> int:
        return 4

    def face_number(self) -> int:
        return 3


class _FakeMeshSet:
    def __init__(self) -> None:
        self.calls = []

    def current_mesh(self):
        return _FakeMesh()

    def __getattr__(self, name):
        def call(*args, **kwargs):
            self.calls.append((name, args, kwargs))
            if name == "save_current_mesh":
                Path(args[0]).touch()

        return call


class _InputCapture:
    def __init__(self) -> None:
        self.value = ""

    def write(self, value) -> None:
        self.value += value

    def close(self) -> None:
        pass


class _FakeProcess:
    def __init__(self, messages, return_code=0, stderr="") -> None:
        self.stdin = _InputCapture()
        self.stdout = iter(f"{json.dumps(message)}\n" for message in messages)
        self.stderr = io.StringIO(stderr)
        self.return_code = return_code
        self.killed = False

    def wait(self) -> int:
        return self.return_code

    def kill(self) -> None:
        self.killed = True


class MeshOpOperationRegressionTests(unittest.TestCase):
    def test_meshopt_runner_is_valid_javascript(self) -> None:
        node = shutil.which("node") or shutil.which("nodejs")
        if node is None:
            self.skipTest("Node.js is unavailable")
        runner = Path(operations.__file__).with_name("meshopt_runner.cjs")
        result = subprocess.run(
            [node, "--check", str(runner)],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_repair_keeps_the_original_filter_order_and_arguments(self) -> None:
        mesh_set = _FakeMeshSet()
        source = _FakeGeometry()
        result_geometry = _FakeGeometry(faces=[1, 2])
        events = []

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_path = root / "input.glb"
            output_path = root / "output.glb"
            input_path.touch()
            context = MeshOpContext(
                workspace_dir=root,
                temp_dir=root,
                output_path=output_path,
                progress_cb=lambda percent, label: events.append(
                    ("progress", percent, label)
                ),
                log_cb=lambda message: events.append(("log", message)),
            )

            with (
                patch.object(
                    operations,
                    "_mesh_libraries",
                    return_value=(
                        SimpleNamespace(MeshSet=lambda: mesh_set),
                        object(),
                    ),
                ),
                patch.object(operations, "_load_single_mesh", return_value=source),
                patch.object(
                    operations,
                    "_raw_geometry",
                    return_value=result_geometry,
                ),
            ):
                result = operations.repair_mesh(input_path, {}, context)

        self.assertEqual(result.file_path, output_path)
        self.assertEqual(result.details, {"face_count": 2})
        self.assertEqual(
            [call[0] for call in mesh_set.calls],
            [
                "load_new_mesh",
                "meshing_remove_duplicate_vertices",
                "meshing_remove_duplicate_faces",
                "meshing_remove_null_faces",
                "meshing_remove_folded_faces",
                "meshing_repair_non_manifold_edges",
                "meshing_repair_non_manifold_vertices",
                "meshing_close_holes",
                "save_current_mesh",
            ],
        )
        self.assertEqual(mesh_set.calls[5][2], {"method": 0})
        self.assertEqual(
            mesh_set.calls[7][2],
            {
                "maxholesize": 2000,
                "newfaceselected": False,
                "selfintersection": False,
            },
        )
        self.assertIn(("progress", 100, "Done"), events)

    def test_smooth_keeps_taubin_and_laplacian_parameter_semantics(self) -> None:
        for mode, expected_method, expected_arguments in (
            (
                "taubin",
                "apply_coord_taubin_smoothing",
                {"lambda_": 0.4, "mu": -0.41000000000000003, "stepsmoothnum": 7},
            ),
            (
                "laplacian",
                "apply_coord_laplacian_smoothing",
                {"stepsmoothnum": 7, "cotangentweight": False},
            ),
        ):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                mesh_set = _FakeMeshSet()
                geometry = _FakeGeometry()
                root = Path(directory)
                input_path = root / "input.glb"
                input_path.touch()
                context = MeshOpContext(
                    workspace_dir=root,
                    temp_dir=root,
                    output_path=root / "output.glb",
                )

                with (
                    patch.object(
                        operations,
                        "_mesh_libraries",
                        return_value=(
                            SimpleNamespace(MeshSet=lambda: mesh_set),
                            SimpleNamespace(Scene=_FakeScene),
                        ),
                    ),
                    patch.object(
                        operations,
                        "_load_single_mesh",
                        return_value=geometry,
                    ),
                    patch.object(
                        operations,
                        "_raw_geometry",
                        return_value=geometry,
                    ),
                ):
                    operations.smooth_mesh(
                        input_path,
                        {"iterations": 7, "lambda_": 0.4, "mode": mode},
                        context,
                    )

            smoothing_call = next(
                call for call in mesh_set.calls if call[0] == expected_method
            )
            self.assertEqual(smoothing_call[2], expected_arguments)

    def test_legacy_smooth_keeps_its_original_laplacian_arguments(self) -> None:
        mesh_set = _FakeMeshSet()
        geometry = _FakeGeometry()
        fake_trimesh = SimpleNamespace(
            Scene=_FakeScene,
            load=lambda path, **kwargs: geometry,
        )

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_path = root / "input.glb"
            input_path.touch()
            context = MeshOpContext(
                workspace_dir=root,
                temp_dir=root,
                output_path=root / "output.glb",
                preserve_visuals=True,
            )
            with (
                patch.object(
                    operations,
                    "_mesh_libraries",
                    return_value=(
                        SimpleNamespace(MeshSet=lambda: mesh_set),
                        fake_trimesh,
                    ),
                ),
                patch.object(
                    operations,
                    "_load_single_mesh",
                    return_value=geometry,
                ),
                patch.object(operations, "_has_texture", return_value=False),
            ):
                operations.smooth_mesh(
                    input_path,
                    {"iterations": 9, "lambda_": 0.5, "mode": "laplacian"},
                    context,
                )

        smoothing_call = next(
            call
            for call in mesh_set.calls
            if call[0] == "apply_coord_laplacian_smoothing"
        )
        self.assertEqual(smoothing_call[2], {"stepsmoothnum": 9})

    def test_decimate_forwards_meshopt_progress_logs_and_result(self) -> None:
        messages = [
            {"type": "log", "message": "Current triangles: 12"},
            {"type": "progress", "percent": 55, "label": "Simplifying mesh…"},
            {
                "type": "done",
                "result": {"filePath": "/workspace/result.glb", "faceCount": 5},
            },
        ]
        fake_process = _FakeProcess(messages)
        events = []

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_path = root / "input.glb"
            input_path.touch()
            context = MeshOpContext(
                workspace_dir=root,
                temp_dir=root,
                progress_cb=lambda percent, label: events.append(
                    ("progress", percent, label)
                ),
                log_cb=lambda message: events.append(("log", message)),
            )
            with (
                patch.object(
                    operations,
                    "_node_executable",
                    return_value=("node", False),
                ),
                patch.object(
                    operations,
                    "_meshopt_dependency_dir",
                    return_value=root,
                ),
                patch.object(
                    operations.subprocess,
                    "Popen",
                    return_value=fake_process,
                ) as popen,
            ):
                result = operations.decimate_mesh(
                    input_path,
                    {"target_faces": 5},
                    context,
                )

        self.assertEqual(result.file_path, Path("/workspace/result.glb"))
        self.assertEqual(result.details, {"face_count": 5})
        self.assertIn(("log", "Current triangles: 12"), events)
        self.assertIn(("progress", 55, "Simplifying mesh…"), events)
        command = popen.call_args.args[0]
        self.assertEqual(command[0], "node")
        self.assertTrue(command[1].endswith("meshopt_runner.cjs"))
        payload = json.loads(fake_process.stdin.value)
        self.assertEqual(payload["inputPath"], str(input_path))
        self.assertEqual(payload["params"], {"target_faces": 5})


if __name__ == "__main__":
    unittest.main()

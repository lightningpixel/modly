import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from services.mesh_ops import MeshOpResult
from services.mesh_ops import processor


class _FakeRegistry:
    def __init__(self, output_path: Path) -> None:
        self.output_path = output_path
        self.calls = []

    def run(self, operation_id, input_path, params, context):
        self.calls.append((operation_id, input_path, params, context))
        context.progress(35, "Working…")
        context.log("shared implementation")
        return MeshOpResult(self.output_path)


class MeshOpProcessorTests(unittest.TestCase):
    def test_workflow_protocol_forwards_to_registry_and_preserves_events(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_path = root / "input.glb"
            output_path = root / "output.glb"
            input_path.touch()
            registry = _FakeRegistry(output_path)
            request = {
                "input": {"filePath": str(input_path)},
                "params": {"iterations": 7},
                "workspaceDir": str(root),
                "tempDir": str(root / "tmp"),
            }

            stdout = io.StringIO()
            with (
                patch.object(processor, "mesh_ops_registry", registry),
                patch.object(processor.sys, "stdin", io.StringIO(json.dumps(request))),
                redirect_stdout(stdout),
            ):
                processor.run_processor("smooth", "mesh-smoother")

        messages = [json.loads(line) for line in stdout.getvalue().splitlines()]
        self.assertEqual(
            [message["type"] for message in messages],
            ["progress", "log", "done"],
        )
        self.assertEqual(messages[-1]["result"]["filePath"], str(output_path))
        self.assertEqual(registry.calls[0][0:3], (
            "smooth",
            input_path,
            {"iterations": 7},
        ))
        self.assertEqual(registry.calls[0][3].workspace_dir, root)

    def test_missing_input_uses_existing_node_error_contract(self) -> None:
        stdout = io.StringIO()
        request = {"input": {}, "params": {}}
        with (
            patch.object(processor.sys, "stdin", io.StringIO(json.dumps(request))),
            redirect_stdout(stdout),
        ):
            processor.run_processor("repair", "mesh-repair")

        message = json.loads(stdout.getvalue())
        self.assertEqual(message["type"], "error")
        self.assertIn("mesh-repair: input file not found: None", message["message"])


if __name__ == "__main__":
    unittest.main()

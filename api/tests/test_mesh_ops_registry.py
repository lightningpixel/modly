import json
import tempfile
import unittest
from pathlib import Path

from services.mesh_ops import (
    MeshOp,
    MeshOpContext,
    MeshOpNotFoundError,
    MeshOpResult,
    MeshOpsRegistry,
    mesh_ops_registry,
)


class MeshOpsRegistryTests(unittest.TestCase):
    def test_builtin_metadata_is_serializable_and_complete(self) -> None:
        descriptions = mesh_ops_registry.describe()

        self.assertEqual(
            [description["id"] for description in descriptions],
            ["repair", "decimate", "smooth"],
        )
        for description in descriptions:
            self.assertIn(description["category"], {"repair", "optimization"})
            self.assertFalse(description["destructive"])
            self.assertTrue(description["undoable"])
            self.assertIsInstance(description["params_schema"], list)
        json.dumps(descriptions)

    def test_run_applies_schema_defaults_without_mutating_metadata(self) -> None:
        calls = []

        def operation(input_path, params, context):
            calls.append((input_path, params, context))
            return MeshOpResult(input_path)

        registry = MeshOpsRegistry(
            [
                MeshOp(
                    id="example",
                    label="Example",
                    params_schema=(
                        {"id": "amount", "type": "int", "default": 3},
                    ),
                    fn=operation,
                    category="test",
                )
            ]
        )

        with tempfile.TemporaryDirectory() as directory:
            input_path = Path(directory) / "mesh.glb"
            input_path.touch()
            context = MeshOpContext(Path(directory), Path(directory))
            registry.run("example", input_path, {"extra": True}, context)

        self.assertEqual(calls[0][1], {"amount": 3, "extra": True})
        calls[0][1]["amount"] = 99
        self.assertEqual(
            registry.describe()[0]["params_schema"][0]["default"],
            3,
        )

    def test_invalid_duplicate_and_unknown_ids_are_rejected(self) -> None:
        operation = MeshOp(
            id="valid",
            label="Valid",
            params_schema=(),
            fn=lambda path, params, context: MeshOpResult(path),
            category="test",
        )
        registry = MeshOpsRegistry([operation])

        with self.assertRaisesRegex(ValueError, "Duplicate"):
            registry.register(operation)
        with self.assertRaisesRegex(ValueError, "Invalid"):
            registry.register(
                MeshOp(
                    id="Not Valid",
                    label="Invalid",
                    params_schema=(),
                    fn=operation.fn,
                    category="test",
                )
            )
        with self.assertRaises(MeshOpNotFoundError):
            registry.get("missing")

    def test_workflow_manifests_share_registry_schemas_and_thin_adapters(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        nodes_root = repository_root / "src" / "areas" / "workflows" / "nodes"
        cases = {
            "repair": ("mesh-repair", "repair"),
            "decimate": ("mesh-optimizer", "decimate"),
            "smooth": ("mesh-smoother", "smooth"),
        }

        descriptions = {
            description["id"]: description
            for description in mesh_ops_registry.describe()
        }
        for operation_id, (extension_id, wrapper_operation_id) in cases.items():
            extension_dir = nodes_root / extension_id
            manifest = json.loads(
                (extension_dir / "manifest.json").read_text(encoding="utf-8")
            )
            self.assertEqual(manifest["entry"], "processor.py")
            self.assertEqual(
                manifest["nodes"][0]["params_schema"],
                descriptions[operation_id]["params_schema"],
            )

            wrapper = (extension_dir / "processor.py").read_text(encoding="utf-8")
            self.assertIn(
                f'run_processor("{wrapper_operation_id}", "{extension_id}")',
                wrapper,
            )
            self.assertLess(len(wrapper.splitlines()), 30)


if __name__ == "__main__":
    unittest.main()

import json
import tempfile
import unittest
from pathlib import Path

from services.image_ops import (
    ImageOp,
    ImageOpContext,
    ImageOpNotFoundError,
    ImageOpNotReadyError,
    ImageOpResult,
    ImageOpsRegistry,
    image_ops_registry,
)


class FakeRequirement:
    def __init__(self, kind: str, ready: bool, size: int | None = 10, id: str | None = None) -> None:
        self.kind = kind
        self.id = id or f"fake-{kind}"
        self.label = f"Fake {kind}"
        self.ready = ready
        self.size = size
        self.installs = 0

    def is_ready(self) -> bool:
        return self.ready

    def download_bytes(self):
        return None if self.ready else self.size

    def install(self, progress) -> None:
        self.installs += 1
        progress({"percent": 50, "status": "half"})
        self.ready = True
        progress({"percent": 100, "status": f"{self.label} ready"})


SCHEMA = (
    {"id": "strength", "label": "Strength", "type": "float", "default": 0.0, "min": 0.0, "max": 0.95},
    {"id": "count", "label": "Count", "type": "int", "default": 2, "min": 1, "max": 5},
    {"id": "flag", "label": "Flag", "type": "boolean", "default": False},
)


def make_op(requirements=(), fn=None) -> ImageOp:
    return ImageOp(
        id="example",
        label="Example",
        params_schema=SCHEMA,
        fn=fn or (lambda path, params, ctx: ImageOpResult(path=path, details={"params": params})),
        requirements=tuple(requirements),
    )


class ImageOpsRegistryTests(unittest.TestCase):
    def test_builtin_metadata_is_serializable(self) -> None:
        described = image_ops_registry.describe()
        self.assertEqual([d["id"] for d in described], ["crop", "remove_background", "auto_frame"])
        op = described[1]
        self.assertEqual(op["label"], "Remove background")
        self.assertEqual(
            [(r["kind"], r["id"]) for r in op["requirements"]],
            [("runtime", "onnxruntime"), ("model", "birefnet-lite")],
        )
        (param,) = op["params_schema"]
        self.assertEqual(
            {k: param[k] for k in ("id", "type", "default", "min", "max")},
            {"id": "edge_threshold", "type": "float", "default": 0.0, "min": 0.0, "max": 0.95},
        )
        self.assertTrue(param["tooltip"])
        json.dumps(described)

    def test_defaults_are_applied_without_mutating_schema(self) -> None:
        registry = ImageOpsRegistry([make_op()])
        self.assertEqual(registry.resolve_params("example", None), {"strength": 0.0, "count": 2, "flag": False})
        resolved = registry.resolve_params("example", {"strength": 0.3})
        self.assertEqual(resolved["strength"], 0.3)
        self.assertEqual(SCHEMA[0]["default"], 0.0)

    def test_numbers_are_clamped_and_coerced(self) -> None:
        registry = ImageOpsRegistry([make_op()])
        self.assertEqual(registry.resolve_params("example", {"strength": 2})["strength"], 0.95)
        self.assertIsInstance(registry.resolve_params("example", {"strength": 1})["strength"], float)
        self.assertEqual(registry.resolve_params("example", {"strength": -1.0})["strength"], 0.0)
        self.assertEqual(registry.resolve_params("example", {"count": 9.0})["count"], 5)

    def test_invalid_params_are_rejected(self) -> None:
        registry = ImageOpsRegistry([make_op()])
        for bad in ({"strength": "high"}, {"strength": True}, {"count": 1.5}, {"flag": 1}):
            with self.subTest(bad=bad), self.assertRaises(TypeError):
                registry.resolve_params("example", bad)
        with self.assertRaises(ValueError):
            registry.resolve_params("example", {"strength": float("nan")})
        with self.assertRaisesRegex(ValueError, "Unknown parameter"):
            registry.resolve_params("example", {"nope": 1})

    def test_ids_are_validated_and_unique(self) -> None:
        registry = ImageOpsRegistry([make_op()])
        with self.assertRaises(ValueError):
            registry.register(make_op())
        with self.assertRaises(ValueError):
            ImageOpsRegistry([ImageOp(id="Bad Id", label="x", params_schema=(), fn=lambda *a: None)])
        with self.assertRaises(ImageOpNotFoundError):
            registry.get("missing")

    def test_missing_lists_unready_requirement_kinds_in_order(self) -> None:
        op = make_op([FakeRequirement("runtime", False), FakeRequirement("model", True)])
        self.assertEqual(op.missing(), ["runtime"])
        op = make_op([FakeRequirement("runtime", False), FakeRequirement("model", False)])
        self.assertEqual(op.missing(), ["runtime", "model"])

    def test_run_refuses_when_not_ready(self) -> None:
        calls = []
        op = make_op([FakeRequirement("model", False)], fn=lambda *a: calls.append(a))
        registry = ImageOpsRegistry([op])
        with tempfile.TemporaryDirectory() as tmp:
            image = Path(tmp) / "a.png"
            image.write_bytes(b"x")
            with self.assertRaises(ImageOpNotReadyError) as caught:
                registry.run("example", image, {}, ImageOpContext(Path(tmp)))
        self.assertEqual(caught.exception.missing, ["model"])
        self.assertEqual(calls, [])

    def test_run_passes_resolved_params(self) -> None:
        registry = ImageOpsRegistry([make_op([FakeRequirement("model", True)])])
        with tempfile.TemporaryDirectory() as tmp:
            image = Path(tmp) / "a.png"
            image.write_bytes(b"x")
            result = registry.run("example", image, {"count": 3}, ImageOpContext(Path(tmp)))
            self.assertEqual(result.details["params"], {"strength": 0.0, "count": 3, "flag": False})
            with self.assertRaises(FileNotFoundError):
                registry.run("example", Path(tmp) / "missing.png", {}, ImageOpContext(Path(tmp)))


if __name__ == "__main__":
    unittest.main()

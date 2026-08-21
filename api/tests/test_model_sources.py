import os
import tempfile
import unittest
from pathlib import Path

from services.model_sources import (
    model_sources_are_downloaded,
    normalize_model_sources,
    resolve_model_root,
    validate_source_file_plan,
)


def valid_node() -> dict:
    return {
        "model_sources": [
            {
                "id": "primary",
                "provider": "huggingface",
                "repo_id": "org/main",
                "destination": ".",
                "checks": ["pipeline.json"],
            },
            {
                "id": "encoder",
                "provider": "huggingface",
                "repo_id": "org/encoder",
                "revision": "refs/pr/1",
                "destination": "auxiliary/encoder",
                "include_prefixes": ["config.json", "weights/"],
                "checks": ["config.json", "model.safetensors"],
            },
        ]
    }


class ModelSourcesTests(unittest.TestCase):
    def test_validates_new_sources_without_reinterpreting_legacy_fields(self) -> None:
        sources = normalize_model_sources(valid_node())
        self.assertEqual([source["id"] for source in sources or []], ["primary", "encoder"])
        self.assertIsNone(normalize_model_sources({
            "hf_repo": "legacy/repo",
            "download_check": "../generate/model.safetensors",
            "hf_skip_prefixes": ["weights/**"],
        }))

    def test_rejects_unsafe_and_non_portable_declarations(self) -> None:
        source = valid_node()["model_sources"][0]
        for destination in ("../outside", "aux/CON", "aux/name.", "C:/models"):
            with self.subTest(destination=destination), self.assertRaises(ValueError):
                normalize_model_sources({
                    "model_sources": [{**source, "destination": destination}]
                })
        with self.assertRaisesRegex(ValueError, "provider"):
            normalize_model_sources({
                "model_sources": [{**source, "provider": "url"}]
            })
        with self.assertRaisesRegex(ValueError, "portable-unique"):
            normalize_model_sources({
                "model_sources": [source, {**source, "id": "PRIMARY"}]
            })
        with self.assertRaisesRegex(ValueError, "checks"):
            normalize_model_sources({
                "model_sources": [{**source, "checks": []}]
            })

    def test_rejects_portable_cross_source_file_collisions(self) -> None:
        sources = normalize_model_sources(valid_node()) or []
        with self.assertRaisesRegex(ValueError, "portable target collision"):
            validate_source_file_plan(sources, {
                "primary": ["Auxiliary/Encoder/model.safetensors"],
                "encoder": ["model.safetensors"],
            })

    def test_requires_all_checks_and_rejects_symlinked_extension_ancestry(self) -> None:
        sources = normalize_model_sources(valid_node()) or []
        with tempfile.TemporaryDirectory(prefix="modly-model-sources-") as tmp:
            models = Path(tmp) / "models"
            model_root = models / "pixal3d" / "generate"
            encoder = model_root / "auxiliary" / "encoder"
            encoder.mkdir(parents=True)
            (model_root / "pipeline.json").write_text("{}", encoding="utf-8")
            (encoder / "config.json").write_text("{}", encoding="utf-8")
            self.assertFalse(model_sources_are_downloaded(models, "pixal3d/generate", sources))
            (encoder / "model.safetensors").write_bytes(b"x")
            self.assertTrue(model_sources_are_downloaded(models, "pixal3d/generate", sources))

            for child in sorted((models / "pixal3d").rglob("*"), reverse=True):
                child.unlink() if child.is_file() else child.rmdir()
            (models / "pixal3d").rmdir()
            outside = Path(tmp) / "outside"
            (outside / "generate").mkdir(parents=True)
            try:
                os.symlink(outside, models / "pixal3d", target_is_directory=True)
            except (NotImplementedError, OSError) as exc:
                self.skipTest(f"Symlinks unavailable: {exc}")
            with self.assertRaisesRegex(ValueError, "symlink"):
                resolve_model_root(models, "pixal3d/generate")
            self.assertFalse(model_sources_are_downloaded(models, "pixal3d/generate", sources))


if __name__ == "__main__":
    unittest.main()

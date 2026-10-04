import json
import importlib
import inspect
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path

import services.generator_registry as registry_module
from services.extension_process import ExtensionProcess
from services.generator_registry import GeneratorRegistry


class GeneratorRegistryDiscoveryTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tempdir = tempfile.TemporaryDirectory(prefix="modly-registry-test-")
        self.root = Path(self._tempdir.name)
        self.extensions_dir = self.root / "extensions"
        self.models_dir = self.root / "models"
        self.workspace_dir = self.root / "workspace"
        self.extensions_dir.mkdir()
        self.models_dir.mkdir()
        self.workspace_dir.mkdir()

        self._old_extensions_dir = registry_module.EXTENSIONS_DIR
        self._old_models_dir = registry_module.MODELS_DIR
        self._old_workspace_dir = registry_module.WORKSPACE_DIR
        registry_module.EXTENSIONS_DIR = self.extensions_dir
        registry_module.MODELS_DIR = self.models_dir
        registry_module.WORKSPACE_DIR = self.workspace_dir
        self.registry = GeneratorRegistry()

    def tearDown(self) -> None:
        self.registry._remove_legacy_paths()
        registry_module.EXTENSIONS_DIR = self._old_extensions_dir
        registry_module.MODELS_DIR = self._old_models_dir
        registry_module.WORKSPACE_DIR = self._old_workspace_dir
        for module_name in [
            "registry_eager_helper",
            "registry_lazy_helper",
            "extensions.class-failure.generator",
            "extensions.host-owned-path.generator",
            "extensions.legacy-imports.generator",
        ]:
            sys.modules.pop(module_name, None)
        self._tempdir.cleanup()

    def _write_manifest(
        self,
        directory: Path,
        *,
        extension_id: str,
        extension_type: str = "model",
        node_ids: tuple[str, ...] = ("generate",),
    ) -> None:
        manifest = {
            "id": extension_id,
            "name": extension_id,
            "type": extension_type,
            "nodes": [{"id": node_id} for node_id in node_ids],
        }
        if extension_type == "model":
            manifest["generator_class"] = "TestGenerator"
        else:
            manifest["entry"] = "processor.py"
        (directory / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    def _make_extension(self, extension_id: str) -> Path:
        directory = self.extensions_dir / extension_id
        directory.mkdir()
        return directory

    def _write_registration_capability(
        self,
        extension_id: str,
        *,
        suffix: str = "100",
        token: str = "t" * 43,
    ) -> dict[str, str]:
        state_name = (
            f".modly-registration-pending-{extension_id}-{suffix}"
        )
        state_path = self.extensions_dir / state_name
        state_path.write_text(
            json.dumps({
                "version": 1,
                "extensionId": extension_id,
                "destinationName": extension_id,
                "token": token,
                "consumed": False,
            }),
            encoding="utf-8",
        )
        state_path.chmod(0o600)
        return {
            "extensionId": extension_id,
            "destinationName": extension_id,
            "stateName": state_name,
            "token": token,
        }

    def _make_loadable_pending_extension(self, extension_id: str) -> dict[str, str]:
        extension = self._make_extension(extension_id)
        self._write_manifest(extension, extension_id=extension_id)
        (extension / "generator.py").write_text(
            "\n".join(
                [
                    "from services.generators.base import BaseGenerator",
                    "class TestGenerator(BaseGenerator):",
                    "    def load(self): pass",
                    "    def generate(self, image_bytes, params, progress_cb=None, cancel_event=None):",
                    "        return self.outputs_dir / 'result.glb'",
                ]
            ),
            encoding="utf-8",
        )
        return self._write_registration_capability(extension_id)

    def test_legacy_generator_supports_eager_and_lazy_sibling_imports(self) -> None:
        extension = self._make_extension("legacy-imports")
        self._write_manifest(extension, extension_id="legacy-imports")
        (extension / "registry_eager_helper.py").write_text("VALUE = 'eager'\n", encoding="utf-8")
        (extension / "registry_lazy_helper.py").write_text("VALUE = 'lazy'\n", encoding="utf-8")
        (extension / "generator.py").write_text(
            "\n".join(
                [
                    "from services.generators.base import BaseGenerator",
                    "from registry_eager_helper import VALUE as EAGER_VALUE",
                    "",
                    "class TestGenerator(BaseGenerator):",
                    "    def load(self):",
                    "        self._model = object()",
                    "",
                    "    def generate(self, image_bytes, params, progress_cb=None, cancel_event=None):",
                    "        return self.outputs_dir / 'result.glb'",
                    "",
                    "    def sibling_values(self):",
                    "        from registry_lazy_helper import VALUE as lazy_value",
                    "        return EAGER_VALUE, lazy_value",
                ]
            ),
            encoding="utf-8",
        )

        self.registry.initialize()

        generator = self.registry.get_generator("legacy-imports/generate")
        self.assertEqual(generator.sibling_values(), ("eager", "lazy"))
        self.assertNotIn(str(extension.resolve()), sys.path)
        self.assertIn("cancel_event", inspect.signature(generator.generate).parameters)

        registry_module.EXTENSIONS_DIR = self.root / "empty-extensions"
        registry_module.EXTENSIONS_DIR.mkdir()
        self.registry.reload()
        self.assertNotIn(str(extension.resolve()), sys.path)

    def test_scene_and_existing_custom_io_types_are_registered(self) -> None:
        for extension_id, input_kind in (("scene-io", "scene"), ("capture-io", "capture")):
            extension = self._make_extension(extension_id)
            manifest = {
                "id": extension_id, "name": extension_id, "type": "model",
                "generator_class": "TestGenerator",
                "nodes": [{"id": "generate", "input": input_kind, "output": "scene"}],
            }
            (extension / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            (extension / "generator.py").write_text(
                "from services.generators.base import BaseGenerator\n"
                "class TestGenerator(BaseGenerator):\n"
                " def load(self): self._model = object()\n"
                " def generate(self, value, params, progress_cb=None, cancel_event=None): return self.outputs_dir\n",
                encoding="utf-8",
            )

        self.registry.initialize()
        self.assertEqual(self.registry.get_manifest("scene-io/generate")["input"], "scene")
        self.assertEqual(self.registry.get_manifest("capture-io/generate")["input"], "capture")

    def test_scene_input_rejects_multi_input_shapes_but_image_multi_can_output_scene(self) -> None:
        cases = {
            "scene-mixed": {"input": "scene", "inputs": ["scene", "text"], "output": "mesh"},
            "scene-array": {"input": "scene", "inputs": ["scene"], "output": "mesh"},
            "images-scene": {"input": "image", "inputs": ["image", "image"], "output": "scene"},
        }
        for extension_id, node in cases.items():
            extension = self._make_extension(extension_id)
            (extension / "manifest.json").write_text(json.dumps({
                "id": extension_id, "name": extension_id, "type": "model",
                "generator_class": "TestGenerator",
                "nodes": [{"id": "generate", **node}],
            }), encoding="utf-8")
            (extension / "generator.py").write_text(
                "from services.generators.base import BaseGenerator\n"
                "class TestGenerator(BaseGenerator):\n"
                " def load(self): self._model = object()\n"
                " def generate(self, value, params, progress_cb=None, cancel_event=None): return self.outputs_dir\n",
                encoding="utf-8",
            )
        self.registry.initialize()
        self.assertIn("scene-mixed/generate", self.registry.load_errors())
        self.assertIn("scene-array/generate", self.registry.load_errors())
        self.assertIn("images-scene/generate", self.registry._generators)

    def test_existing_video_declarations_remain_discoverable(self) -> None:
        cases = {
            "video-io": {"input": "video", "output": "mesh"},
            "video-array": {"input": "video", "inputs": ["video"], "output": "mesh"},
            "video-mixed": {"input": "video", "inputs": ["video", "text"], "output": "mesh"},
            "video-output": {"input": "image", "output": "video"},
        }
        for extension_id, node in cases.items():
            extension = self._make_extension(extension_id)
            (extension / "manifest.json").write_text(json.dumps({
                "id": extension_id, "name": extension_id, "type": "model",
                "generator_class": "TestGenerator",
                "nodes": [{"id": "generate", **node}],
            }), encoding="utf-8")
            (extension / "generator.py").write_text(
                "from services.generators.base import BaseGenerator\n"
                "class TestGenerator(BaseGenerator):\n"
                " def load(self): self._model = object()\n"
                " def generate(self, value, params, progress_cb=None, cancel_event=None): return self.outputs_dir / 'result.glb'\n",
                encoding="utf-8",
            )

        self.registry.initialize()
        self.assertEqual(self.registry.get_manifest("video-io/generate")["input"], "video")
        self.assertIn("video-array/generate", self.registry._generators)
        self.assertIn("video-mixed/generate", self.registry._generators)
        self.assertIn("video-output/generate", self.registry._generators)

    def test_declared_sources_block_generation_even_when_generator_overrides_readiness(self) -> None:
        extension = self._make_extension("multi-source")
        manifest = {
            "id": "multi-source",
            "name": "multi-source",
            "type": "model",
            "generator_class": "TestGenerator",
            "nodes": [{
                "id": "generate",
                "model_sources": [
                    {
                        "id": "primary",
                        "provider": "huggingface",
                        "repo_id": "org/main",
                        "destination": ".",
                        "checks": ["main.bin"],
                    },
                    {
                        "id": "encoder",
                        "provider": "huggingface",
                        "repo_id": "org/encoder",
                        "destination": "auxiliary/encoder",
                        "checks": ["encoder.bin"],
                    },
                ],
            }],
        }
        (extension / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        (extension / "generator.py").write_text(
            "\n".join([
                "from services.generators.base import BaseGenerator",
                "class TestGenerator(BaseGenerator):",
                "    def is_downloaded(self): return True",
                "    def load(self): self._model = object()",
                "    def generate(self, image_bytes, params, progress_cb=None, cancel_event=None):",
                "        return self.outputs_dir / 'result.glb'",
            ]),
            encoding="utf-8",
        )

        self.registry.initialize()
        self.registry._active_id = "multi-source/generate"
        with self.assertRaisesRegex(RuntimeError, "Model sources are incomplete"):
            self.registry.get_active()
        self.assertFalse(self.registry.all_status()[0]["downloaded"])

        model_root = self.models_dir / "multi-source" / "generate"
        (model_root / "auxiliary" / "encoder").mkdir(parents=True)
        (model_root / "main.bin").write_bytes(b"main")
        (model_root / "auxiliary" / "encoder" / "encoder.bin").write_bytes(b"encoder")
        self.assertIsNotNone(self.registry.get_active())
        self.assertTrue(self.registry.all_status()[0]["downloaded"])
        (model_root / "main.bin").unlink()
        with self.assertRaisesRegex(RuntimeError, "Model sources are incomplete"):
            self.registry.get_active()

    def test_shared_groups_gate_all_dependents_and_keep_private_dirs_separate(self) -> None:
        extension = self._make_extension("shared-model")
        manifest = {
            "id": "shared-model",
            "name": "shared-model",
            "type": "model",
            "generator_class": "TestGenerator",
            "weight_groups": [{
                "id": "base",
                "model_sources": [{
                    "id": "base",
                    "provider": "huggingface",
                    "repo_id": "org/base",
                    "destination": ".",
                    "checks": ["base.bin"],
                }],
            }],
            "nodes": [
                {"id": "generate", "weight_groups": ["base"]},
                {
                    "id": "adapter",
                    "weight_groups": ["base"],
                    "model_sources": [{
                        "id": "adapter",
                        "provider": "huggingface",
                        "repo_id": "org/adapter",
                        "destination": ".",
                        "checks": ["adapter.bin"],
                    }],
                },
            ],
        }
        (extension / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        (extension / "generator.py").write_text(
            "\n".join([
                "from services.generators.base import BaseGenerator",
                "class TestGenerator(BaseGenerator):",
                "    def load(self): self._model = object()",
                "    def generate(self, image_bytes, params, progress_cb=None, cancel_event=None):",
                "        return self.outputs_dir / 'result.glb'",
            ]),
            encoding="utf-8",
        )

        self.registry.initialize()
        base_root = self.models_dir / "shared-model" / "_shared" / "base"
        generate = self.registry.get_generator("shared-model/generate")
        adapter = self.registry.get_generator("shared-model/adapter")
        self.assertEqual(generate.shared_model_dirs, {"base": base_root})
        self.assertEqual(adapter.shared_model_dirs, {"base": base_root})
        self.assertEqual(generate.MODEL_ID, "shared-model/generate")
        self.assertEqual(generate.MODEL_NODE_ID, "generate")
        self.assertEqual(adapter.MODEL_ID, "shared-model/adapter")
        self.assertEqual(adapter.MODEL_NODE_ID, "adapter")
        self.assertFalse(self.registry._is_downloaded("shared-model/generate", generate))
        self.assertFalse(self.registry._is_downloaded("shared-model/adapter", adapter))

        base_root.mkdir(parents=True)
        (base_root / "base.bin").write_bytes(b"base")
        self.assertTrue(self.registry._is_downloaded("shared-model/generate", generate))
        self.assertFalse(self.registry._is_downloaded("shared-model/adapter", adapter))

        private_root = self.models_dir / "shared-model" / "adapter"
        private_root.mkdir(parents=True)
        (private_root / "adapter.bin").write_bytes(b"adapter")
        self.assertTrue(self.registry._is_downloaded("shared-model/adapter", adapter))
        relocated = self.root / "relocated-models"
        self.registry.update_paths(relocated, None)
        self.assertEqual(adapter.model_dir, relocated / "shared-model/adapter")
        self.assertEqual(adapter.shared_model_dirs, {"base": relocated / "shared-model/_shared/base"})
        self.assertEqual(adapter.MODEL_NODE_ID, "adapter")
        self.assertFalse(self.registry._is_downloaded("shared-model/adapter", adapter))

    def test_selected_weight_variant_must_be_installed_before_generation(self) -> None:
        def variant(quant: str) -> dict:
            return {
                "id": quant,
                "include_prefixes": [f"dit_{quant}.gguf"],
                "checks": [f"dit_{quant}.gguf"],
            }

        extension = self._make_extension("quantized")
        manifest = {
            "id": "quantized",
            "name": "quantized",
            "type": "model",
            "generator_class": "TestGenerator",
            "params_schema": [
                {"id": "quant", "type": "select", "options": [{"value": "Q4"}, {"value": "Q5"}]}
            ],
            "nodes": [{
                "id": "generate",
                "hf_repo": "org/model-gguf",
                "download_check": "pipeline.json",
                "weight_variants": {
                    "param": "quant",
                    "default": "Q5",
                    "options": [variant("Q4"), variant("Q5")],
                },
            }],
        }
        (extension / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        (extension / "generator.py").write_text(
            "\n".join([
                "from services.generators.base import BaseGenerator",
                "class TestGenerator(BaseGenerator):",
                "    def is_downloaded(self): return True",
                "    def load(self): self._model = object()",
                "    def generate(self, image_bytes, params, progress_cb=None, cancel_event=None):",
                "        return self.outputs_dir / 'result.glb'",
            ]),
            encoding="utf-8",
        )

        self.registry.initialize()
        manifest_variants = self.registry.get_manifest("quantized/generate")["weight_variants"]
        self.assertEqual([option["id"] for option in manifest_variants["options"]], ["Q4", "Q5"])

        model_root = self.models_dir / "quantized" / "generate"
        model_root.mkdir(parents=True)
        (model_root / "dit_Q5.gguf").write_bytes(b"q5")
        # The job's model is checked, not whichever model is still active: the
        # switch to the job's model only happens once the job starts running.
        self.registry._active_id = "other/generate"
        model_id = "quantized/generate"
        self.registry.assert_weight_variant_installed({}, model_id)
        self.registry.assert_weight_variant_installed({"quant": "Q5"}, model_id)
        self.registry.assert_weight_variant_installed({"quant": "fp16"}, model_id)
        with self.assertRaisesRegex(RuntimeError, "Q4 weights for quantized/generate are not installed"):
            self.registry.assert_weight_variant_installed({"quant": "Q4"}, model_id)

        # Without an explicit model id the active one is used (legacy callers).
        self.registry._active_id = model_id
        with self.assertRaisesRegex(RuntimeError, "Q4 weights"):
            self.registry.assert_weight_variant_installed({"quant": "Q4"})


    def test_activate_ready_generator_switches_before_loading_exact_model(self) -> None:
        class Generator:
            DISPLAY_NAME = "test"
            def __init__(self):
                self.loaded = False
                self.unloads = 0
            def is_downloaded(self): return True
            def is_loaded(self): return self.loaded
            def load(self): self.loaded = True
            def unload(self):
                self.loaded = False
                self.unloads += 1

        first = Generator()
        second = Generator()
        first.loaded = True
        self.registry._generators = {"demo/a": first, "demo/b": second}
        self.registry._manifests = {
            "demo/a": {"name": "A"},
            "demo/b": {"name": "B"},
        }
        self.registry._active_id = "demo/a"

        selected = self.registry.activate_ready_generator("demo/b")

        self.assertIs(selected, second)
        self.assertEqual(self.registry._active_id, "demo/b")
        self.assertFalse(first.loaded)
        self.assertEqual(first.unloads, 1)
        self.assertTrue(second.loaded)

    def test_reload_preserves_legacy_path_owned_by_the_host(self) -> None:
        extension = self._make_extension("host-owned-path")
        self._write_manifest(extension, extension_id="host-owned-path")
        (extension / "generator.py").write_text(
            "\n".join(
                [
                    "from services.generators.base import BaseGenerator",
                    "class TestGenerator(BaseGenerator):",
                    "    def load(self): pass",
                    "    def generate(self, image_bytes, params, progress_cb=None, cancel_event=None):",
                    "        return self.outputs_dir / 'result.glb'",
                ]
            ),
            encoding="utf-8",
        )
        host_path = str(extension.resolve())
        sys.path.insert(0, host_path)
        try:
            self.registry.initialize()
            registry_module.EXTENSIONS_DIR = self.root / "empty-host-owned"
            registry_module.EXTENSIONS_DIR.mkdir()
            self.registry.reload()
            self.assertIn(host_path, sys.path)
        finally:
            sys.path.remove(host_path)

    def test_reload_stops_subprocess_runtime_instead_of_only_unloading_model(self) -> None:
        process = ExtensionProcess(
            self.extensions_dir / "subprocess-runtime",
            {"id": "subprocess-runtime"},
        )
        calls: list[str] = []
        process.stop = lambda: calls.append("stop")  # type: ignore[method-assign]
        process.unload = lambda: calls.append("unload")  # type: ignore[method-assign]
        self.registry._generators["subprocess-runtime/generate"] = process

        self.registry.reload()

        self.assertEqual(calls, ["stop"])

    def test_reload_evicts_owned_helper_modules_and_reads_updated_source(self) -> None:
        extension = self._make_extension("reload-helper")
        self._write_manifest(extension, extension_id="reload-helper")
        helper_path = extension / "reload_owned_helper.py"
        helper_path.write_text("VALUE = 1\n", encoding="utf-8")
        (extension / "generator.py").write_text(
            "\n".join(
                [
                    "from services.generators.base import BaseGenerator",
                    "class TestGenerator(BaseGenerator):",
                    "    def load(self): pass",
                    "    def generate(self, image_bytes, params, progress_cb=None, cancel_event=None):",
                    "        return self.outputs_dir / 'result.glb'",
                    "    def helper_value(self):",
                    "        import reload_owned_helper",
                    "        return reload_owned_helper.VALUE",
                ]
            ),
            encoding="utf-8",
        )

        self.registry.initialize()
        self.assertEqual(
            self.registry.get_generator("reload-helper/generate").helper_value(),
            1,
        )

        # Same-size edit in the same timestamp window exercises stale .pyc and
        # sys.modules eviction rather than relying on filesystem mtime changes.
        helper_path.write_text("VALUE = 2\n", encoding="utf-8")
        self.registry.reload()

        self.assertEqual(
            self.registry.get_generator("reload-helper/generate").helper_value(),
            2,
        )
        self.assertNotIn("reload_owned_helper", sys.modules)

    def test_legacy_extensions_with_same_helper_name_remain_isolated(self) -> None:
        for extension_id, value in (("collision-a", "alpha"), ("collision-b", "beta")):
            extension = self._make_extension(extension_id)
            self._write_manifest(extension, extension_id=extension_id)
            (extension / "shared_collision_helper.py").write_text(
                f"VALUE = {value!r}\n",
                encoding="utf-8",
            )
            (extension / "generator.py").write_text(
                "\n".join(
                    [
                        "from services.generators.base import BaseGenerator",
                        "class TestGenerator(BaseGenerator):",
                        "    def load(self): pass",
                        "    def generate(self, image_bytes, params, progress_cb=None, cancel_event=None):",
                        "        return self.outputs_dir / 'result.glb'",
                        "    def helper_value(self):",
                        "        import shared_collision_helper",
                        "        return shared_collision_helper.VALUE",
                    ]
                ),
                encoding="utf-8",
            )

        self.registry.initialize()
        first = self.registry.get_generator("collision-a/generate")
        second = self.registry.get_generator("collision-b/generate")

        self.assertEqual(first.helper_value(), "alpha")
        self.assertEqual(second.helper_value(), "beta")
        self.assertEqual(first.helper_value(), "alpha")
        self.assertNotIn("shared_collision_helper", sys.modules)
        with self.assertRaises(ModuleNotFoundError):
            importlib.import_module("shared_collision_helper")

    def test_setup_script_without_platform_venv_surfaces_repair_error_per_node(self) -> None:
        extension = self._make_extension("needs-setup")
        self._write_manifest(
            extension,
            extension_id="needs-setup",
            node_ids=("fast", "quality"),
        )
        (extension / "setup.py").write_text("raise SystemExit('must not run in registry')\n", encoding="utf-8")
        (extension / "generator.py").write_text(
            "raise AssertionError('generator.py must not be imported before setup')\n",
            encoding="utf-8",
        )

        self.registry.initialize()

        self.assertEqual(self.registry._generators, {})
        errors = self.registry.load_errors()
        self.assertEqual(set(errors), {"needs-setup/fast", "needs-setup/quality"})
        self.assertTrue(all("Repair" in message and "venv not found" in message for message in errors.values()))

    def test_discovery_failures_remain_visible_under_actionable_keys(self) -> None:
        missing_manifest = self._make_extension("missing-manifest")
        (missing_manifest / "generator.py").write_text("", encoding="utf-8")

        invalid_manifest = self._make_extension("invalid-manifest")
        (invalid_manifest / "manifest.json").write_text("{invalid", encoding="utf-8")

        non_object_manifest = self._make_extension("non-object-manifest")
        (non_object_manifest / "manifest.json").write_text("[]", encoding="utf-8")

        missing_generator = self._make_extension("missing-generator")
        self._write_manifest(missing_generator, extension_id="missing-generator")

        import_failure = self._make_extension("import-failure")
        self._write_manifest(import_failure, extension_id="import-failure")
        (import_failure / "generator.py").write_text(
            "raise RuntimeError('intentional discovery failure')\n",
            encoding="utf-8",
        )

        class_failure = self._make_extension("class-failure")
        self._write_manifest(class_failure, extension_id="class-failure")
        (class_failure / "generator.py").write_text(
            "class DifferentGenerator:\n    pass\n",
            encoding="utf-8",
        )

        self.registry.initialize()

        errors = self.registry.load_errors()
        self.assertIn("missing-manifest", errors)
        self.assertIn("invalid-manifest", errors)
        self.assertIn("non-object-manifest", errors)
        self.assertIn("missing-generator/generate", errors)
        self.assertIn("import-failure/generate", errors)
        self.assertIn("class-failure/generate", errors)
        self.assertIn("missing manifest.json", errors["missing-manifest"])
        self.assertIn("invalid manifest.json", errors["invalid-manifest"])
        self.assertIn("expected an object", errors["non-object-manifest"])
        self.assertIn("missing generator.py", errors["missing-generator/generate"])
        self.assertIn("intentional discovery failure", errors["import-failure/generate"])
        self.assertIn("TestGenerator", errors["class-failure/generate"])

    def test_incomplete_model_install_is_reported_for_each_node(self) -> None:
        extension = self._make_extension("interrupted")
        self._write_manifest(extension, extension_id="interrupted", node_ids=("one", "two"))
        (extension / "generator.py").write_text("", encoding="utf-8")
        (extension / ".modly-incomplete").write_text("installing", encoding="utf-8")

        self.registry.initialize()

        errors = self.registry.load_errors()
        self.assertEqual(set(errors), {"interrupted/one", "interrupted/two"})
        self.assertTrue(all("incomplete installation" in message for message in errors.values()))

    def test_pending_registration_is_not_loaded_when_startup_restore_cannot_finish(self) -> None:
        extension = self._make_extension("pending-registration")
        self._write_manifest(extension, extension_id="pending-registration")
        (extension / "generator.py").write_text(
            "class TestGenerator:\n"
            "    def __init__(self, *args, **kwargs):\n"
            "        raise AssertionError('pending extension must not be loaded')\n",
            encoding="utf-8",
        )
        (self.extensions_dir / ".modly-registration-pending-pending-registration-100").write_text(
            "validating",
            encoding="utf-8",
        )

        self.registry.initialize()

        errors = self.registry.load_errors()
        self.assertEqual(set(errors), {"pending-registration/generate"})
        self.assertIn("interrupted runtime registration", next(iter(errors.values())))

    def test_pending_sidecar_blocks_generators_that_were_already_loaded(self) -> None:
        extension = self._make_extension("live-before-repair")
        self._write_manifest(extension, extension_id="live-before-repair")
        (extension / "generator.py").write_text(
            "\n".join(
                [
                    "from services.generators.base import BaseGenerator",
                    "class TestGenerator(BaseGenerator):",
                    "    def load(self): pass",
                    "    def generate(self, image_bytes, params, progress_cb=None, cancel_event=None):",
                    "        return self.outputs_dir / 'result.glb'",
                ]
            ),
            encoding="utf-8",
        )
        self.registry.initialize()
        model_id = "live-before-repair/generate"
        self.assertIn(model_id, self.registry._generators)

        self._write_registration_capability("live-before-repair")

        with self.assertRaisesRegex(ValueError, "pending runtime registration"):
            self.registry.get_generator(model_id)
        with self.assertRaisesRegex(ValueError, "pending runtime registration"):
            self.registry.switch_model(model_id)
        with self.assertRaisesRegex(ValueError, "pending runtime registration"):
            self.registry.get_active()

    def test_valid_capability_authorizes_exact_pending_extension_once(self) -> None:
        capability = self._make_loadable_pending_extension("pending-update")

        self.registry.reload(capability)
        self.assertIn("pending-update/generate", self.registry._generators)
        self.assertEqual(self.registry.load_errors(), {})
        consumed = json.loads(
            (self.extensions_dir / capability["stateName"]).read_text(encoding="utf-8")
        )
        self.assertEqual(
            consumed,
            {
                "version": 1,
                "extensionId": "pending-update",
                "destinationName": "pending-update",
                "consumed": True,
            },
        )

        self.registry.reload(capability)
        self.assertNotIn("pending-update/generate", self.registry._generators)
        self.assertIn("pending-update/generate", self.registry.load_errors())

    @unittest.skipUnless(sys.platform == "win32", "8.3 short paths are Windows-only")
    def test_valid_capability_authorizes_extension_under_a_short_path(self) -> None:
        # GitHub's Windows runners use an 8.3 TEMP (C:\Users\RUNNER~1\...): the
        # capability destination is resolved (long form) while discovery walks
        # the configured, short-form EXTENSIONS_DIR.
        import ctypes

        capability = self._make_loadable_pending_extension("pending-short")
        buffer = ctypes.create_unicode_buffer(32768)
        if not ctypes.windll.kernel32.GetShortPathNameW(str(self.extensions_dir), buffer, len(buffer)):
            self.skipTest("short path unavailable")
        short_dir = Path(buffer.value)
        if str(short_dir) == str(self.extensions_dir):
            self.skipTest("8.3 names are disabled on this volume")
        registry_module.EXTENSIONS_DIR = short_dir

        self.registry.reload(capability)

        self.assertIn("pending-short/generate", self.registry._generators)
        self.assertEqual(self.registry.load_errors(), {})

    def test_public_reload_and_predictable_id_cannot_bypass_pending_state(self) -> None:
        self._make_loadable_pending_extension("pending-public")

        self.registry.reload()
        self.assertNotIn("pending-public/generate", self.registry._generators)
        self.assertIn("pending-public/generate", self.registry.load_errors())

        self.registry.reload({"validatingExtensionId": "pending-public"})
        self.assertNotIn("pending-public/generate", self.registry._generators)
        self.assertIn("pending-public/generate", self.registry.load_errors())

    def test_wrong_capability_token_cannot_bypass_pending_state(self) -> None:
        capability = self._make_loadable_pending_extension("pending-token")
        capability["token"] = "x" * 43

        self.registry.reload(capability)

        self.assertNotIn("pending-token/generate", self.registry._generators)
        self.assertIn("pending-token/generate", self.registry.load_errors())

    def test_capability_id_and_sidecar_path_must_match(self) -> None:
        capability = self._make_loadable_pending_extension("pending-path")
        capability["extensionId"] = "another-extension"

        self.registry.reload(capability)

        self.assertNotIn("pending-path/generate", self.registry._generators)
        self.assertIn("pending-path/generate", self.registry.load_errors())

    def test_capability_destination_folder_must_match(self) -> None:
        capability = self._make_loadable_pending_extension("pending-destination")
        capability["destinationName"] = "another-extension"

        self.registry.reload(capability)

        self.assertNotIn("pending-destination/generate", self.registry._generators)
        self.assertIn("pending-destination/generate", self.registry.load_errors())

    def test_authorization_rejects_duplicate_folder_declaring_same_manifest_id(self) -> None:
        capability = self._make_loadable_pending_extension("pixal3d")
        duplicate = self._make_extension("zzz-duplicate")
        self._write_manifest(duplicate, extension_id="pixal3d")
        (duplicate / "generator.py").write_text(
            "raise AssertionError('mismatched folder must not be imported')\n",
            encoding="utf-8",
        )

        self.registry.reload(capability)

        self.assertIn("pixal3d/generate", self.registry._generators)
        self.assertIn("zzz-duplicate", self.registry.load_errors())
        self.assertIn("must match", self.registry.load_errors()["zzz-duplicate"])

    @unittest.skipIf(os.name == "nt", "POSIX mode bits are not enforced on Windows")
    def test_capability_sidecar_with_group_or_other_permissions_is_rejected(self) -> None:
        capability = self._make_loadable_pending_extension("pending-mode")
        state_path = self.extensions_dir / capability["stateName"]
        state_path.chmod(0o644)

        self.registry.reload(capability)

        self.assertNotIn("pending-mode/generate", self.registry._generators)
        self.assertIn("pending-mode/generate", self.registry.load_errors())

    def test_hard_linked_capability_sidecar_is_rejected(self) -> None:
        capability = self._make_loadable_pending_extension("pending-hardlink")
        state_path = self.extensions_dir / capability["stateName"]
        os.link(state_path, self.extensions_dir / "capability-hardlink-copy")

        self.registry.reload(capability)

        self.assertNotIn("pending-hardlink/generate", self.registry._generators)
        self.assertIn("pending-hardlink/generate", self.registry.load_errors())

    @unittest.skipIf(os.name == "nt", "symlink creation may require privileges on Windows")
    def test_symlinked_capability_sidecar_is_rejected(self) -> None:
        capability = self._make_loadable_pending_extension("pending-symlink")
        state_path = self.extensions_dir / capability["stateName"]
        target = self.extensions_dir / "capability-symlink-target"
        state_path.rename(target)
        state_path.symlink_to(target)

        self.registry.reload(capability)

        self.assertNotIn("pending-symlink/generate", self.registry._generators)
        self.assertIn("pending-symlink/generate", self.registry.load_errors())

    def test_process_extension_is_skipped_without_model_errors(self) -> None:
        extension = self._make_extension("process-only")
        self._write_manifest(
            extension,
            extension_id="process-only",
            extension_type="process",
        )
        (extension / "processor.py").write_text("print('ok')\n", encoding="utf-8")
        (extension / ".modly-incomplete").write_text("installing", encoding="utf-8")

        self.registry.initialize()

        self.assertEqual(self.registry._generators, {})
        self.assertEqual(self.registry.load_errors(), {})


class _StatusOnlyGenerator:
    DISPLAY_NAME = "Fake"
    VRAM_GB = 1

    def is_downloaded(self) -> bool:
        return True

    def is_loaded(self) -> bool:
        return False

    def params_schema(self) -> list:
        return [{"id": "steps"}]


class _DirectGenerator:
    def __init__(self, sticky: bool = False) -> None:
        self.loaded = True
        self.sticky = sticky

    def unload(self) -> None:
        if not self.sticky:
            self.loaded = False

    def is_loaded(self) -> bool:
        return self.loaded


class GeneratorRegistryUnloadTests(unittest.TestCase):
    def test_unload_all_unloads_every_model_before_reporting_a_stuck_one(self):
        registry = GeneratorRegistry()
        stuck = _DirectGenerator(sticky=True)
        other = _DirectGenerator()
        registry._generators = {"demo/stuck": stuck, "demo/other": other}

        with self.assertRaisesRegex(RuntimeError, "demo/stuck"):
            registry.unload_all()

        self.assertFalse(other.loaded)


class GeneratorRegistryLockTests(unittest.TestCase):
    def test_status_reads_do_not_wait_for_an_in_progress_load(self):
        # A load holds the lifecycle lock for its whole duration (first-run
        # downloads included); status endpoints must keep answering meanwhile.
        registry = GeneratorRegistry()
        registry._generators["demo/generate"] = _StatusOnlyGenerator()
        registry._manifests["demo/generate"] = {"name": "Demo"}
        registry._active_id = "demo/generate"

        lock_held = threading.Event()
        release = threading.Event()

        def hold_lock() -> None:
            with registry._lifecycle_lock:
                lock_held.set()
                release.wait(5)

        holder = threading.Thread(target=hold_lock)
        holder.start()
        self.addCleanup(holder.join)
        self.addCleanup(release.set)
        self.assertTrue(lock_held.wait(5))

        results = {}

        def read_status() -> None:
            results["active"] = registry.active_status()
            results["all"] = registry.all_status()
            results["params"] = registry.params_schema("demo/generate")
            results["model"] = registry.model_status("demo/generate")

        reader = threading.Thread(target=read_status)
        reader.start()
        reader.join(2)

        self.assertFalse(reader.is_alive(), "status reads blocked on the lifecycle lock")
        self.assertEqual(results["active"]["id"], "demo/generate")
        self.assertEqual([m["id"] for m in results["all"]], ["demo/generate"])
        self.assertEqual(results["params"], [{"id": "steps"}])
        self.assertFalse(results["model"]["loaded"])


if __name__ == "__main__":
    unittest.main()

import json
import importlib
import inspect
import os
import sys
import tempfile
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


if __name__ == "__main__":
    unittest.main()

import unittest
import os
import io
import sys
import json
import tempfile
import importlib
from contextlib import redirect_stdout
from pathlib import Path


_tmp_ext_dir = tempfile.mkdtemp(prefix="modly-runner-test-")
Path(_tmp_ext_dir, "manifest.json").write_text("{}", encoding="utf-8")
os.environ.setdefault("EXTENSION_DIR", _tmp_ext_dir)

runner = importlib.import_module("runner")
_apply_manifest_metadata = runner._apply_manifest_metadata
_resolve_ready_schema = runner._resolve_ready_schema
_select_node = runner._select_node


class RunnerTests(unittest.TestCase):
    def test_select_node_uses_model_dir_override(self) -> None:
        manifest = {
            "nodes": [
                {"id": "fast", "params_schema": [{"id": "a"}]},
                {"id": "quality", "params_schema": [{"id": "b"}]},
            ]
        }

        node = _select_node(manifest, str(Path("/tmp/ext/quality")))

        self.assertEqual(node["id"], "quality")

    def test_ready_schema_falls_back_to_selected_node_schema(self) -> None:
        class GenClass:
            @classmethod
            def params_schema(cls):
                raise RuntimeError("not available")

        manifest = {"params_schema": [{"id": "manifest"}]}
        node = {"params_schema": [{"id": "node"}]}

        schema = _resolve_ready_schema(GenClass, node, manifest)

        self.assertEqual(schema, [{"id": "node"}])

    def test_apply_manifest_metadata_prefers_node_specific_values(self) -> None:
        gen = type("Gen", (), {})()
        manifest = {
            "hf_repo": "top/repo",
            "hf_skip_prefixes": ["top/"],
            "download_check": "top/file",
            "params_schema": [{"id": "top"}],
        }
        node = {
            "hf_repo": "node/repo",
            "hf_skip_prefixes": ["node/"],
            "download_check": "node/file",
            "params_schema": [{"id": "node"}],
        }

        _apply_manifest_metadata(gen, manifest, node)

        self.assertEqual(gen.hf_repo, "node/repo")
        self.assertEqual(gen.hf_skip_prefixes, ["node/"])
        self.assertEqual(gen.download_check, "node/file")
        self.assertEqual(gen._params_schema, [{"id": "node"}])

    def test_apply_manifest_metadata_falls_back_to_manifest_when_node_empty(self) -> None:
        gen = type("Gen", (), {})()
        manifest = {
            "hf_repo": "top/repo",
            "hf_skip_prefixes": ["top/"],
            "download_check": "top/file",
            "params_schema": [{"id": "top"}],
        }

        _apply_manifest_metadata(gen, manifest, {})

        self.assertEqual(gen.hf_repo, "top/repo")
        self.assertEqual(gen.hf_skip_prefixes, ["top/"])
        self.assertEqual(gen.download_check, "top/file")
        self.assertEqual(gen._params_schema, [{"id": "top"}])


class SelectNodeTests(unittest.TestCase):
    def test_returns_empty_dict_when_manifest_has_no_nodes(self) -> None:
        self.assertEqual(_select_node({}, ""), {})

    def test_falls_back_to_first_node_when_override_matches_nothing(self) -> None:
        manifest = {"nodes": [{"id": "a"}, {"id": "b"}]}
        self.assertEqual(_select_node(manifest, str(Path("/tmp/ext/zzz")))["id"], "a")

    def test_returns_first_node_when_no_override(self) -> None:
        manifest = {"nodes": [{"id": "a"}, {"id": "b"}]}
        self.assertEqual(_select_node(manifest, "")["id"], "a")


class ResolveReadySchemaTests(unittest.TestCase):
    def test_uses_generator_classmethod_when_available(self) -> None:
        class GenClass:
            @classmethod
            def params_schema(cls):
                return [{"id": "from-class"}]

        schema = _resolve_ready_schema(GenClass, {"params_schema": [{"id": "node"}]}, {})
        self.assertEqual(schema, [{"id": "from-class"}])

    def test_falls_back_to_manifest_when_node_has_no_schema(self) -> None:
        class GenClass:
            @classmethod
            def params_schema(cls):
                raise RuntimeError("unavailable")

        schema = _resolve_ready_schema(GenClass, {}, {"params_schema": [{"id": "manifest"}]})
        self.assertEqual(schema, [{"id": "manifest"}])


class ProtocolTests(unittest.TestCase):
    """recv()/send() implement the newline-delimited JSON wire protocol."""

    def setUp(self) -> None:
        self._stdin = sys.stdin

    def tearDown(self) -> None:
        sys.stdin = self._stdin

    def test_recv_parses_lines_and_skips_blank_lines(self) -> None:
        sys.stdin = io.StringIO('{"a": 1}\n\n   \n{"b": 2}\n')
        self.assertEqual(list(runner.recv()), [{"a": 1}, {"b": 2}])

    def test_recv_skips_invalid_json_without_crashing_and_logs_error(self) -> None:
        sys.stdin = io.StringIO('not json\n{"ok": 1}\n')
        out = io.StringIO()
        with redirect_stdout(out):
            messages = list(runner.recv())

        self.assertEqual(messages, [{"ok": 1}])
        logged = [json.loads(line) for line in out.getvalue().splitlines() if line.strip()]
        self.assertTrue(any(
            entry.get("level") == "error" and "invalid JSON" in entry.get("message", "")
            for entry in logged
        ))

    def test_send_writes_single_json_line(self) -> None:
        out = io.StringIO()
        with redirect_stdout(out):
            runner.send({"type": "ready", "params_schema": []})

        written = out.getvalue()
        self.assertTrue(written.endswith("\n"))
        self.assertEqual(written.count("\n"), 1)
        self.assertEqual(json.loads(written), {"type": "ready", "params_schema": []})


_FAKE_TEXGEN_GENERATOR = '''
from pathlib import Path

INSTANCES = []


class FakeTexGen:
    """
    Mimics an extension whose texture pipeline is built lazily on first use and
    frees the shape pipeline first to make room for it.

    The first texture setup fails (missing `xatlas`), which is what issue #239
    reports; a later attempt succeeds once the dependency is available.
    """

    def __init__(self, model_dir, outputs_dir):
        self.model_dir = model_dir
        self.outputs_dir = outputs_dir
        self._model = None
        self.load_calls = 0
        self.texgen_attempts = 0
        INSTANCES.append(self)

    def is_loaded(self):
        return self._model is not None

    def load(self):
        self.load_calls += 1
        self._model = lambda image: "mesh"

    def unload(self):
        self._model = None

    def _setup_texgen(self):
        # Free the shape pipeline before building the texture pipeline.
        self._model = None
        self.texgen_attempts += 1
        if self.texgen_attempts == 1:
            raise RuntimeError("No module named 'xatlas'")
        # Texture setup succeeded: shape pipeline comes back.
        self.load()

    def generate(self, image_bytes, params, progress_cb=None, cancel_event=None):
        # Stands in for `self._model(image)` on a generator whose model is gone.
        if self._model is None:
            raise TypeError("'NoneType' object is not callable")
        self._model(image_bytes)
        if params.get("enable_texture"):
            self._setup_texgen()
        return Path("out.glb")
'''


class _RunnerDriver:
    """Runs runner.main() against a throwaway extension dir."""

    def __init__(self, generator_src: str, generator_class: str) -> None:
        self.ext_dir = Path(tempfile.mkdtemp(prefix="modly-texgen-test-"))
        (self.ext_dir / "generator.py").write_text(generator_src, encoding="utf-8")
        (self.ext_dir / "manifest.json").write_text(
            json.dumps({"id": "demo-ext", "generator_class": generator_class}),
            encoding="utf-8",
        )

    def run(self, actions: list) -> list:
        """Feeds actions on stdin, returns the parsed messages runner emitted."""
        original_ext_dir = runner.EXT_DIR
        original_stdin = sys.stdin
        original_module = sys.modules.pop("generator", None)
        runner.EXT_DIR = self.ext_dir
        sys.stdin = io.StringIO("".join(json.dumps(a) + "\n" for a in actions))
        out = io.StringIO()
        try:
            with redirect_stdout(out):
                runner.main()
            self.generator_module = sys.modules["generator"]
        finally:
            runner.EXT_DIR = original_ext_dir
            sys.stdin = original_stdin
            sys.modules.pop("generator", None)
            if original_module is not None:
                sys.modules["generator"] = original_module
        return [json.loads(line) for line in out.getvalue().splitlines() if line.strip()]


class GeneratorLoadedStateTests(unittest.TestCase):
    def test_reports_loaded_state(self) -> None:
        gen = type("Gen", (), {"is_loaded": lambda self: True})()
        self.assertTrue(runner._generator_is_loaded(gen))

    def test_treats_raising_is_loaded_as_not_loaded(self) -> None:
        class Gen:
            def is_loaded(self):
                raise RuntimeError("half-initialised")

        self.assertFalse(runner._generator_is_loaded(Gen()))

    def test_ensure_model_loaded_is_a_noop_when_already_loaded(self) -> None:
        class Gen:
            load_calls = 0

            def is_loaded(self):
                return True

            def load(self):
                self.load_calls += 1

        gen = Gen()
        self.assertFalse(runner._ensure_model_loaded(gen))
        self.assertEqual(gen.load_calls, 0)

    def test_ensure_model_loaded_reloads_when_model_is_gone(self) -> None:
        class Gen:
            def __init__(self):
                self._model = None
                self.load_calls = 0

            def is_loaded(self):
                return self._model is not None

            def load(self):
                self.load_calls += 1
                self._model = object()

        gen = Gen()
        self.assertTrue(runner._ensure_model_loaded(gen))
        self.assertEqual(gen.load_calls, 1)
        self.assertIsNotNone(gen._model)


class TextureSetupRecoveryTests(unittest.TestCase):
    """
    Regression tests for issue #239: a failed lazy texture setup left the worker
    with _model = None and no recovery path, so every later generation raised
    "TypeError: 'NoneType' object is not callable" until the process was killed.
    """

    def setUp(self) -> None:
        self.driver = _RunnerDriver(_FAKE_TEXGEN_GENERATOR, "FakeTexGen")
        self.texture_run = {
            "action": "generate",
            "image_b64": "",
            "params": {"enable_texture": True},
        }

    def test_worker_recovers_after_failed_texture_setup(self) -> None:
        messages = self.driver.run([
            {"action": "load"},
            dict(self.texture_run, id="run-1"),
            dict(self.texture_run, id="run-2"),
        ])

        by_id = {m.get("id"): m for m in messages if m.get("type") in ("done", "error")}

        # First run fails during texture setup and surfaces the real cause.
        self.assertEqual(by_id["run-1"]["type"], "error")
        self.assertIn("xatlas", by_id["run-1"]["message"])

        # The retry must succeed instead of dying on a None model.
        self.assertEqual(
            by_id["run-2"]["type"], "done",
            msg=f"retry did not recover: {by_id['run-2']}",
        )
        self.assertNotIn("NoneType", json.dumps(by_id["run-2"]))

        # …and the worker's model is genuinely back.
        gen = self.driver.generator_module.INSTANCES[0]
        self.assertIsNotNone(gen._model)
        self.assertTrue(gen.is_loaded())

    def test_failed_run_reports_that_the_model_was_lost(self) -> None:
        messages = self.driver.run([
            {"action": "load"},
            dict(self.texture_run, id="run-1"),
        ])

        error = next(m for m in messages if m.get("type") == "error")
        self.assertIs(error["loaded"], False)

    def test_reload_before_generate_is_logged(self) -> None:
        messages = self.driver.run([
            {"action": "load"},
            dict(self.texture_run, id="run-1"),
            dict(self.texture_run, id="run-2"),
        ])

        logs = [m for m in messages if m.get("type") == "log"]
        self.assertTrue(
            any("reloaded before generating" in m.get("message", "") for m in logs),
            msg=f"expected a reload log, got {logs}",
        )

    def test_successful_run_does_not_reload_the_model(self) -> None:
        messages = self.driver.run([
            {"action": "load"},
            {"action": "generate", "id": "run-1", "image_b64": "", "params": {}},
        ])

        self.assertEqual(
            [m["type"] for m in messages if m.get("id") == "run-1"], ["done"]
        )
        self.assertEqual(self.driver.generator_module.INSTANCES[0].load_calls, 1)


if __name__ == "__main__":
    unittest.main()

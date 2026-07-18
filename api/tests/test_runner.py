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


if __name__ == "__main__":
    unittest.main()

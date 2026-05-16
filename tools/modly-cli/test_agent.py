#!/usr/bin/env python3
"""Unit tests for the stdlib-only Modly agent CLI."""
from __future__ import annotations

import importlib.util
import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

MODULE_PATH = Path(__file__).with_name("agent.py")
SPEC = importlib.util.spec_from_file_location("modly_agent", MODULE_PATH)
agent = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(agent)


class OutputTests(unittest.TestCase):
    def test_compact_json_is_one_line(self) -> None:
        buf = io.StringIO()
        with redirect_stdout(buf):
            agent._json_print({"ok": True, "nested": {"x": 1}}, compact=True)
        self.assertEqual(buf.getvalue(), '{"nested":{"x":1},"ok":true}\n')


class CommandTests(unittest.TestCase):
    def test_status_combines_health_and_model(self) -> None:
        calls: list[tuple[str, str]] = []

        def fake_request(method: str, url: str, *, timeout: float, **_: object) -> object:
            calls.append((method, url))
            if url.endswith("/health"):
                return {"status": "ok"}
            if url.endswith("/model/status"):
                return {"id": "sf3d", "loaded": True}
            raise AssertionError(url)

        args = SimpleNamespace(base_url="http://example.test/", request_timeout=1, compact=True)
        buf = io.StringIO()
        with patch.object(agent, "_request_json", fake_request), redirect_stdout(buf):
            self.assertEqual(agent.cmd_status(args), 0)
        payload = json.loads(buf.getvalue())
        self.assertEqual(payload["health"], {"status": "ok"})
        self.assertEqual(payload["model"]["id"], "sf3d")
        self.assertEqual(calls, [("GET", "http://example.test/health"), ("GET", "http://example.test/model/status")])

    def test_params_auto_resolves_model_id(self) -> None:
        def fake_request(method: str, url: str, *, timeout: float, **_: object) -> object:
            if url.endswith("/model/all"):
                return [{"id": "sf3d/generate", "name": "Generate", "active": False}]
            if url.endswith("/model/params?model_id=sf3d%2Fgenerate"):
                return [{"name": "foreground_ratio"}]
            raise AssertionError(url)

        args = SimpleNamespace(base_url="http://example.test", request_timeout=1, model="auto", compact=False)
        buf = io.StringIO()
        with patch.object(agent, "_request_json", fake_request), redirect_stdout(buf):
            self.assertEqual(agent.cmd_params(args), 0)
        payload = json.loads(buf.getvalue())
        self.assertEqual(payload["model_id"], "sf3d/generate")
        self.assertEqual(payload["params"][0]["name"], "foreground_ratio")

    def test_export_downloads_workspace_path(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "mesh.glb"
            args = SimpleNamespace(base_url="http://example.test", request_timeout=1, path="Agent/foo.glb", output=str(out), format="glb", compact=True)
            with patch.object(agent, "_download", return_value=123) as download, redirect_stdout(io.StringIO()) as buf:
                self.assertEqual(agent.cmd_export(args), 0)
            download.assert_called_once()
            self.assertIn("/export/glb?path=Agent%2Ffoo.glb", download.call_args.args[0])
            self.assertEqual(json.loads(buf.getvalue())["bytes_written"], 123)

    def test_generate_enables_texture_by_default(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            image = Path(td) / "robot.png"
            output = Path(td) / "robot.glb"
            image.write_bytes(b"png")
            args = SimpleNamespace(
                base_url="http://example.test",
                request_timeout=1,
                image=str(image),
                output=str(output),
                format="glb",
                model="sf3d",
                collection="Agent",
                remesh="quad",
                enable_texture=True,
                texture_resolution=1024,
                params_json=None,
                params_file=None,
                timeout=10,
                poll=0,
                progress=False,
                quiet=True,
            )
            bodies: list[bytes] = []

            def fake_request(method: str, url: str, *, timeout: float, data: bytes | None = None, **_: object) -> object:
                if url.endswith("/generate/from-image"):
                    self.assertEqual(method, "POST")
                    assert data is not None
                    bodies.append(data)
                    return {"job_id": "job-1"}
                if url.endswith("/generate/status/job-1"):
                    return {"status": "done", "progress": 100, "output_url": "/workspace/Agent/robot.glb"}
                raise AssertionError(url)

            with patch.object(agent, "_request_json", fake_request), patch.object(agent, "_export_workspace_path", return_value=456), patch.object(agent, "_texture_model_id", return_value=None):
                result = agent._generate_one(args, image, output)
            self.assertFalse(result["texture_enabled"])
            self.assertIn(b'name="enable_texture"\r\n\r\ntrue', bodies[0])

    def test_batch_processes_images_sequentially(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            inputs = root / "inputs"
            outputs = root / "outputs"
            inputs.mkdir()
            (inputs / "b.jpg").write_bytes(b"jpg")
            (inputs / "a.png").write_bytes(b"png")
            (inputs / "ignore.txt").write_text("no")
            args = SimpleNamespace(input_dir=str(inputs), manifest=None, output_dir=str(outputs), format="glb", compact=False, continue_on_error=False)

            def fake_generate(_args: object, image: Path, output: Path | None = None) -> dict[str, object]:
                return {"ok": True, "image": str(image), "export_path": str(output)}

            with patch.object(agent, "_generate_one", fake_generate), redirect_stdout(io.StringIO()) as buf:
                self.assertEqual(agent.cmd_batch(args), 0)
            payload = json.loads(buf.getvalue())
            self.assertEqual(payload["count"], 2)
            self.assertEqual([Path(r["image"]).name for r in payload["results"]], ["a.png", "b.jpg"])

    def test_batch_accepts_manifest_json(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            image = root / "robot.png"
            output = root / "robot.stl"
            manifest = root / "jobs.json"
            image.write_bytes(b"png")
            manifest.write_text(json.dumps({"jobs": [{"image": "robot.png", "output": "robot.stl", "format": "stl"}]}), encoding="utf-8")
            args = SimpleNamespace(input_dir=None, manifest=str(manifest), output_dir=None, format="glb", compact=True, continue_on_error=False)

            def fake_generate(_args: object, image_path: Path, output_path: Path | None = None) -> dict[str, object]:
                self.assertEqual(_args.format, "stl")
                return {"ok": True, "image": str(image_path), "export_path": str(output_path)}

            with patch.object(agent, "_generate_one", fake_generate), redirect_stdout(io.StringIO()) as buf:
                self.assertEqual(agent.cmd_batch(args), 0)
            payload = json.loads(buf.getvalue())
            self.assertEqual(payload["results"][0]["image"], str(image))
            self.assertEqual(payload["results"][0]["export_path"], str(output))


class ComfyWorkflowTests(unittest.TestCase):
    def test_patch_positive_cliptextencode(self) -> None:
        workflow = {
            "1": {"class_type": "CLIPTextEncode", "inputs": {"text": "old prompt", "clip": ["4", 1]}},
            "2": {"class_type": "CLIPTextEncode", "inputs": {"text": "negative", "clip": ["4", 1]}},
        }
        result = agent._patch_comfy_workflow(workflow, prompt="new prompt", seed=42)
        self.assertEqual(result["1"]["inputs"]["text"], "new prompt")
        self.assertEqual(result["2"]["inputs"]["text"], "negative")

    def test_patch_raises_when_no_text_input(self) -> None:
        workflow = {
            "1": {"class_type": "LoadImage", "inputs": {"image": "photo.png"}},
        }
        with self.assertRaises(agent.ModlyCliError):
            agent._patch_comfy_workflow(workflow, prompt="good", seed=None)

    def test_patch_fallback_to_prompt_key(self) -> None:
        workflow = {
            "1": {"class_type": "KSampler", "inputs": {"prompt": "old", "seed": 0}},
        }
        result = agent._patch_comfy_workflow(workflow, prompt="new", seed=99)
        self.assertEqual(result["1"]["inputs"]["prompt"], "new")
        self.assertEqual(result["1"]["inputs"]["seed"], 99)

    def test_patch_seed_noise_seed(self) -> None:
        workflow = {
            "1": {"class_type": "KSampler", "inputs": {"noise_seed": 0, "prompt": "test"}},
        }
        result = agent._patch_comfy_workflow(workflow, prompt=None, seed=7)
        self.assertEqual(result["1"]["inputs"]["noise_seed"], 7)

    def test_rejects_editor_format(self) -> None:
        workflow = {"nodes": [], "links": []}
        with self.assertRaises(agent.ModlyCliError):
            agent._patch_comfy_workflow(workflow, prompt="x", seed=None)

    def test_prompt_wrapper(self) -> None:
        workflow = {"prompt": {"1": {"class_type": "CLIPTextEncode", "inputs": {"text": "old"}}}}
        result = agent._patch_comfy_workflow(workflow, prompt="new", seed=None)
        self.assertEqual(result["1"]["inputs"]["text"], "new")

    def test_deep_copy_no_mutation(self) -> None:
        original = {"1": {"class_type": "CLIPTextEncode", "inputs": {"text": "old"}}}
        agent._patch_comfy_workflow(original, prompt="new", seed=None)
        self.assertEqual(original["1"]["inputs"]["text"], "old")


class ServeConfigTests(unittest.TestCase):
    def test_default_api_dir_checks_all_windows_localappdata_candidates(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = root / "repo"
            repo.mkdir()
            bad_local = root / "Default" / "AppData" / "Local"
            good_api = root / "joshu" / "AppData" / "Local" / "Programs" / "Modly" / "resources" / "api"
            good_api.mkdir(parents=True)
            (good_api / "main.py").write_text("# api", encoding="utf-8")

            with patch.object(agent, "_repo_root", return_value=repo), patch.object(agent, "_windows_env_paths", return_value=[bad_local, good_api.parents[3]]):
                self.assertEqual(agent._default_api_dir(), good_api)

    def test_load_modly_settings_checks_all_windows_appdata_candidates(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            bad_roaming = root / "Default" / "AppData" / "Roaming"
            good_roaming = root / "joshu" / "AppData" / "Roaming"
            settings = good_roaming / "Modly" / "settings.json"
            settings.parent.mkdir(parents=True)
            settings.write_text(json.dumps({"workspaceDir": "C:/workspace"}), encoding="utf-8")

            with patch.object(agent, "_windows_env_paths", return_value=[bad_roaming, good_roaming]):
                self.assertEqual(agent._load_modly_settings()["workspaceDir"], "C:/workspace")

    def test_resolve_serve_config_explicit_paths(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            api_dir = Path(td) / "api"
            api_dir.mkdir()
            (api_dir / "main.py").write_text("# api")
            python = Path(td) / "python.exe"
            python.write_text("# python")
            args = SimpleNamespace(
                api_dir=str(api_dir),
                python=str(python),
                host="0.0.0.0",
                port=9999,
                models_dir=None,
                workspace_dir=None,
                extensions_dir=None,
                model=None,
                hf_token=None,
            )
            _api_dir, _python, env, cmd, base_url = agent._resolve_serve_config(args)
            self.assertEqual(str(_api_dir), str(api_dir.resolve()))
            self.assertEqual(base_url, "http://0.0.0.0:9999")
            self.assertTrue(cmd[0].endswith("python.exe"))
            self.assertIn("PYTHONUNBUFFERED", env)


class ParserTests(unittest.TestCase):
    def test_new_subcommands_parse(self) -> None:
        parser = agent.build_parser()
        cases = [
            ["status"],
            ["params"],
            ["job", "abc"],
            ["cancel", "abc"],
            ["comfy-image"],
            ["generate-from-workflow", "--prompt", "asset", "--output", "asset.glb"],
            ["export", "--path", "Agent/foo.glb", "--output", "foo.glb"],
            ["batch", "--input-dir", "imgs", "--output-dir", "meshes"],
            ["serve", "--print-command"],
            ["ensure-server"],
        ]
        for argv in cases:
            with self.subTest(argv=argv):
                args = parser.parse_args(argv)
                self.assertTrue(callable(args.func))


if __name__ == "__main__":
    unittest.main()

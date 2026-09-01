#!/usr/bin/env python3
"""Unit tests for the stdlib-only Modly agent CLI."""
from __future__ import annotations

import importlib.util
import io
import json
import os
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

    def test_params_auto_uses_validated_active_model_id(self) -> None:
        calls: list[str] = []

        def fake_request(method: str, url: str, *, timeout: float, **_: object) -> object:
            calls.append(url)
            if url.endswith("/health"):
                return {"status": "ok"}
            if url.endswith("/model/status"):
                return {"id": "active-photo", "loaded": True}
            if url.endswith("/model/all"):
                return [
                    {"id": "texture-only/generate", "name": "Misleading Generate Label"},
                    {"id": "active-photo", "name": "Active Photo Model"},
                ]
            if url.endswith("/model/params?model_id=active-photo"):
                return [{"name": "foreground_ratio"}]
            raise AssertionError(url)

        args = SimpleNamespace(base_url="http://example.test", request_timeout=1, model="auto", compact=False)
        buf = io.StringIO()
        with patch.object(agent, "_request_json", fake_request), redirect_stdout(buf):
            self.assertEqual(agent.cmd_params(args), 0)
        payload = json.loads(buf.getvalue())
        self.assertEqual(payload["model_id"], "active-photo")
        self.assertEqual(payload["params"][0]["name"], "foreground_ratio")
        self.assertEqual(calls[:3], ["http://example.test/health", "http://example.test/model/status", "http://example.test/model/all"])

    def test_explicit_model_id_must_exist_in_model_all(self) -> None:
        def fake_request(method: str, url: str, *, timeout: float, **_: object) -> object:
            if url.endswith("/model/all"):
                return [{"id": "sf3d"}]
            raise AssertionError(url)

        args = SimpleNamespace(request_timeout=1, model="missing")
        with patch.object(agent, "_request_json", fake_request):
            with self.assertRaises(agent.ModlyCliError) as ctx:
                agent._resolve_model_id(args, "http://example.test")
        self.assertEqual(ctx.exception.code, "INVALID_MODEL_ID")

    def test_export_downloads_workspace_path(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "mesh.glb"
            args = SimpleNamespace(base_url="http://example.test", request_timeout=1, path="Agent/foo.glb", output=str(out), format="glb", compact=True)
            with patch.object(agent, "_require_health", return_value={"status": "ok"}), patch.object(agent, "_download", return_value=123) as download, redirect_stdout(io.StringIO()) as buf:
                self.assertEqual(agent.cmd_export(args), 0)
            download.assert_called_once()
            self.assertIn("/export/glb?path=Agent%2Ffoo.glb", download.call_args.args[0])
            self.assertEqual(json.loads(buf.getvalue())["bytes_written"], 123)

    def test_export_rejects_unsafe_workspace_paths(self) -> None:
        bad_paths = [
            "../secret.glb",
            "Agent/../secret.glb",
            "/Agent/foo.glb",
            "C:/Agent/foo.glb",
            "C:\\Agent\\foo.glb",
            "\\\\server\\share\\foo.glb",
        ]
        with patch.object(agent, "_download", side_effect=AssertionError("unsafe path should not be downloaded")):
            for bad_path in bad_paths:
                with self.subTest(path=bad_path):
                    with self.assertRaises(agent.ModlyCliError) as ctx:
                        agent._export_workspace_path("http://example.test", bad_path, "glb", Path("out.glb"), timeout=1)
                    self.assertEqual(ctx.exception.code, "INVALID_WORKSPACE_PATH")

    def test_workspace_relative_path_rejects_unsafe_server_output(self) -> None:
        bad_urls = [
            "/workspace/../secret.glb",
            "/workspace/C:/secret.glb",
            "/workspace/Agent/%2E%2E/secret.glb",
            "http://example.test/workspace//absolute.glb",
        ]
        for bad_url in bad_urls:
            with self.subTest(url=bad_url):
                with self.assertRaises(agent.ModlyCliError) as ctx:
                    agent._workspace_relative_path(bad_url)
                self.assertEqual(ctx.exception.code, "INVALID_WORKSPACE_PATH")

    def test_workflow_workspace_path_rejects_unsafe_scene_candidate_path(self) -> None:
        status = {"scene_candidate": {"workspace_path": "Agent/../secret.glb"}}
        with self.assertRaises(agent.ModlyCliError) as ctx:
            agent._workflow_workspace_path(status)
        self.assertEqual(ctx.exception.code, "INVALID_WORKSPACE_PATH")

    def test_generate_uses_workflow_run_and_recovery_metadata(self) -> None:
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
                texture_model="auto",
                texture_params_json=None,
                texture_params_file=None,
                texture_size=2048,
                texture_steps=30,
                texture_guidance=3.0,
                params_json=None,
                params_file=None,
                timeout=10,
                poll=0,
                progress=False,
                quiet=True,
                no_export=False,
            )
            bodies: list[bytes] = []

            def fake_request(method: str, url: str, *, timeout: float, data: bytes | None = None, **_: object) -> object:
                if url.endswith("/health"):
                    return {"status": "ok"}
                if url.endswith("/model/status"):
                    return {"id": "sf3d", "loaded": True}
                if url.endswith("/model/all"):
                    return [{"id": "sf3d"}]
                if url.endswith("/workflow-runs/from-image"):
                    self.assertEqual(method, "POST")
                    assert data is not None
                    bodies.append(data)
                    return {"run_id": "run-1", "status": "pending"}
                if url.endswith("/workflow-runs/run-1"):
                    return {"run_id": "run-1", "status": "done", "progress": 100, "output_url": "/workspace/Default/robot.glb"}
                raise AssertionError(url)

            with patch.object(agent, "_request_json", fake_request), patch.object(agent, "_export_workspace_path", return_value=456):
                result = agent._generate_one(args, image, output)
            self.assertEqual(result["run"], {"kind": "workflowRun", "id": "run-1"})
            self.assertFalse(result["meta"]["legacy"])
            self.assertIn("workflow-run status run-1", result["meta"]["status_command"])
            self.assertEqual(result["workspace_path"], "Default/robot.glb")
            self.assertIn(b'name="model_id"\r\n\r\nsf3d', bodies[0])
            self.assertIn(b'"enable_texture":true', bodies[0])

    def test_workflow_run_status_and_cancel_use_canonical_endpoints(self) -> None:
        calls: list[tuple[str, str]] = []

        def fake_request(method: str, url: str, *, timeout: float, **_: object) -> object:
            calls.append((method, url))
            if url.endswith("/health"):
                return {"status": "ok"}
            if url.endswith("/workflow-runs/run-1"):
                return {"run_id": "run-1", "status": "running"}
            if url.endswith("/workflow-runs/run-1/cancel"):
                return {"cancelled": True}
            raise AssertionError(url)

        status_args = SimpleNamespace(base_url="http://example.test", request_timeout=1, run_id="run-1", compact=True)
        cancel_args = SimpleNamespace(base_url="http://example.test", request_timeout=1, run_id="run-1", compact=True)
        with patch.object(agent, "_request_json", fake_request), redirect_stdout(io.StringIO()) as buf:
            self.assertEqual(agent.cmd_workflow_run_status(status_args), 0)
            self.assertEqual(agent.cmd_workflow_run_cancel(cancel_args), 0)
        outputs = [json.loads(line) for line in buf.getvalue().splitlines()]
        self.assertEqual(outputs[0]["run"], {"kind": "workflowRun", "id": "run-1"})
        self.assertEqual(outputs[1]["cancel"]["cancelled"], True)
        self.assertIn(("GET", "http://example.test/workflow-runs/run-1"), calls)
        self.assertIn(("POST", "http://example.test/workflow-runs/run-1/cancel"), calls)

    def test_capability_and_process_fail_closed_when_contract_is_absent(self) -> None:
        def fake_request(method: str, url: str, *, timeout: float, **_: object) -> object:
            if url.endswith("/health"):
                return {"status": "ok"}
            raise agent.ModlyCliError("missing", code="HTTP_404", http_status=404)

        cap_args = SimpleNamespace(base_url="http://example.test", request_timeout=1, compact=True)
        proc_args = SimpleNamespace(base_url="http://example.test", request_timeout=1, run_id="run-1", compact=True)
        with patch.object(agent, "_request_json", fake_request):
            with self.assertRaises(agent.ModlyCliError) as cap_ctx:
                agent.cmd_capability_list(cap_args)
            with self.assertRaises(agent.ModlyCliError) as proc_ctx:
                agent.cmd_process_run_status(proc_args)
        self.assertEqual(cap_ctx.exception.code, "UNSUPPORTED_PROCESS")
        self.assertEqual(proc_ctx.exception.code, "UNSUPPORTED_PROCESS")

    def test_process_run_start_uses_recovery_meta_with_custom_base_url(self) -> None:
        def fake_request(method: str, url: str, *, timeout: float, **_: object) -> object:
            if url.endswith("/health"):
                return {"status": "ok"}
            if url.endswith("/process-runs"):
                return {"run_id": "proc-1", "status": "queued"}
            raise AssertionError(url)

        args = SimpleNamespace(
            base_url="http://custom.test",
            request_timeout=1,
            input_json="{}",
            input_file=None,
            process="texture",
            compact=True,
        )
        with patch.object(agent, "_request_json", fake_request), redirect_stdout(io.StringIO()) as buf:
            self.assertEqual(agent.cmd_process_run_start(args), 0)
        payload = json.loads(buf.getvalue())
        self.assertIn("--base-url http://custom.test", payload["meta"]["status_command"])
        self.assertIn("--base-url http://custom.test", payload["meta"]["cancel_command"])

    def test_main_converts_unexpected_exceptions_to_json(self) -> None:
        def boom(_args: object) -> int:
            raise RuntimeError("boom")

        with patch.object(agent, "cmd_health", boom), redirect_stdout(io.StringIO()) as buf:
            self.assertEqual(agent.main(["health"]), 1)
        payload = json.loads(buf.getvalue())
        self.assertEqual(payload["code"], "UNEXPECTED_ERROR")
        self.assertEqual(payload["message"], "boom")

    def test_main_converts_argparse_errors_to_json(self) -> None:
        with redirect_stdout(io.StringIO()) as buf:
            self.assertEqual(agent.main(["health", "--bogus"]), 1)
        payload = json.loads(buf.getvalue())
        self.assertEqual(payload["code"], "INVALID_ARGUMENTS")
        self.assertIn("--bogus", payload["message"])

    def test_generate_from_workflow_downloads_direct_asset_without_modly_health(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            output = Path(td) / "robot.glb"
            history = {
                "outputs": {
                    "9": {
                        "meshes": [
                            {"filename": "robot.glb", "subfolder": "trellis", "type": "output"},
                        ]
                    }
                }
            }
            args = SimpleNamespace(
                base_url="http://modly.test",
                request_timeout=1,
                compact=True,
                output=str(output),
                workflow="Trellis2-Full",
            )

            with (
                patch.object(agent, "_run_comfy_workflow", return_value={"ok": True, "comfy_url": "http://comfy.test", "workflow": "Trellis2-Full", "prompt_id": "prompt-1", "history": history}),
                patch.object(agent, "_download", return_value=789) as download,
                patch.object(agent, "_require_health", side_effect=AssertionError("Modly health should not run for direct asset output")),
                patch.object(agent, "_generate_one", side_effect=AssertionError("Modly generation should not run for direct asset output")),
                redirect_stdout(io.StringIO()) as buf,
            ):
                self.assertEqual(agent.cmd_generate_from_workflow(args), 0)

            payload = json.loads(buf.getvalue())
            self.assertEqual(payload["source"], "comfy-workflow")
            self.assertEqual(payload["output_type"], "asset")
            self.assertEqual(payload["export_path"], str(output.resolve()))
            self.assertEqual(payload["bytes_written"], 789)
            self.assertEqual(payload["workflow"], "Trellis2-Full")
            self.assertEqual(payload["prompt_id"], "prompt-1")
            self.assertTrue(payload["meta"]["experimental"])
            download.assert_called_once()
            self.assertIn("/view?", download.call_args.args[0])
            self.assertIn("filename=robot.glb", download.call_args.args[0])

    def test_generate_from_workflow_falls_back_to_modly_for_image_only_outputs(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            output = Path(td) / "robot.glb"
            history = {
                "outputs": {
                    "3": {
                        "images": [
                            {"filename": "source.png", "subfolder": "", "type": "output"},
                        ]
                    }
                }
            }
            args = SimpleNamespace(
                base_url="http://modly.test",
                request_timeout=1,
                compact=True,
                output=str(output),
                workflow="Trellis2-Full",
            )

            def fake_generate(_args: object, image_path: Path, output_path: Path | None) -> dict[str, object]:
                self.assertTrue(str(image_path).endswith(".png"))
                self.assertEqual(output_path, output.resolve())
                return {"ok": True, "run": {"kind": "workflowRun", "id": "run-1"}, "meta": {"legacy": False}}

            with (
                patch.object(agent, "_run_comfy_workflow", return_value={"ok": True, "comfy_url": "http://comfy.test", "workflow": "Trellis2-Full", "prompt_id": "prompt-1", "history": history}),
                patch.object(agent, "_download", return_value=123),
                patch.object(agent, "_require_health", return_value={"status": "ok"}) as health,
                patch.object(agent, "_generate_one", fake_generate),
                redirect_stdout(io.StringIO()) as buf,
            ):
                self.assertEqual(agent.cmd_generate_from_workflow(args), 0)

            payload = json.loads(buf.getvalue())
            self.assertEqual(payload["source"], "comfy-workflow")
            self.assertEqual(payload["output_type"], "image")
            self.assertEqual(payload["comfy"]["prompt_id"], "prompt-1")
            self.assertTrue(payload["meta"]["experimental"])
            health.assert_called_once_with("http://modly.test", 1)

    def test_generate_from_workflow_fails_when_history_has_no_supported_output(self) -> None:
        args = SimpleNamespace(base_url="http://modly.test", request_timeout=1, compact=True, output="robot.glb", workflow="Trellis2-Full")
        history = {"outputs": {"4": {"text": ["done"]}}}
        with patch.object(agent, "_run_comfy_workflow", return_value={"ok": True, "comfy_url": "http://comfy.test", "workflow": "Trellis2-Full", "prompt_id": "prompt-1", "history": history}):
            with self.assertRaises(agent.ModlyCliError) as ctx:
                agent.cmd_generate_from_workflow(args)
        self.assertEqual(ctx.exception.code, "NO_WORKFLOW_OUTPUT")

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

    def test_malformed_timeout_environment_does_not_break_module_import(self) -> None:
        spec = importlib.util.spec_from_file_location("modly_agent_bad_env", MODULE_PATH)
        module = importlib.util.module_from_spec(spec)
        assert spec and spec.loader
        with patch.dict(os.environ, {"MODLY_CLI_TIMEOUT": "not-int", "MODLY_CLI_POLL_SECONDS": "not-float"}):
            spec.loader.exec_module(module)
        self.assertEqual(module.DEFAULT_TIMEOUT_SECONDS, 1800)
        self.assertEqual(module.DEFAULT_POLL_SECONDS, 2.0)

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
    def test_canonical_dev_experimental_and_legacy_subcommands_parse(self) -> None:
        parser = agent.build_parser()
        cases = [
            ["status"],
            ["model", "list"],
            ["model", "params"],
            ["workflow-run", "status", "abc"],
            ["workflow-run", "cancel", "abc"],
            ["capability", "list"],
            ["process-run", "status", "abc"],
            ["experimental", "comfy-image"],
            ["experimental", "generate-from-workflow", "--workflow", "Trellis2-Full", "--prompt", "asset", "--output", "asset.glb"],
            ["export", "--path", "Agent/foo.glb", "--output", "foo.glb"],
            ["batch", "--input-dir", "imgs", "--output-dir", "meshes"],
            ["dev", "serve-api", "--print-command"],
            ["dev", "ensure-server"],
            ["legacy", "job", "abc"],
            ["legacy", "cancel", "abc"],
        ]
        for argv in cases:
            with self.subTest(argv=argv):
                args = parser.parse_args(argv)
                self.assertTrue(callable(args.func))

    def test_hidden_aliases_are_not_documented_as_canonical(self) -> None:
        parser = agent.build_parser()
        help_text = parser.format_help()
        self.assertNotIn("comfy-image", help_text)
        self.assertNotIn("ensure-server", help_text)
        self.assertNotIn("job", help_text)
        self.assertNotIn("\n    status", help_text)
        self.assertNotIn("\n    export", help_text)
        self.assertNotIn("\n    batch", help_text)


if __name__ == "__main__":
    unittest.main()

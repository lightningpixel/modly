#!/usr/bin/env python3
"""Minimal agent-friendly CLI for the local Modly API.

The Electron app normally owns the FastAPI server. This tool is intentionally
small and stdlib-only so automation agents can call a running Modly instance,
optionally start only the FastAPI backend, and always receive parseable JSON.
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

DEFAULT_BASE_URL = os.environ.get("MODLY_API_URL", "http://127.0.0.1:8765")
DEFAULT_TIMEOUT_SECONDS = int(os.environ.get("MODLY_CLI_TIMEOUT", os.environ.get("MODLY_AGENT_TIMEOUT", "1800")))
DEFAULT_POLL_SECONDS = float(os.environ.get("MODLY_CLI_POLL_SECONDS", os.environ.get("MODLY_AGENT_POLL_SECONDS", "2")))
EXPORT_FORMATS = ("glb", "stl", "obj", "ply")
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}


class ModlyCliError(RuntimeError):
    """Expected user/API failure that should be reported as JSON."""


def _json_print(data: dict[str, Any], *, compact: bool = False) -> None:
    if compact:
        print(json.dumps(data, separators=(",", ":"), sort_keys=True))
    else:
        print(json.dumps(data, indent=2, sort_keys=True))


def _request_json(
    method: str,
    url: str,
    *,
    timeout: float,
    data: bytes | None = None,
    headers: dict[str, str] | None = None,
) -> Any:
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise ModlyCliError(f"HTTP {exc.code} from {url}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise ModlyCliError(f"Cannot reach Modly API at {url}: {exc.reason}") from exc
    try:
        return json.loads(raw) if raw else {}
    except json.JSONDecodeError as exc:
        raise ModlyCliError(f"Expected JSON from {url}, got: {raw[:500]}") from exc


def _download(url: str, dest: Path, *, timeout: float) -> int:
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp, dest.open("wb") as fh:
            total = 0
            while True:
                chunk = resp.read(1024 * 1024)
                if not chunk:
                    return total
                fh.write(chunk)
                total += len(chunk)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise ModlyCliError(f"HTTP {exc.code} while downloading {url}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise ModlyCliError(f"Cannot download {url}: {exc.reason}") from exc
    except OSError as exc:
        raise ModlyCliError(f"Cannot write to {dest}: {exc}") from exc


def _multipart_form(fields: dict[str, str], file_field: str, file_path: Path) -> tuple[bytes, str]:
    boundary = f"----modly-cli-{time.time_ns()}"
    parts: list[bytes] = []

    for name, value in fields.items():
        parts.extend([
            f"--{boundary}\r\n".encode(),
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode(),
            str(value).encode("utf-8"),
            b"\r\n",
        ])

    content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
    parts.extend([
        f"--{boundary}\r\n".encode(),
        f'Content-Disposition: form-data; name="{file_field}"; filename="{file_path.name}"\r\n'.encode(),
        f"Content-Type: {content_type}\r\n\r\n".encode(),
        file_path.read_bytes(),
        b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ])
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def _workspace_relative_path(output_url: str) -> str:
    parsed = urllib.parse.urlparse(output_url)
    path = parsed.path if parsed.scheme else output_url
    prefix = "/workspace/"
    if path.startswith(prefix):
        return urllib.parse.unquote(path[len(prefix):])
    return urllib.parse.unquote(path.lstrip("/"))


def _export_workspace_path(base_url: str, workspace_path: str, fmt: str, dest: Path, *, timeout: float) -> int:
    export_url = f"{base_url.rstrip('/')}/export/{urllib.parse.quote(fmt)}?{urllib.parse.urlencode({'path': workspace_path})}"
    return _download(export_url, dest, timeout=timeout)


def _try_health(base_url: str, timeout: float) -> dict[str, Any] | None:
    try:
        health = _request_json("GET", f"{base_url.rstrip('/')}/health", timeout=timeout)
    except ModlyCliError:
        return None
    return health if isinstance(health, dict) else {"raw": health}


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _windows_env_paths(name: str) -> list[Path]:
    value = os.environ.get(name)
    if value:
        return [Path(value)]
    paths: list[Path] = []
    if os.name == "posix":
        users_dir = Path("/mnt/c/Users")
        roots: list[Path] = []
        if users_dir.exists():
            try:
                roots = sorted(p for p in users_dir.glob("*") if p.is_dir())
            except PermissionError:
                roots = []
        for root in roots:
            try:
                if name == "LOCALAPPDATA":
                    candidate = root / "AppData" / "Local"
                elif name == "APPDATA":
                    candidate = root / "AppData" / "Roaming"
                else:
                    continue
                if candidate.exists():
                    paths.append(candidate)
            except PermissionError:
                continue
    return paths


def _windows_env_path(name: str) -> Path | None:
    paths = _windows_env_paths(name)
    return paths[0] if paths else None


def _default_api_dir() -> Path | None:
    repo_api = _repo_root() / "api"
    if (repo_api / "main.py").exists():
        return repo_api
    for local in _windows_env_paths("LOCALAPPDATA"):
        installed = local / "Programs" / "Modly" / "resources" / "api"
        if (installed / "main.py").exists():
            return installed
    return None


def _default_python(api_dir: Path) -> Path | None:
    candidates = [
        api_dir / ".venv" / "Scripts" / "python.exe",
        api_dir / ".venv" / "bin" / "python",
    ]
    for appdata in _windows_env_paths("APPDATA"):
        candidates.append(appdata / "Modly" / "dependencies" / "venv" / "Scripts" / "python.exe")
    candidates.append(Path(sys.executable))
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None


def _load_modly_settings() -> dict[str, Any]:
    candidates: list[Path] = []
    for appdata in _windows_env_paths("APPDATA"):
        candidates.append(appdata / "Modly" / "settings.json")
    candidates.append(Path.home() / ".config" / "Modly" / "settings.json")
    for path in candidates:
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                return data if isinstance(data, dict) else {}
            except (OSError, json.JSONDecodeError):
                return {}
    return {}


def _resolve_serve_config(args: argparse.Namespace) -> tuple[Path, Path, dict[str, str], list[str], str]:
    api_dir = Path(args.api_dir).expanduser().resolve() if getattr(args, "api_dir", None) else _default_api_dir()
    if not api_dir or not (api_dir / "main.py").exists():
        raise ModlyCliError("Could not find Modly api directory; pass --api-dir")

    python = Path(args.python).expanduser().resolve() if getattr(args, "python", None) else _default_python(api_dir)
    if not python or not python.exists():
        raise ModlyCliError("Could not find Modly Python environment; pass --python")

    settings = _load_modly_settings()
    env = os.environ.copy()
    hf_token = getattr(args, "hf_token", None) or settings.get("hfToken") or os.environ.get("HF_TOKEN", "")
    env.update({
        "PYTHONUNBUFFERED": "1",
        "MODELS_DIR": getattr(args, "models_dir", None) or settings.get("modelsDir") or str(Path.home() / ".modly" / "models"),
        "WORKSPACE_DIR": getattr(args, "workspace_dir", None) or settings.get("workspaceDir") or str(Path.home() / ".modly" / "workspace"),
        "EXTENSIONS_DIR": getattr(args, "extensions_dir", None) or settings.get("extensionsDir") or "",
        "SELECTED_MODEL_ID": getattr(args, "model", None) or os.environ.get("SELECTED_MODEL_ID", ""),
        "HUGGING_FACE_HUB_TOKEN": hf_token,
        "HF_TOKEN": hf_token,
    })
    cmd = [str(python), "-m", "uvicorn", "main:app", "--host", args.host, "--port", str(args.port)]
    base_url = f"http://{args.host}:{args.port}"
    return api_dir, python, env, cmd, base_url


def _start_backend(cmd: list[str], *, api_dir: Path, env: dict[str, str], detach: bool) -> subprocess.Popen[Any]:
    kwargs: dict[str, Any] = {"cwd": str(api_dir), "env": env}
    if detach:
        kwargs.update({
            "stdin": subprocess.DEVNULL,
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.DEVNULL,
        })
        if os.name != "nt":
            kwargs["start_new_session"] = True
        else:
            kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    return subprocess.Popen(cmd, **kwargs)


def cmd_health(args: argparse.Namespace) -> int:
    base_url = args.base_url.rstrip("/")
    data = _request_json("GET", f"{base_url}/health", timeout=args.request_timeout)
    _json_print({"ok": True, "base_url": base_url, "health": data}, compact=args.compact)
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    base_url = args.base_url.rstrip("/")
    health = _request_json("GET", f"{base_url}/health", timeout=args.request_timeout)
    model = _request_json("GET", f"{base_url}/model/status", timeout=args.request_timeout)
    _json_print({"ok": True, "base_url": base_url, "health": health, "model": model}, compact=args.compact)
    return 0


def cmd_models(args: argparse.Namespace) -> int:
    base_url = args.base_url.rstrip("/")
    data = _request_json("GET", f"{base_url}/model/all", timeout=args.request_timeout)
    _json_print({"ok": True, "base_url": base_url, "models": data}, compact=args.compact)
    return 0


def _parse_params(params_json: str | None, params_file: str | None) -> dict[str, Any]:
    if params_file:
        text = Path(params_file).expanduser().read_text(encoding="utf-8")
    else:
        text = params_json or "{}"
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ModlyCliError(f"params must be valid JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ModlyCliError("params must be a JSON object")
    return parsed


def _choose_auto_model(base_url: str, request_timeout: float) -> str:
    models = _request_json("GET", f"{base_url.rstrip('/')}/model/all", timeout=request_timeout)
    if not isinstance(models, list) or not models:
        active = _request_json("GET", f"{base_url.rstrip('/')}/model/status", timeout=request_timeout)
        if isinstance(active, dict) and active.get("id"):
            return str(active["id"])
        raise ModlyCliError(f"Could not resolve a model id: {models}")

    def text(model: dict[str, Any]) -> str:
        return f"{model.get('id', '')} {model.get('name', '')}".lower()

    active_models = [m for m in models if isinstance(m, dict) and m.get("active")]
    if active_models:
        active_text = text(active_models[0])
        if "refine" not in active_text and "texture" not in active_text:
            return str(active_models[0].get("id"))

    for model in models:
        if isinstance(model, dict) and ("generate" in text(model) or str(model.get("id", "")).endswith("/generate")):
            return str(model.get("id"))
    first = models[0]
    if isinstance(first, dict) and first.get("id"):
        return str(first["id"])
    raise ModlyCliError(f"Could not resolve a model id: {models}")


def _resolve_model_id(args: argparse.Namespace, base_url: str) -> str:
    model_id = args.model
    if not model_id or model_id == "auto":
        return _choose_auto_model(base_url, args.request_timeout)
    if model_id == "active":
        active = _request_json("GET", f"{base_url}/model/status", timeout=args.request_timeout)
        if not isinstance(active, dict) or not active.get("id"):
            raise ModlyCliError(f"Could not resolve active model id: {active}")
        return str(active["id"])
    return str(model_id)


def cmd_params(args: argparse.Namespace) -> int:
    base_url = args.base_url.rstrip("/")
    model_id = args.model
    if model_id == "auto":
        model_id = _choose_auto_model(base_url, args.request_timeout)
    query = ""
    if model_id and model_id != "active":
        query = "?" + urllib.parse.urlencode({"model_id": model_id})
    params = _request_json("GET", f"{base_url}/model/params{query}", timeout=args.request_timeout)
    _json_print({"ok": True, "base_url": base_url, "model_id": model_id, "params": params}, compact=args.compact)
    return 0


def cmd_job(args: argparse.Namespace) -> int:
    base_url = args.base_url.rstrip("/")
    status = _request_json("GET", f"{base_url}/generate/status/{urllib.parse.quote(args.job_id)}", timeout=args.request_timeout)
    _json_print({"ok": True, "base_url": base_url, "job_id": args.job_id, "status": status}, compact=args.compact)
    return 0


def cmd_cancel(args: argparse.Namespace) -> int:
    base_url = args.base_url.rstrip("/")
    result = _request_json("POST", f"{base_url}/generate/cancel/{urllib.parse.quote(args.job_id)}", timeout=args.request_timeout)
    _json_print({"ok": True, "base_url": base_url, "job_id": args.job_id, "cancel": result}, compact=args.compact)
    return 0



def _load_comfy_workflow(workflow: str, *, host: str, timeout: float) -> dict[str, Any]:
    path = Path(workflow).expanduser()
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise ModlyCliError(f"workflow must be valid JSON: {path}: {exc}") from exc
        if not isinstance(data, dict):
            raise ModlyCliError(f"workflow JSON must be an object: {path}")
        return data

    candidates = [workflow, f"{workflow}.json"] if not workflow.endswith(".json") else [workflow]
    for name in candidates:
        quoted = urllib.parse.quote(name.lstrip("/"), safe="/")
        for prefix in ("/userdata/workflows/", "/api/userdata/workflows/", "/userdata/", "/api/userdata/"):
            try:
                data = _request_json("GET", f"{host.rstrip('/')}{prefix}{quoted}", timeout=timeout)
            except ModlyCliError:
                continue
            if isinstance(data, dict):
                return data

    search_roots: list[Path] = []
    for value in [os.environ.get("COMFYUI_WORKFLOW_DIR"), os.environ.get("COMFYUI_USER_DIR")]:
        if value:
            search_roots.append(Path(value).expanduser())
    search_roots.extend([
        Path.home() / "ComfyUI" / "user" / "default" / "workflows",
        Path.home() / "Documents" / "ComfyUI" / "user" / "default" / "workflows",
    ])
    for appdata in _windows_env_paths("APPDATA"):
        search_roots.extend([
            appdata / "ComfyUI" / "user" / "default" / "workflows",
            appdata / "comfyui" / "user" / "default" / "workflows",
        ])
    for root in search_roots:
        for name in candidates:
            candidate = root / name
            if candidate.exists():
                try:
                    data = json.loads(candidate.read_text(encoding="utf-8"))
                except json.JSONDecodeError as exc:
                    raise ModlyCliError(f"workflow must be valid JSON: {candidate}: {exc}") from exc
                if isinstance(data, dict):
                    return data
    raise ModlyCliError(f"Could not find ComfyUI workflow '{workflow}'. Pass a JSON path or set COMFYUI_WORKFLOW_DIR.")


def _patch_comfy_workflow(workflow: dict[str, Any], *, prompt: str | None, seed: int | None) -> dict[str, Any]:
    workflow = json.loads(json.dumps(workflow))
    nodes = workflow.get("prompt", workflow)
    if not isinstance(nodes, dict):
        raise ModlyCliError("ComfyUI workflow must be API format (top-level node-id object, or {'prompt': {...}})")
    if "nodes" in workflow and "links" in workflow:
        raise ModlyCliError("ComfyUI workflow is editor format; export it as API format first")

    if prompt is not None:
        patched = False
        for node in nodes.values():
            if not isinstance(node, dict):
                continue
            class_type = str(node.get("class_type", "")).lower()
            inputs = node.get("inputs") if isinstance(node.get("inputs"), dict) else {}
            text = str(inputs.get("text", "")).lower()
            if "cliptextencode" in class_type and "negative" not in text:
                inputs["text"] = prompt
                patched = True
                break
        if not patched:
            for node in nodes.values():
                if isinstance(node, dict) and isinstance(node.get("inputs"), dict):
                    inputs = node["inputs"]
                    for key in ("prompt", "positive", "text"):
                        if key in inputs and isinstance(inputs[key], str):
                            inputs[key] = prompt
                            patched = True
                            break
                if patched:
                    break
        if not patched:
            raise ModlyCliError("Could not find a text/prompt input to patch in ComfyUI workflow")

    if seed is not None:
        for node in nodes.values():
            if not isinstance(node, dict) or not isinstance(node.get("inputs"), dict):
                continue
            inputs = node["inputs"]
            for key in ("seed", "noise_seed"):
                if key in inputs and isinstance(inputs[key], int):
                    inputs[key] = seed
    return nodes


def _run_comfy_image(args: argparse.Namespace) -> dict[str, Any]:
    host = args.comfy_url.rstrip("/")
    workflow = _load_comfy_workflow(args.workflow, host=host, timeout=args.request_timeout)
    prompt = getattr(args, "prompt", None)
    seed = getattr(args, "seed", None)
    graph = _patch_comfy_workflow(workflow, prompt=prompt, seed=seed)
    payload = json.dumps({"prompt": graph, "client_id": "modly-cli"}).encode("utf-8")
    queued = _request_json("POST", f"{host}/prompt", timeout=args.request_timeout, data=payload, headers={"Content-Type": "application/json"})
    prompt_id = queued.get("prompt_id") if isinstance(queued, dict) else None
    if not prompt_id:
        raise ModlyCliError(f"ComfyUI did not return prompt_id: {queued}")

    deadline = time.monotonic() + args.timeout
    history: dict[str, Any] = {}
    while time.monotonic() < deadline:
        data = _request_json("GET", f"{host}/history/{urllib.parse.quote(str(prompt_id))}", timeout=args.request_timeout)
        if isinstance(data, dict) and str(prompt_id) in data:
            history = data[str(prompt_id)] if isinstance(data[str(prompt_id)], dict) else {"raw": data[str(prompt_id)]}
            break
        if getattr(args, "progress", False) and not getattr(args, "quiet", False):
            print(json.dumps({"phase": "comfy", "prompt_id": prompt_id, "status": "running"}), file=sys.stderr)
        time.sleep(args.poll)
    if not history:
        raise ModlyCliError(f"Timed out waiting for ComfyUI prompt {prompt_id}")

    outputs = history.get("outputs") if isinstance(history.get("outputs"), dict) else {}
    image_ref = None
    for node_output in outputs.values():
        if isinstance(node_output, dict) and node_output.get("images"):
            images = node_output.get("images")
            if isinstance(images, list) and images and isinstance(images[0], dict):
                image_ref = images[0]
                break
    if not image_ref:
        raise ModlyCliError(f"ComfyUI prompt {prompt_id} completed without an image output")

    out_path: Path | None = getattr(args, "comfy_output", None)
    if out_path:
        out = Path(out_path).expanduser().resolve()
    else:
        tmp = tempfile.NamedTemporaryFile(delete=False, prefix="modly-comfy-", suffix=".png")
        tmp.close()
        out = Path(tmp.name)
    query = urllib.parse.urlencode({
        "filename": image_ref.get("filename", ""),
        "subfolder": image_ref.get("subfolder", ""),
        "type": image_ref.get("type", "output"),
    })
    bytes_written = _download(f"{host}/view?{query}", out, timeout=args.request_timeout)
    return {"ok": True, "comfy_url": host, "workflow": args.workflow, "prompt_id": str(prompt_id), "image_path": str(out), "bytes_written": bytes_written, "image": image_ref}


def cmd_comfy_image(args: argparse.Namespace) -> int:
    result = _run_comfy_image(args)
    _json_print(result, compact=args.compact)
    return 0


def cmd_generate_from_workflow(args: argparse.Namespace) -> int:
    comfy = _run_comfy_image(args)
    output = Path(args.output).expanduser().resolve() if args.output else None
    result = _generate_one(args, Path(str(comfy["image_path"])), output)
    result["source"] = "comfy-workflow"
    result["comfy"] = comfy
    _json_print(result, compact=args.compact)
    return 0

def _run_generation_job(
    args: argparse.Namespace,
    image_path: Path,
    *,
    base_url: str,
    model_id: str,
    params: dict[str, Any],
    progress_label: str,
) -> tuple[str, dict[str, Any], str]:
    fields = {
        "model_id": model_id,
        "collection": args.collection,
        "remesh": args.remesh,
        "enable_texture": "true" if getattr(args, "enable_texture", True) else "false",
        "texture_resolution": str(getattr(args, "texture_resolution", 1024)),
        "params": json.dumps(params, separators=(",", ":")),
    }
    body, content_type = _multipart_form(fields, "image", image_path)
    started = _request_json(
        "POST",
        f"{base_url}/generate/from-image",
        timeout=args.request_timeout,
        data=body,
        headers={"Content-Type": content_type},
    )
    job_id = started.get("job_id") if isinstance(started, dict) else None
    if not job_id:
        raise ModlyCliError(f"Modly did not return a job_id: {started}")

    deadline = time.monotonic() + args.timeout
    last_status: dict[str, Any] = {}
    while time.monotonic() < deadline:
        status = _request_json("GET", f"{base_url}/generate/status/{urllib.parse.quote(str(job_id))}", timeout=args.request_timeout)
        last_status = status if isinstance(status, dict) else {"raw": status}
        state = last_status.get("status")
        if state == "done":
            output_url = str(last_status.get("output_url") or "")
            if not output_url:
                raise ModlyCliError(f"Job completed without output_url: {last_status}")
            return str(job_id), last_status, _workspace_relative_path(output_url)
        if state in {"error", "cancelled"}:
            raise ModlyCliError(f"Job {job_id} ended with status {state}: {last_status}")
        if getattr(args, "progress", False) and not getattr(args, "quiet", False):
            progress = last_status.get("progress", 0)
            step = last_status.get("step", "")
            print(json.dumps({"phase": progress_label, "job_id": job_id, "status": state, "progress": progress, "step": step}), file=sys.stderr)
        time.sleep(args.poll)

    raise ModlyCliError(f"Timed out waiting for job {job_id}. Last status: {last_status}")


def _texture_model_id(args: argparse.Namespace, base_url: str) -> str | None:
    requested = getattr(args, "texture_model", "auto")
    if requested and requested != "auto":
        return str(requested)
    models = _request_json("GET", f"{base_url}/model/all", timeout=args.request_timeout)
    if not isinstance(models, list):
        return None
    for model in models:
        if not isinstance(model, dict):
            continue
        text = f"{model.get('id', '')} {model.get('name', '')}".lower()
        if "refine" in text or "texture" in text:
            return str(model.get("id"))
    return None


def _generate_one(args: argparse.Namespace, image_path: Path, output_path: Path | None = None) -> dict[str, Any]:
    base_url = args.base_url.rstrip("/")
    image_path = image_path.expanduser().resolve()
    if not image_path.exists() or not image_path.is_file():
        raise ModlyCliError(f"image file not found: {image_path}")

    params = _parse_params(getattr(args, "params_json", None), getattr(args, "params_file", None))
    model_id = _resolve_model_id(args, base_url)
    job_id, status, rel_path = _run_generation_job(
        args,
        image_path,
        base_url=base_url,
        model_id=model_id,
        params=params,
        progress_label="generate",
    )

    texture_enabled = bool(getattr(args, "enable_texture", True))
    texture_job_id = None
    texture_status = None
    texture_model_id = None
    geometry_workspace_path = rel_path
    if texture_enabled and "refine" not in model_id.lower() and "texture" not in model_id.lower():
        texture_model_id = _texture_model_id(args, base_url)
        if texture_model_id:
            texture_params = _parse_params(getattr(args, "texture_params_json", None), getattr(args, "texture_params_file", None))
            texture_params.setdefault("mesh_path", rel_path)
            texture_params.setdefault("texture_resolution", getattr(args, "texture_resolution", 1024))
            texture_params.setdefault("texture_size", getattr(args, "texture_size", 2048))
            texture_params.setdefault("texture_steps", getattr(args, "texture_steps", 30))
            texture_params.setdefault("texture_guidance", getattr(args, "texture_guidance", 3.0))
            texture_job_id, texture_status, rel_path = _run_generation_job(
                args,
                image_path,
                base_url=base_url,
                model_id=texture_model_id,
                params=texture_params,
                progress_label="texture",
            )
        else:
            texture_enabled = False

    export_dest = output_path or image_path.resolve().parent / f"{Path(rel_path).stem}.{args.format}"
    export_dest = export_dest.expanduser().resolve()
    bytes_written = _export_workspace_path(base_url, rel_path, args.format, export_dest, timeout=args.request_timeout)
    return {
        "ok": True,
        "base_url": base_url,
        "image": str(image_path),
        "model_id": model_id,
        "job_id": job_id,
        "status": status,
        "workspace_path": rel_path,
        "geometry_workspace_path": geometry_workspace_path,
        "texture_enabled": texture_enabled,
        "texture_model_id": texture_model_id,
        "texture_job_id": texture_job_id,
        "texture_status": texture_status,
        "export_format": args.format,
        "export_path": str(export_dest),
        "bytes_written": bytes_written,
    }


def cmd_generate(args: argparse.Namespace) -> int:
    output = Path(args.output).expanduser().resolve() if args.output else None
    result = _generate_one(args, Path(args.image), output)
    _json_print(result, compact=args.compact)
    return 0


def cmd_export(args: argparse.Namespace) -> int:
    base_url = args.base_url.rstrip("/")
    dest = Path(args.output).expanduser().resolve()
    bytes_written = _export_workspace_path(base_url, args.path, args.format, dest, timeout=args.request_timeout)
    _json_print({
        "ok": True,
        "base_url": base_url,
        "workspace_path": args.path,
        "export_format": args.format,
        "export_path": str(dest),
        "bytes_written": bytes_written,
    }, compact=args.compact)
    return 0


def _iter_images(input_dir: Path) -> list[Path]:
    if not input_dir.exists() or not input_dir.is_dir():
        raise ModlyCliError(f"input directory not found: {input_dir}")
    return sorted(p for p in input_dir.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_SUFFIXES)


def _manifest_jobs(path: Path, fallback_output_dir: Path | None, default_format: str) -> list[tuple[Path, Path | None, str]]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ModlyCliError(f"manifest must be valid JSON: {exc}") from exc
    entries = raw.get("jobs", raw.get("images")) if isinstance(raw, dict) else raw
    if not isinstance(entries, list):
        raise ModlyCliError("manifest must be a JSON list or object with a jobs/images list")

    jobs: list[tuple[Path, Path | None, str]] = []
    for index, entry in enumerate(entries):
        if isinstance(entry, str):
            image = Path(entry)
            fmt = default_format
            output = None
        elif isinstance(entry, dict):
            image_value = entry.get("image") or entry.get("image_path") or entry.get("path")
            if not image_value:
                raise ModlyCliError(f"manifest entry {index} is missing image")
            image = Path(str(image_value))
            fmt = str(entry.get("format") or default_format)
            if fmt not in EXPORT_FORMATS:
                raise ModlyCliError(f"manifest entry {index} has unsupported format: {fmt}")
            output = Path(str(entry["output"])) if entry.get("output") else None
        else:
            raise ModlyCliError(f"manifest entry {index} must be a string or object")

        if not image.is_absolute():
            image = path.parent / image
        if output is None and fallback_output_dir is not None:
            output = fallback_output_dir / f"{image.stem}.{fmt}"
        elif output is not None and not output.is_absolute():
            output = path.parent / output
        jobs.append((image, output, fmt))
    return jobs


def cmd_batch(args: argparse.Namespace) -> int:
    output_dir = Path(args.output_dir).expanduser().resolve() if args.output_dir else None
    if output_dir:
        output_dir.mkdir(parents=True, exist_ok=True)
    if args.manifest:
        jobs = _manifest_jobs(Path(args.manifest).expanduser().resolve(), output_dir, args.format)
    else:
        if not args.input_dir or output_dir is None:
            raise ModlyCliError("batch requires --input-dir and --output-dir, or --manifest with per-entry outputs")
        input_dir = Path(args.input_dir).expanduser().resolve()
        jobs = [(image, output_dir / f"{image.stem}.{args.format}", args.format) for image in _iter_images(input_dir)]

    results: list[dict[str, Any]] = []
    failures = 0
    original_format = args.format
    for image, output, fmt in jobs:
        args.format = fmt
        try:
            results.append(_generate_one(args, image, output))
        except ModlyCliError as exc:
            failures += 1
            results.append({"ok": False, "image": str(image), "error": str(exc)})
            if not args.continue_on_error:
                break
    args.format = original_format
    _json_print({"ok": failures == 0, "count": len(results), "failures": failures, "results": results}, compact=args.compact)
    return 0 if failures == 0 else 1


def cmd_serve(args: argparse.Namespace) -> int:
    api_dir, _python, env, cmd, base_url = _resolve_serve_config(args)
    public_env = {k: env.get(k, "") for k in ["MODELS_DIR", "WORKSPACE_DIR", "EXTENSIONS_DIR", "SELECTED_MODEL_ID"]}
    if args.print_command:
        _json_print({"ok": True, "cmd": cmd, "cwd": str(api_dir), "base_url": base_url, "env": public_env}, compact=args.compact)
        return 0
    proc = _start_backend(cmd, api_dir=api_dir, env=env, detach=args.detach)
    if args.detach:
        _json_print({"ok": True, "started": True, "pid": proc.pid, "base_url": base_url, "cmd": cmd, "cwd": str(api_dir), "env": public_env}, compact=args.compact)
        return 0
    return int(proc.wait())


def cmd_ensure_server(args: argparse.Namespace) -> int:
    base_url = args.base_url.rstrip("/")
    health = _try_health(base_url, args.request_timeout)
    if health:
        _json_print({"ok": True, "started": False, "base_url": base_url, "health": health}, compact=args.compact)
        return 0
    if not args.start:
        message = "Modly API is not running; launch Modly or run ensure-server --start"
        if args.fail_on_unavailable:
            raise ModlyCliError(message)
        _json_print({"ok": False, "started": False, "base_url": base_url, "error": message}, compact=args.compact)
        return 0
    api_dir, _python, env, cmd, resolved_url = _resolve_serve_config(args)
    public_env = {k: env.get(k, "") for k in ["MODELS_DIR", "WORKSPACE_DIR", "EXTENSIONS_DIR", "SELECTED_MODEL_ID"]}
    if args.print_command:
        _json_print({"ok": True, "started": False, "would_start": True, "base_url": resolved_url, "cmd": cmd, "cwd": str(api_dir), "env": public_env}, compact=args.compact)
        return 0
    proc = _start_backend(cmd, api_dir=api_dir, env=env, detach=args.detach)
    _json_print({"ok": True, "started": True, "pid": proc.pid, "base_url": resolved_url, "cmd": cmd, "cwd": str(api_dir), "env": public_env}, compact=args.compact)
    if not args.detach:
        return int(proc.wait())
    return 0


def _add_comfy_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--workflow", default="Trellis2Workflow", help="ComfyUI API-format workflow path or saved workflow name (default: Trellis2Workflow)")
    parser.add_argument("--prompt", help="Prompt text to inject into the first positive text/prompt input")
    parser.add_argument("--seed", type=int, help="Seed to inject into seed/noise_seed inputs")
    parser.add_argument("--comfy-url", default=os.environ.get("COMFYUI_URL", "http://127.0.0.1:8188"), help="ComfyUI API URL (default: http://127.0.0.1:8188)")
    parser.add_argument("--comfy-output", help="Where to save the ComfyUI image output before passing it to Modly")


def _add_generation_options(parser: argparse.ArgumentParser, *, image: bool, output: bool, batch: bool = False) -> None:
    if image:
        parser.add_argument("--image", required=True, help="Input image path")
    if output:
        parser.add_argument("--output", help="Export destination path. Defaults beside the input image")
    parser.add_argument("--format", choices=EXPORT_FORMATS, default="glb", help="Export format (default: glb)")
    parser.add_argument("--model", default="auto", help="Model id to use, 'active', or 'auto' (default: auto)")
    parser.add_argument("--collection", default="Agent", help="Modly workspace collection (default: Agent)")
    parser.add_argument("--remesh", choices=["quad", "triangle", "none"], default="quad", help="Remesh mode (default: quad)")
    parser.add_argument("--texture", dest="enable_texture", action="store_true", default=True, help="Enable texture generation (default)")
    parser.add_argument("--no-texture", dest="enable_texture", action="store_false", help="Disable texture generation for faster geometry-only smoke tests")
    parser.add_argument("--enable-texture", dest="enable_texture", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--texture-resolution", type=int, default=1024, help="Texture diffusion resolution when texturing is enabled")
    parser.add_argument("--texture-model", default="auto", help="Texture/refine model id, or 'auto' (default: auto)")
    parser.add_argument("--texture-size", type=int, default=2048, help="Texture atlas size when texturing is enabled (default: 2048)")
    parser.add_argument("--texture-steps", type=int, default=30, help="Texture diffusion steps when texturing is enabled (default: 30)")
    parser.add_argument("--texture-guidance", type=float, default=3.0, help="Texture guidance strength when texturing is enabled (default: 3.0)")
    parser.add_argument("--texture-params-json", help="Texture/refine params as a JSON object")
    parser.add_argument("--texture-params-file", help="Path to texture/refine params JSON file")
    parser.add_argument("--params-json", help="Model-specific params as a JSON object")
    parser.add_argument("--params-file", help="Path to model-specific params JSON file")
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_SECONDS, help=f"Generation timeout in seconds (default: {DEFAULT_TIMEOUT_SECONDS})")
    parser.add_argument("--poll", type=float, default=DEFAULT_POLL_SECONDS, help=f"Polling interval in seconds (default: {DEFAULT_POLL_SECONDS})")
    parser.add_argument("--progress", action="store_true", help="Emit progress JSON lines to stderr while waiting")
    if batch:
        parser.add_argument("--continue-on-error", action="store_true", help="Continue batch after an image fails")


def _add_serve_options(parser: argparse.ArgumentParser, *, include_start: bool = False) -> None:
    if include_start:
        parser.add_argument("--start", action="store_true", help="Start the backend if health check fails")
    parser.add_argument("--api-dir", help="Directory containing Modly API main.py")
    parser.add_argument("--python", help="Python executable with Modly API dependencies installed")
    parser.add_argument("--host", default="127.0.0.1", help="Backend host (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8765, help="Backend port (default: 8765)")
    parser.add_argument("--models-dir", help="Models directory for the backend")
    parser.add_argument("--workspace-dir", help="Workspace directory for generated meshes")
    parser.add_argument("--extensions-dir", help="Extensions directory for the backend")
    parser.add_argument("--model", help="Initial SELECTED_MODEL_ID")
    parser.add_argument("--hf-token", help="Hugging Face token for gated models")
    parser.add_argument("--detach", action="store_true", help="Start in background and print pid")
    parser.add_argument("--print-command", action="store_true", help="Print resolved command/env without starting")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="modly-cli",
        description="Tiny stdlib-only CLI for agents calling a running Modly desktop API.",
    )
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help=f"Modly API URL (default: {DEFAULT_BASE_URL})")
    parser.add_argument("--request-timeout", type=float, default=30, help="Per-request timeout in seconds (default: 30)")
    parser.add_argument("--compact", action="store_true", help="Print compact one-line JSON")
    parser.add_argument("--quiet", action="store_true", help="Suppress progress output; final JSON is still printed")
    sub = parser.add_subparsers(dest="command", required=True)

    health = sub.add_parser("health", help="Check that Modly's local API is reachable")
    health.set_defaults(func=cmd_health)

    status = sub.add_parser("status", help="Show API health and active model status")
    status.set_defaults(func=cmd_status)

    models = sub.add_parser("models", help="List installed/available model adapters")
    models.set_defaults(func=cmd_models)

    params = sub.add_parser("params", help="Show model parameter schema")
    params.add_argument("--model", default="auto", help="Model id, 'active', or 'auto' (default: auto)")
    params.set_defaults(func=cmd_params)

    job = sub.add_parser("job", help="Show one generation job status")
    job.add_argument("job_id")
    job.set_defaults(func=cmd_job)

    cancel = sub.add_parser("cancel", help="Cancel one generation job")
    cancel.add_argument("job_id")
    cancel.set_defaults(func=cmd_cancel)

    gen = sub.add_parser("generate", help="Generate a 3D mesh from an image, wait, export it, and print JSON")
    _add_generation_options(gen, image=True, output=True)
    gen.set_defaults(func=cmd_generate)

    comfy = sub.add_parser("comfy-image", help="Run a preconfigured ComfyUI workflow and save its first image output")
    _add_comfy_options(comfy)
    comfy.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_SECONDS, help=f"ComfyUI timeout in seconds (default: {DEFAULT_TIMEOUT_SECONDS})")
    comfy.add_argument("--poll", type=float, default=DEFAULT_POLL_SECONDS, help=f"Polling interval in seconds (default: {DEFAULT_POLL_SECONDS})")
    comfy.add_argument("--progress", action="store_true", help="Emit progress JSON lines to stderr while waiting")
    comfy.set_defaults(func=cmd_comfy_image)

    wf = sub.add_parser("generate-from-workflow", help="Run a ComfyUI workflow (default: Trellis2Workflow), feed its image output into Modly, and export the mesh")
    _add_comfy_options(wf)
    _add_generation_options(wf, image=False, output=True)
    wf.set_defaults(func=cmd_generate_from_workflow)

    exp = sub.add_parser("export", help="Export an existing workspace mesh path")
    exp.add_argument("--path", required=True, help="Workspace-relative mesh path, e.g. Agent/foo.glb")
    exp.add_argument("--output", required=True, help="Destination file path")
    exp.add_argument("--format", choices=EXPORT_FORMATS, default="glb", help="Export format (default: glb)")
    exp.set_defaults(func=cmd_export)

    batch = sub.add_parser("batch", help="Generate meshes sequentially from an image directory or manifest JSON")
    group = batch.add_mutually_exclusive_group(required=True)
    group.add_argument("--input-dir", help="Directory of .png/.jpg/.jpeg/.webp images")
    group.add_argument("--manifest", help="JSON list or object with jobs/images entries")
    batch.add_argument("--output-dir", help="Directory for exported meshes; required for --input-dir")
    _add_generation_options(batch, image=False, output=False, batch=True)
    batch.set_defaults(func=cmd_batch)

    serve = sub.add_parser("serve", help="Start Modly FastAPI backend without Electron UI")
    _add_serve_options(serve)
    serve.set_defaults(func=cmd_serve)

    ensure = sub.add_parser("ensure-server", help="Check API health and optionally start headless backend")
    _add_serve_options(ensure, include_start=True)
    ensure.add_argument("--fail-on-unavailable", action="store_true", help="Exit nonzero when API is unavailable")
    ensure.set_defaults(func=cmd_ensure_server)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = None
    try:
        args = parser.parse_args(argv)
        return int(args.func(args))
    except ModlyCliError as exc:
        _json_print({"ok": False, "error": str(exc)}, compact=getattr(args, "compact", False) if args else False)
        return 1
    except KeyboardInterrupt:
        _json_print({"ok": False, "error": "interrupted"}, compact=getattr(args, "compact", False) if args else False)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())

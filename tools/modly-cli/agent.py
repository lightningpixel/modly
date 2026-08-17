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
import secrets
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

def _int_env(primary: str, fallback: str, default: int) -> int:
    value = os.environ.get(primary, os.environ.get(fallback, str(default)))
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _float_env(primary: str, fallback: str, default: float) -> float:
    value = os.environ.get(primary, os.environ.get(fallback, str(default)))
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


DEFAULT_BASE_URL = os.environ.get("MODLY_API_URL", "http://127.0.0.1:8765")
_CLI_TOKEN = ""
DEFAULT_TIMEOUT_SECONDS = _int_env("MODLY_CLI_TIMEOUT", "MODLY_AGENT_TIMEOUT", 1800)
DEFAULT_POLL_SECONDS = _float_env("MODLY_CLI_POLL_SECONDS", "MODLY_AGENT_POLL_SECONDS", 2.0)
EXPORT_FORMATS = ("glb", "stl", "obj", "ply")
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}
WORKFLOW_ASSET_SUFFIXES = {".glb", ".gltf", ".obj", ".stl", ".ply"}


class ModlyCliError(RuntimeError):
    """Expected user/API failure that should be reported as JSON."""

    def __init__(self, message: str, *, code: str = "MODLY_CLI_ERROR", http_status: int | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.http_status = http_status


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
    req = urllib.request.Request(url, data=data, method=method, headers=_api_headers(headers))
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise ModlyCliError(f"HTTP {exc.code} from {url}: {detail}", code=f"HTTP_{exc.code}", http_status=exc.code) from exc
    except urllib.error.URLError as exc:
        raise ModlyCliError(f"Cannot reach Modly API at {url}: {exc.reason}", code="API_UNAVAILABLE") from exc
    try:
        return json.loads(raw) if raw else {}
    except json.JSONDecodeError as exc:
        raise ModlyCliError(f"Expected JSON from {url}, got: {raw[:500]}", code="INVALID_JSON_RESPONSE") from exc


def _download(url: str, dest: Path, *, timeout: float) -> int:
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        req = urllib.request.Request(url, headers=_api_headers())
        with urllib.request.urlopen(req, timeout=timeout) as resp, dest.open("wb") as fh:
            total = 0
            while True:
                chunk = resp.read(1024 * 1024)
                if not chunk:
                    return total
                fh.write(chunk)
                total += len(chunk)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise ModlyCliError(f"HTTP {exc.code} while downloading {url}: {detail}", code=f"HTTP_{exc.code}", http_status=exc.code) from exc
    except urllib.error.URLError as exc:
        raise ModlyCliError(f"Cannot download {url}: {exc.reason}", code="DOWNLOAD_FAILED") from exc
    except OSError as exc:
        raise ModlyCliError(f"Cannot write to {dest}: {exc}", code="WRITE_FAILED") from exc


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
        return _validate_workspace_path(urllib.parse.unquote(path[len(prefix):]))
    return _validate_workspace_path(urllib.parse.unquote(path))


def _is_windows_drive_component(component: str) -> bool:
    return len(component) >= 2 and component[0].isalpha() and component[1] == ":"


def _validate_workspace_path(workspace_path: str) -> str:
    value = str(workspace_path)
    normalized = value.replace("\\", "/")
    parts = normalized.split("/")
    if (
        not value
        or value.startswith(("/", "\\"))
        or urllib.parse.urlparse(value).scheme
        or any(part == ".." for part in parts)
        or any(_is_windows_drive_component(part) for part in parts)
    ):
        raise ModlyCliError(f"Invalid workspace path: {workspace_path}", code="INVALID_WORKSPACE_PATH")
    return value


def _export_workspace_path(base_url: str, workspace_path: str, fmt: str, dest: Path, *, timeout: float) -> int:
    workspace_path = _validate_workspace_path(workspace_path)
    export_url = f"{base_url.rstrip('/')}/export/{urllib.parse.quote(fmt)}?{urllib.parse.urlencode({'path': workspace_path})}"
    return _download(export_url, dest, timeout=timeout)


def _try_health(base_url: str, timeout: float) -> dict[str, Any] | None:
    try:
        health = _request_json("GET", f"{base_url.rstrip('/')}/health", timeout=timeout)
    except ModlyCliError:
        return None
    return health if isinstance(health, dict) else {"raw": health}


def _require_health(base_url: str, timeout: float) -> dict[str, Any]:
    health = _request_json("GET", f"{base_url.rstrip('/')}/health", timeout=timeout)
    return health if isinstance(health, dict) else {"raw": health}


def _model_catalog(base_url: str, timeout: float) -> list[dict[str, Any]]:
    data = _request_json("GET", f"{base_url.rstrip('/')}/model/all", timeout=timeout)
    if not isinstance(data, list):
        raise ModlyCliError(f"Expected /model/all to return a list, got: {data}", code="INVALID_MODEL_CATALOG")
    return [model for model in data if isinstance(model, dict)]


def _model_ids(models: list[dict[str, Any]]) -> set[str]:
    return {str(model["id"]) for model in models if model.get("id")}


def _validate_model_id(base_url: str, request_timeout: float, model_id: str, models: list[dict[str, Any]] | None = None) -> str:
    models = models if models is not None else _model_catalog(base_url, request_timeout)
    ids = _model_ids(models)
    if model_id not in ids:
        available = ", ".join(sorted(ids)) or "(none)"
        raise ModlyCliError(
            f"Unknown model id '{model_id}'. Use one of: {available}",
            code="INVALID_MODEL_ID",
        )
    return model_id


def _recovery_meta(base_url: str, run_id: str, *, legacy: bool = False, kind: str = "workflow-run", extra: dict[str, Any] | None = None) -> dict[str, Any]:
    prefix = "python tools/modly-cli/agent.py"
    if base_url.rstrip("/") != DEFAULT_BASE_URL.rstrip("/"):
        prefix = f"{prefix} --base-url {base_url.rstrip('/')}"
    if legacy:
        group = "legacy job"
        cancel = "legacy cancel"
    elif kind == "process-run":
        group = "process-run status"
        cancel = "process-run cancel"
    else:
        group = "workflow-run status"
        cancel = "workflow-run cancel"
    meta = {
        "status_command": f"{prefix} {group} {run_id}",
        "cancel_command": f"{prefix} {cancel} {run_id}",
        "legacy": legacy,
    }
    if extra:
        meta.update(extra)
    return meta


def _unsupported_process(message: str = "This process is not available through the canonical process-run contract.") -> ModlyCliError:
    return ModlyCliError(message, code="UNSUPPORTED_PROCESS")


def _request_supported_contract(method: str, url: str, *, timeout: float, data: bytes | None = None, headers: dict[str, str] | None = None) -> Any:
    try:
        return _request_json(method, url, timeout=timeout, data=data, headers=headers)
    except ModlyCliError as exc:
        if exc.http_status == 404:
            raise _unsupported_process() from exc
        raise


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


def _modly_user_data_dirs() -> list[Path]:
    dirs: list[Path] = [Path.home() / "Library" / "Application Support" / "Modly"]
    for appdata in _windows_env_paths("APPDATA"):
        dirs.append(appdata / "Modly")
    dirs.append(Path.home() / ".config" / "Modly")
    return dirs


def _load_modly_settings() -> dict[str, Any]:
    for directory in _modly_user_data_dirs():
        path = directory / "settings.json"
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                return data if isinstance(data, dict) else {}
            except (OSError, json.JSONDecodeError):
                return {}
    return {}


def _read_token_file() -> str:
    for directory in _modly_user_data_dirs():
        path = directory / "api-token"
        if path.is_file():
            try:
                token = path.read_text(encoding="utf-8").strip()
            except OSError:
                continue
            if token:
                return token
    return ""


def _resolve_api_token() -> str:
    if _CLI_TOKEN:
        return _CLI_TOKEN
    env = os.environ.get("MODLY_API_TOKEN", "").strip()
    if env:
        return env
    return _read_token_file()


def _api_headers(extra: dict[str, str] | None = None) -> dict[str, str]:
    headers = dict(extra or {})
    token = _resolve_api_token()
    if token:
        headers.setdefault("Authorization", f"Bearer {token}")
        headers.setdefault("X-Modly-Token", token)
    return headers


def _ensure_serve_token(env: dict[str, str]) -> str:
    token = (env.get("MODLY_API_TOKEN") or os.environ.get("MODLY_API_TOKEN") or "").strip()
    if not token:
        token = secrets.token_hex(32)
    env["MODLY_API_TOKEN"] = token
    return token


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
    _ensure_serve_token(env)
    if getattr(args, "allow_remote", False) or args.host not in {"127.0.0.1", "localhost", "::1"}:
        env["MODLY_API_ALLOW_REMOTE"] = "1"
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
    _require_health(base_url, args.request_timeout)
    data = _request_json("GET", f"{base_url}/model/all", timeout=args.request_timeout)
    _json_print({"ok": True, "base_url": base_url, "models": data, "meta": {"canonical": "model list"}}, compact=args.compact)
    return 0


def cmd_model_status(args: argparse.Namespace) -> int:
    base_url = args.base_url.rstrip("/")
    _require_health(base_url, args.request_timeout)
    data = _request_json("GET", f"{base_url}/model/status", timeout=args.request_timeout)
    _json_print({"ok": True, "base_url": base_url, "model": data}, compact=args.compact)
    return 0


def cmd_model_list(args: argparse.Namespace) -> int:
    return cmd_models(args)


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
    active = _request_json("GET", f"{base_url.rstrip('/')}/model/status", timeout=request_timeout)
    if not isinstance(active, dict) or not active.get("id"):
        raise ModlyCliError(f"Could not resolve active model id: {active}", code="MODEL_NOT_READY")
    return _validate_model_id(base_url, request_timeout, str(active["id"]))


def _resolve_model_id(args: argparse.Namespace, base_url: str) -> str:
    model_id = args.model
    if not model_id or model_id == "auto":
        return _choose_auto_model(base_url, args.request_timeout)
    if model_id == "active":
        active = _request_json("GET", f"{base_url}/model/status", timeout=args.request_timeout)
        if not isinstance(active, dict) or not active.get("id"):
            raise ModlyCliError(f"Could not resolve active model id: {active}", code="MODEL_NOT_READY")
        return _validate_model_id(base_url, args.request_timeout, str(active["id"]))
    return _validate_model_id(base_url, args.request_timeout, str(model_id))


def cmd_params(args: argparse.Namespace) -> int:
    base_url = args.base_url.rstrip("/")
    _require_health(base_url, args.request_timeout)
    model_id = _resolve_model_id(args, base_url)
    query = ""
    if model_id:
        query = "?" + urllib.parse.urlencode({"model_id": model_id})
    params = _request_json("GET", f"{base_url}/model/params{query}", timeout=args.request_timeout)
    _json_print({"ok": True, "base_url": base_url, "model_id": model_id, "params": params, "meta": {"canonical": "model params"}}, compact=args.compact)
    return 0


def cmd_job(args: argparse.Namespace) -> int:
    base_url = args.base_url.rstrip("/")
    _require_health(base_url, args.request_timeout)
    status = _request_json("GET", f"{base_url}/generate/status/{urllib.parse.quote(args.job_id)}", timeout=args.request_timeout)
    _json_print({"ok": True, "base_url": base_url, "job_id": args.job_id, "status": status, "meta": _recovery_meta(base_url, args.job_id, legacy=True)}, compact=args.compact)
    return 0


def cmd_cancel(args: argparse.Namespace) -> int:
    base_url = args.base_url.rstrip("/")
    _require_health(base_url, args.request_timeout)
    result = _request_json("POST", f"{base_url}/generate/cancel/{urllib.parse.quote(args.job_id)}", timeout=args.request_timeout)
    _json_print({"ok": True, "base_url": base_url, "job_id": args.job_id, "cancel": result, "meta": _recovery_meta(base_url, args.job_id, legacy=True)}, compact=args.compact)
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


def _run_comfy_workflow(args: argparse.Namespace) -> dict[str, Any]:
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
        raise ModlyCliError(f"Timed out waiting for ComfyUI prompt {prompt_id}", code="TIMEOUT")

    return {"ok": True, "comfy_url": host, "workflow": args.workflow, "prompt_id": str(prompt_id), "history": history}


def _iter_comfy_file_refs(value: Any) -> list[dict[str, Any]]:
    refs: list[dict[str, Any]] = []
    if isinstance(value, dict):
        filename = value.get("filename")
        if isinstance(filename, str) and filename:
            refs.append(value)
        for child in value.values():
            refs.extend(_iter_comfy_file_refs(child))
    elif isinstance(value, list):
        for child in value:
            refs.extend(_iter_comfy_file_refs(child))
    return refs


def _comfy_ref_suffix(ref: dict[str, Any]) -> str:
    filename = str(ref.get("filename") or "")
    return Path(urllib.parse.urlparse(filename).path).suffix.lower()


def _find_comfy_file_ref(history: dict[str, Any], suffixes: set[str]) -> dict[str, Any] | None:
    outputs = history.get("outputs") if isinstance(history.get("outputs"), dict) else history
    for ref in _iter_comfy_file_refs(outputs):
        if _comfy_ref_suffix(ref) in suffixes:
            return ref
    return None


def _comfy_view_url(host: str, ref: dict[str, Any]) -> str:
    query = urllib.parse.urlencode({
        "filename": ref.get("filename", ""),
        "subfolder": ref.get("subfolder", ""),
        "type": ref.get("type", "output"),
    })
    return f"{host.rstrip('/')}/view?{query}"


def _download_comfy_ref(host: str, ref: dict[str, Any], dest: Path, *, timeout: float) -> int:
    return _download(_comfy_view_url(host, ref), dest, timeout=timeout)


def _temp_path_for_comfy_ref(ref: dict[str, Any], *, default_suffix: str) -> Path:
    suffix = _comfy_ref_suffix(ref) or default_suffix
    tmp = tempfile.NamedTemporaryFile(delete=False, prefix="modly-comfy-", suffix=suffix)
    tmp.close()
    return Path(tmp.name)


def _download_comfy_image_output(args: argparse.Namespace, comfy: dict[str, Any]) -> dict[str, Any]:
    host = str(comfy["comfy_url"])
    prompt_id = str(comfy["prompt_id"])
    history = comfy["history"] if isinstance(comfy.get("history"), dict) else {}

    image_ref = _find_comfy_file_ref(history, IMAGE_SUFFIXES)
    if not image_ref:
        raise ModlyCliError(f"ComfyUI prompt {prompt_id} completed without a supported image output", code="NO_WORKFLOW_OUTPUT")

    out_path: Path | None = getattr(args, "comfy_output", None)
    if out_path:
        out = Path(out_path).expanduser().resolve()
    else:
        out = _temp_path_for_comfy_ref(image_ref, default_suffix=".png")
    bytes_written = _download_comfy_ref(host, image_ref, out, timeout=args.request_timeout)
    return {
        "ok": True,
        "comfy_url": host,
        "workflow": comfy["workflow"],
        "prompt_id": prompt_id,
        "image_path": str(out),
        "bytes_written": bytes_written,
        "image": image_ref,
    }


def _run_comfy_image(args: argparse.Namespace) -> dict[str, Any]:
    comfy = _run_comfy_workflow(args)
    return _download_comfy_image_output(args, comfy)


def cmd_comfy_image(args: argparse.Namespace) -> int:
    result = _run_comfy_image(args)
    result["meta"] = {"experimental": True, "canonical": False}
    _json_print(result, compact=args.compact)
    return 0


def cmd_generate_from_workflow(args: argparse.Namespace) -> int:
    comfy = _run_comfy_workflow(args)
    host = str(comfy["comfy_url"])
    prompt_id = str(comfy["prompt_id"])
    history = comfy["history"] if isinstance(comfy.get("history"), dict) else {}
    asset_ref = _find_comfy_file_ref(history, WORKFLOW_ASSET_SUFFIXES)
    if asset_ref:
        if not args.output:
            raise ModlyCliError("--output is required when a workflow produces a direct 3D asset", code="OUTPUT_REQUIRED")
        export_dest = Path(args.output).expanduser().resolve()
        bytes_written = _download_comfy_ref(host, asset_ref, export_dest, timeout=args.request_timeout)
        _json_print({
            "ok": True,
            "source": "comfy-workflow",
            "output_type": "asset",
            "export_path": str(export_dest),
            "bytes_written": bytes_written,
            "workflow": comfy["workflow"],
            "prompt_id": prompt_id,
            "comfy_url": host,
            "asset": asset_ref,
            "meta": {"experimental": True, "canonical": False},
        }, compact=args.compact)
        return 0

    comfy_image = _download_comfy_image_output(args, comfy)
    _require_health(args.base_url.rstrip("/"), args.request_timeout)
    output = Path(args.output).expanduser().resolve() if args.output else None
    result = _generate_one(args, Path(str(comfy_image["image_path"])), output)
    result["source"] = "comfy-workflow"
    result["output_type"] = "image"
    result["comfy"] = comfy_image
    result.setdefault("meta", {})["experimental"] = True
    _json_print(result, compact=args.compact)
    return 0


def _canonical_generation_params(args: argparse.Namespace) -> dict[str, Any]:
    params = _parse_params(getattr(args, "params_json", None), getattr(args, "params_file", None))
    params.setdefault("remesh", getattr(args, "remesh", "quad"))
    params.setdefault("enable_texture", bool(getattr(args, "enable_texture", True)))
    params.setdefault("texture_resolution", getattr(args, "texture_resolution", 1024))
    return params


def _workflow_workspace_path(status: dict[str, Any]) -> str:
    scene_candidate = status.get("scene_candidate")
    if isinstance(scene_candidate, dict) and scene_candidate.get("workspace_path"):
        return _validate_workspace_path(str(scene_candidate["workspace_path"]))
    output_url = str(status.get("output_url") or "")
    if output_url:
        return _workspace_relative_path(output_url)
    raise ModlyCliError(f"Workflow run completed without an output path: {status}", code="MISSING_OUTPUT")


def _start_workflow_run(args: argparse.Namespace, image_path: Path, *, base_url: str, model_id: str, params: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    fields = {
        "model_id": model_id,
        "params": json.dumps(params, separators=(",", ":")),
    }
    if getattr(args, "collection", None):
        fields["collection"] = str(args.collection)
    body, content_type = _multipart_form(fields, "image", image_path)
    started = _request_json(
        "POST",
        f"{base_url}/workflow-runs/from-image",
        timeout=args.request_timeout,
        data=body,
        headers={"Content-Type": content_type},
    )
    run_id = started.get("run_id") if isinstance(started, dict) else None
    if not run_id:
        raise ModlyCliError(f"Modly did not return a run_id: {started}", code="MISSING_RUN_ID")
    return str(run_id), started if isinstance(started, dict) else {"raw": started}


def _poll_workflow_run(args: argparse.Namespace, *, base_url: str, run_id: str, progress_label: str = "workflow-run") -> tuple[dict[str, Any], str]:
    deadline = time.monotonic() + args.timeout
    last_status: dict[str, Any] = {}
    while time.monotonic() < deadline:
        status = _request_json("GET", f"{base_url}/workflow-runs/{urllib.parse.quote(str(run_id))}", timeout=args.request_timeout)
        last_status = status if isinstance(status, dict) else {"raw": status}
        state = last_status.get("status")
        if state == "done":
            return last_status, _workflow_workspace_path(last_status)
        if state in {"error", "cancelled"}:
            raise ModlyCliError(f"Workflow run {run_id} ended with status {state}: {last_status}", code="WORKFLOW_RUN_FAILED")
        if getattr(args, "progress", False) and not getattr(args, "quiet", False):
            progress = last_status.get("progress", 0)
            step = last_status.get("step", "")
            print(json.dumps({"phase": progress_label, "run_id": run_id, "status": state, "progress": progress, "step": step}), file=sys.stderr)
        time.sleep(args.poll)

    raise ModlyCliError(f"Timed out waiting for workflow run {run_id}. Last status: {last_status}", code="TIMEOUT")


def _run_workflow_run(
    args: argparse.Namespace,
    image_path: Path,
    *,
    base_url: str,
    model_id: str,
    params: dict[str, Any],
    wait: bool,
) -> tuple[str, dict[str, Any], str | None]:
    run_id, started = _start_workflow_run(args, image_path, base_url=base_url, model_id=model_id, params=params)
    if not wait:
        return run_id, started, None
    status, rel_path = _poll_workflow_run(args, base_url=base_url, run_id=run_id)
    return run_id, status, rel_path


def cmd_workflow_run_start(args: argparse.Namespace) -> int:
    base_url = args.base_url.rstrip("/")
    _require_health(base_url, args.request_timeout)
    image_path = Path(args.image).expanduser().resolve()
    if not image_path.exists() or not image_path.is_file():
        raise ModlyCliError(f"image file not found: {image_path}", code="IMAGE_NOT_FOUND")
    model_id = _resolve_model_id(args, base_url)
    params = _canonical_generation_params(args)
    run_id, status, rel_path = _run_workflow_run(args, image_path, base_url=base_url, model_id=model_id, params=params, wait=getattr(args, "wait", False))
    payload: dict[str, Any] = {
        "ok": True,
        "base_url": base_url,
        "image": str(image_path),
        "model_id": model_id,
        "run": {"kind": "workflowRun", "id": run_id},
        "status": status,
        "meta": _recovery_meta(base_url, run_id),
    }
    if rel_path:
        payload["workspace_path"] = rel_path
    _json_print(payload, compact=args.compact)
    return 0


def cmd_workflow_run_status(args: argparse.Namespace) -> int:
    base_url = args.base_url.rstrip("/")
    _require_health(base_url, args.request_timeout)
    status = _request_json("GET", f"{base_url}/workflow-runs/{urllib.parse.quote(args.run_id)}", timeout=args.request_timeout)
    _json_print({"ok": True, "base_url": base_url, "run": {"kind": "workflowRun", "id": args.run_id}, "status": status, "meta": _recovery_meta(base_url, args.run_id)}, compact=args.compact)
    return 0


def cmd_workflow_run_cancel(args: argparse.Namespace) -> int:
    base_url = args.base_url.rstrip("/")
    _require_health(base_url, args.request_timeout)
    result = _request_json("POST", f"{base_url}/workflow-runs/{urllib.parse.quote(args.run_id)}/cancel", timeout=args.request_timeout)
    _json_print({"ok": True, "base_url": base_url, "run": {"kind": "workflowRun", "id": args.run_id}, "cancel": result, "meta": _recovery_meta(base_url, args.run_id)}, compact=args.compact)
    return 0


def _ensure_no_external_texture_process(args: argparse.Namespace) -> None:
    if getattr(args, "texture_model", "auto") not in (None, "", "auto"):
        raise _unsupported_process()
    if getattr(args, "texture_params_json", None) or getattr(args, "texture_params_file", None):
        raise _unsupported_process()


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


def _generate_one(args: argparse.Namespace, image_path: Path, output_path: Path | None = None) -> dict[str, Any]:
    base_url = args.base_url.rstrip("/")
    _require_health(base_url, args.request_timeout)
    image_path = image_path.expanduser().resolve()
    if not image_path.exists() or not image_path.is_file():
        raise ModlyCliError(f"image file not found: {image_path}", code="IMAGE_NOT_FOUND")

    _ensure_no_external_texture_process(args)
    params = _canonical_generation_params(args)
    model_id = _resolve_model_id(args, base_url)
    run_id, status, rel_path = _run_workflow_run(
        args,
        image_path,
        base_url=base_url,
        model_id=model_id,
        params=params,
        wait=True,
    )
    assert rel_path is not None

    export_dest = None
    bytes_written = None
    if not getattr(args, "no_export", False):
        export_dest = output_path or image_path.resolve().parent / f"{Path(rel_path).stem}.{args.format}"
        export_dest = export_dest.expanduser().resolve()
        bytes_written = _export_workspace_path(base_url, rel_path, args.format, export_dest, timeout=args.request_timeout)
    result: dict[str, Any] = {
        "ok": True,
        "base_url": base_url,
        "image": str(image_path),
        "model_id": model_id,
        "run": {"kind": "workflowRun", "id": run_id},
        "status": status,
        "workspace_path": rel_path,
        "texture_enabled": bool(params.get("enable_texture")),
        "export_format": args.format,
        "meta": _recovery_meta(base_url, run_id),
    }
    if export_dest is not None:
        result["export_path"] = str(export_dest)
        result["bytes_written"] = bytes_written
    return result


def cmd_generate(args: argparse.Namespace) -> int:
    output = Path(args.output).expanduser().resolve() if args.output else None
    result = _generate_one(args, Path(args.image), output)
    _json_print(result, compact=args.compact)
    return 0


def cmd_legacy_generate(args: argparse.Namespace) -> int:
    base_url = args.base_url.rstrip("/")
    _require_health(base_url, args.request_timeout)
    image_path = Path(args.image).expanduser().resolve()
    if not image_path.exists() or not image_path.is_file():
        raise ModlyCliError(f"image file not found: {image_path}", code="IMAGE_NOT_FOUND")
    params = _parse_params(getattr(args, "params_json", None), getattr(args, "params_file", None))
    model_id = _resolve_model_id(args, base_url)
    job_id, status, rel_path = _run_generation_job(
        args,
        image_path,
        base_url=base_url,
        model_id=model_id,
        params=params,
        progress_label="legacy-generate",
    )
    export_dest = None
    bytes_written = None
    if not getattr(args, "no_export", False):
        export_dest = Path(args.output).expanduser().resolve() if args.output else image_path.resolve().parent / f"{Path(rel_path).stem}.{args.format}"
        bytes_written = _export_workspace_path(base_url, rel_path, args.format, export_dest, timeout=args.request_timeout)
    payload: dict[str, Any] = {
        "ok": True,
        "base_url": base_url,
        "image": str(image_path),
        "model_id": model_id,
        "job_id": job_id,
        "status": status,
        "workspace_path": rel_path,
        "export_format": args.format,
        "meta": _recovery_meta(base_url, job_id, legacy=True),
    }
    if export_dest is not None:
        payload["export_path"] = str(export_dest)
        payload["bytes_written"] = bytes_written
    _json_print(payload, compact=args.compact)
    return 0


def cmd_export(args: argparse.Namespace) -> int:
    base_url = args.base_url.rstrip("/")
    _require_health(base_url, args.request_timeout)
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
    try:
        for image, output, fmt in jobs:
            args.format = fmt
            try:
                results.append(_generate_one(args, image, output))
            except ModlyCliError as exc:
                failures += 1
                results.append({"ok": False, "image": str(image), "error": str(exc)})
                if not args.continue_on_error:
                    break
    finally:
        args.format = original_format
    _json_print({"ok": failures == 0, "count": len(results), "failures": failures, "results": results}, compact=args.compact)
    return 0 if failures == 0 else 1


def cmd_serve(args: argparse.Namespace) -> int:
    api_dir, _python, env, cmd, base_url = _resolve_serve_config(args)
    public_env = {k: env.get(k, "") for k in ["MODELS_DIR", "WORKSPACE_DIR", "EXTENSIONS_DIR", "SELECTED_MODEL_ID"]}
    meta = {"dev_only": True, "canonical": False}
    payload = {"ok": True, "cmd": cmd, "cwd": str(api_dir), "base_url": base_url, "env": public_env, "token": env.get("MODLY_API_TOKEN", ""), "meta": meta}
    if args.print_command:
        _json_print(payload, compact=args.compact)
        return 0
    proc = _start_backend(cmd, api_dir=api_dir, env=env, detach=args.detach)
    if args.detach:
        payload.update({"started": True, "pid": proc.pid})
        _json_print(payload, compact=args.compact)
        return 0
    return int(proc.wait())


def cmd_ensure_server(args: argparse.Namespace) -> int:
    base_url = args.base_url.rstrip("/")
    health = _try_health(base_url, args.request_timeout)
    meta = {"dev_only": True, "canonical": False}
    if health:
        _json_print({"ok": True, "started": False, "base_url": base_url, "health": health, "meta": meta}, compact=args.compact)
        return 0
    if not args.start:
        message = "Modly API is not running; launch Modly or run ensure-server --start"
        if args.fail_on_unavailable:
            raise ModlyCliError(message, code="API_UNAVAILABLE")
        _json_print({"ok": False, "started": False, "base_url": base_url, "error": message, "code": "API_UNAVAILABLE", "message": message, "meta": meta}, compact=args.compact)
        return 0
    api_dir, _python, env, cmd, resolved_url = _resolve_serve_config(args)
    public_env = {k: env.get(k, "") for k in ["MODELS_DIR", "WORKSPACE_DIR", "EXTENSIONS_DIR", "SELECTED_MODEL_ID"]}
    payload = {"ok": True, "started": False, "base_url": resolved_url, "cmd": cmd, "cwd": str(api_dir), "env": public_env, "token": env.get("MODLY_API_TOKEN", ""), "meta": meta}
    if args.print_command:
        payload["would_start"] = True
        _json_print(payload, compact=args.compact)
        return 0
    proc = _start_backend(cmd, api_dir=api_dir, env=env, detach=args.detach)
    payload.update({"started": True, "pid": proc.pid})
    _json_print(payload, compact=args.compact)
    if not args.detach:
        return int(proc.wait())
    return 0


def cmd_capability_list(args: argparse.Namespace) -> int:
    base_url = args.base_url.rstrip("/")
    _require_health(base_url, args.request_timeout)
    data = _request_supported_contract("GET", f"{base_url}/automation/capabilities", timeout=args.request_timeout)
    _json_print({"ok": True, "base_url": base_url, "capabilities": data}, compact=args.compact)
    return 0


def _json_arg(value: str | None, file_value: str | None) -> dict[str, Any]:
    return _parse_params(value, file_value)


def cmd_process_run_start(args: argparse.Namespace) -> int:
    base_url = args.base_url.rstrip("/")
    _require_health(base_url, args.request_timeout)
    payload = _json_arg(getattr(args, "input_json", None), getattr(args, "input_file", None))
    body = json.dumps({"process": args.process, "input": payload}, separators=(",", ":")).encode("utf-8")
    data = _request_supported_contract("POST", f"{base_url}/process-runs", timeout=args.request_timeout, data=body, headers={"Content-Type": "application/json"})
    run_id = data.get("run_id") if isinstance(data, dict) else None
    output = {"ok": True, "base_url": base_url, "run": {"kind": "processRun", "id": str(run_id) if run_id else ""}, "status": data}
    if run_id:
        output["meta"] = _recovery_meta(base_url, str(run_id), kind="process-run")
    _json_print(output, compact=args.compact)
    return 0


def cmd_process_run_status(args: argparse.Namespace) -> int:
    base_url = args.base_url.rstrip("/")
    _require_health(base_url, args.request_timeout)
    data = _request_supported_contract("GET", f"{base_url}/process-runs/{urllib.parse.quote(args.run_id)}", timeout=args.request_timeout)
    _json_print({"ok": True, "base_url": base_url, "run": {"kind": "processRun", "id": args.run_id}, "status": data}, compact=args.compact)
    return 0


def cmd_process_run_cancel(args: argparse.Namespace) -> int:
    base_url = args.base_url.rstrip("/")
    _require_health(base_url, args.request_timeout)
    data = _request_supported_contract("POST", f"{base_url}/process-runs/{urllib.parse.quote(args.run_id)}/cancel", timeout=args.request_timeout)
    _json_print({"ok": True, "base_url": base_url, "run": {"kind": "processRun", "id": args.run_id}, "cancel": data}, compact=args.compact)
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
        parser.add_argument("--no-export", action="store_true", help="Do not download/export the completed workspace mesh")
    parser.add_argument("--format", choices=EXPORT_FORMATS, default="glb", help="Export format (default: glb)")
    parser.add_argument("--model", default="auto", help="Model id to use, 'active', or 'auto' (default: auto)")
    parser.add_argument("--collection", default="Agent", help="Modly workspace collection (default: Agent)")
    parser.add_argument("--remesh", choices=["quad", "triangle", "none"], default="quad", help="Remesh mode (default: quad)")
    parser.add_argument("--texture", dest="enable_texture", action="store_true", default=True, help="Enable texture generation (default)")
    parser.add_argument("--no-texture", dest="enable_texture", action="store_false", help="Disable texture generation for faster geometry-only smoke tests")
    parser.add_argument("--enable-texture", dest="enable_texture", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--texture-resolution", type=int, default=1024, help="Texture diffusion resolution when texturing is enabled")
    parser.add_argument("--texture-model", default="auto", help="External texture process id. Unsupported unless the server exposes canonical process-run support.")
    parser.add_argument("--texture-size", type=int, default=2048, help="Texture atlas size when texturing is enabled (default: 2048)")
    parser.add_argument("--texture-steps", type=int, default=30, help="Texture diffusion steps when texturing is enabled (default: 30)")
    parser.add_argument("--texture-guidance", type=float, default=3.0, help="Texture guidance strength when texturing is enabled (default: 3.0)")
    parser.add_argument("--texture-params-json", help="External texture process params as a JSON object")
    parser.add_argument("--texture-params-file", help="Path to external texture process params JSON file")
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
    parser.add_argument("--allow-remote", action="store_true", help="Allow non-loopback Host/Origin (use with --token)")
    parser.add_argument("--detach", action="store_true", help="Start in background and print pid")
    parser.add_argument("--print-command", action="store_true", help="Print resolved command/env without starting")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="modly-cli",
        description="Tiny stdlib-only CLI for agents calling a running Modly desktop API.",
    )
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help=f"Modly API URL (default: {DEFAULT_BASE_URL})")
    parser.add_argument("--token", default=os.environ.get("MODLY_API_TOKEN", ""), help="API token (default: MODLY_API_TOKEN or Electron userData/api-token)")
    parser.add_argument("--request-timeout", type=float, default=30, help="Per-request timeout in seconds (default: 30)")
    parser.add_argument("--compact", action="store_true", help="Print compact one-line JSON")
    parser.add_argument("--quiet", action="store_true", help="Suppress progress output; final JSON is still printed")
    canonical_commands = "{health,model,workflow-run,capability,process-run,generate,dev,experimental,legacy}"
    sub = parser.add_subparsers(dest="command", required=True, metavar=canonical_commands)

    health = sub.add_parser("health", help="Check that Modly's local API is reachable")
    health.set_defaults(func=cmd_health)

    status = sub.add_parser("status", help=argparse.SUPPRESS)
    status.set_defaults(func=cmd_status)

    model = sub.add_parser("model", help="Inspect canonical model state")
    model_sub = model.add_subparsers(dest="model_command", required=True)
    model_list = model_sub.add_parser("list", help="List model adapters known to the running app")
    model_list.set_defaults(func=cmd_model_list)
    model_status = model_sub.add_parser("status", help="Show active model status")
    model_status.set_defaults(func=cmd_model_status)
    model_params = model_sub.add_parser("params", help="Show parameter schema for a validated model id")
    model_params.add_argument("--model", default="auto", help="Model id, 'active', or 'auto' for the validated active model (default: auto)")
    model_params.set_defaults(func=cmd_params)

    workflow = sub.add_parser("workflow-run", help="Start, inspect, and cancel canonical workflow runs")
    workflow_sub = workflow.add_subparsers(dest="workflow_command", required=True)
    workflow_start = workflow_sub.add_parser("start", help="Start a workflow run from an image")
    _add_generation_options(workflow_start, image=True, output=False)
    workflow_start.add_argument("--wait", action="store_true", help="Wait for completion and include workspace_path")
    workflow_start.set_defaults(func=cmd_workflow_run_start)
    workflow_status = workflow_sub.add_parser("status", help="Show workflow run status")
    workflow_status.add_argument("run_id")
    workflow_status.set_defaults(func=cmd_workflow_run_status)
    workflow_cancel = workflow_sub.add_parser("cancel", help="Cancel a workflow run")
    workflow_cancel.add_argument("run_id")
    workflow_cancel.set_defaults(func=cmd_workflow_run_cancel)

    capability = sub.add_parser("capability", help="Discover canonical automation capabilities")
    capability_sub = capability.add_subparsers(dest="capability_command", required=True)
    capability_list = capability_sub.add_parser("list", help="List automation capabilities when the server exposes them")
    capability_list.set_defaults(func=cmd_capability_list)

    process = sub.add_parser("process-run", help="Start, inspect, and cancel canonical process runs")
    process_sub = process.add_subparsers(dest="process_command", required=True)
    process_start = process_sub.add_parser("start", help="Start a process run when the server exposes the canonical contract")
    process_start.add_argument("--process", required=True, help="Canonical process id")
    process_start.add_argument("--input-json", help="Process input as a JSON object")
    process_start.add_argument("--input-file", help="Path to process input JSON object")
    process_start.set_defaults(func=cmd_process_run_start)
    process_status = process_sub.add_parser("status", help="Show process run status")
    process_status.add_argument("run_id")
    process_status.set_defaults(func=cmd_process_run_status)
    process_cancel = process_sub.add_parser("cancel", help="Cancel a process run")
    process_cancel.add_argument("run_id")
    process_cancel.set_defaults(func=cmd_process_run_cancel)

    gen = sub.add_parser("generate", help="Generate a 3D mesh from an image, wait, export it, and print JSON")
    _add_generation_options(gen, image=True, output=True)
    gen.set_defaults(func=cmd_generate)

    exp = sub.add_parser("export", help=argparse.SUPPRESS)
    exp.add_argument("--path", required=True, help="Workspace-relative mesh path, e.g. Agent/foo.glb")
    exp.add_argument("--output", required=True, help="Destination file path")
    exp.add_argument("--format", choices=EXPORT_FORMATS, default="glb", help="Export format (default: glb)")
    exp.set_defaults(func=cmd_export)

    batch = sub.add_parser("batch", help=argparse.SUPPRESS)
    group = batch.add_mutually_exclusive_group(required=True)
    group.add_argument("--input-dir", help="Directory of .png/.jpg/.jpeg/.webp images")
    group.add_argument("--manifest", help="JSON list or object with jobs/images entries")
    batch.add_argument("--output-dir", help="Directory for exported meshes; required for --input-dir")
    _add_generation_options(batch, image=False, output=False, batch=True)
    batch.set_defaults(func=cmd_batch)

    dev = sub.add_parser("dev", help="Developer-only local API helpers")
    dev_sub = dev.add_subparsers(dest="dev_command", required=True)
    serve = dev_sub.add_parser("serve-api", help="Start only the FastAPI backend without Electron/Desktop bridge readiness")
    _add_serve_options(serve)
    serve.set_defaults(func=cmd_serve)
    ensure = dev_sub.add_parser("ensure-server", help="Check API health and optionally start only the FastAPI backend")
    _add_serve_options(ensure, include_start=True)
    ensure.add_argument("--fail-on-unavailable", action="store_true", help="Exit nonzero when API is unavailable")
    ensure.set_defaults(func=cmd_ensure_server)

    experimental = sub.add_parser("experimental", help="Experimental external orchestration helpers")
    experimental_sub = experimental.add_subparsers(dest="experimental_command", required=True)
    comfy = experimental_sub.add_parser("comfy-image", help="Run a preconfigured ComfyUI workflow and save its first image output")
    _add_comfy_options(comfy)
    comfy.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_SECONDS, help=f"ComfyUI timeout in seconds (default: {DEFAULT_TIMEOUT_SECONDS})")
    comfy.add_argument("--poll", type=float, default=DEFAULT_POLL_SECONDS, help=f"Polling interval in seconds (default: {DEFAULT_POLL_SECONDS})")
    comfy.add_argument("--progress", action="store_true", help="Emit progress JSON lines to stderr while waiting")
    comfy.set_defaults(func=cmd_comfy_image)
    wf = experimental_sub.add_parser("generate-from-workflow", help="Run a ComfyUI workflow and save or convert its output")
    _add_comfy_options(wf)
    _add_generation_options(wf, image=False, output=True)
    wf.set_defaults(func=cmd_generate_from_workflow)

    legacy = sub.add_parser("legacy", help="Explicit compatibility commands for /generate/* endpoints")
    legacy_sub = legacy.add_subparsers(dest="legacy_command", required=True)
    legacy_job = legacy_sub.add_parser("job", help="Show one legacy generation job status")
    legacy_job.add_argument("job_id")
    legacy_job.set_defaults(func=cmd_job)
    legacy_cancel = legacy_sub.add_parser("cancel", help="Cancel one legacy generation job")
    legacy_cancel.add_argument("job_id")
    legacy_cancel.set_defaults(func=cmd_cancel)
    legacy_gen = legacy_sub.add_parser("generate", help="Use the legacy /generate/from-image endpoint explicitly")
    _add_generation_options(legacy_gen, image=True, output=True)
    legacy_gen.set_defaults(func=cmd_legacy_generate)

    models_alias = sub.add_parser("models", help=argparse.SUPPRESS)
    models_alias.set_defaults(func=cmd_models)
    params_alias = sub.add_parser("params", help=argparse.SUPPRESS)
    params_alias.add_argument("--model", default="auto")
    params_alias.set_defaults(func=cmd_params)
    job_alias = sub.add_parser("job", help=argparse.SUPPRESS)
    job_alias.add_argument("job_id")
    job_alias.set_defaults(func=cmd_job)
    cancel_alias = sub.add_parser("cancel", help=argparse.SUPPRESS)
    cancel_alias.add_argument("job_id")
    cancel_alias.set_defaults(func=cmd_cancel)
    serve_alias = sub.add_parser("serve", help=argparse.SUPPRESS)
    _add_serve_options(serve_alias)
    serve_alias.set_defaults(func=cmd_serve)
    ensure_alias = sub.add_parser("ensure-server", help=argparse.SUPPRESS)
    _add_serve_options(ensure_alias, include_start=True)
    ensure_alias.add_argument("--fail-on-unavailable", action="store_true")
    ensure_alias.set_defaults(func=cmd_ensure_server)
    comfy_alias = sub.add_parser("comfy-image", help=argparse.SUPPRESS)
    _add_comfy_options(comfy_alias)
    comfy_alias.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_SECONDS)
    comfy_alias.add_argument("--poll", type=float, default=DEFAULT_POLL_SECONDS)
    comfy_alias.add_argument("--progress", action="store_true")
    comfy_alias.set_defaults(func=cmd_comfy_image)
    wf_alias = sub.add_parser("generate-from-workflow", help=argparse.SUPPRESS)
    _add_comfy_options(wf_alias)
    _add_generation_options(wf_alias, image=False, output=True)
    wf_alias.set_defaults(func=cmd_generate_from_workflow)
    hidden = {"status", "export", "batch", "models", "params", "job", "cancel", "serve", "ensure-server", "comfy-image", "generate-from-workflow"}
    # Hide compatibility aliases from help; argparse only exposes this via a private list.
    sub._choices_actions = [choice for choice in sub._choices_actions if getattr(choice, "dest", None) not in hidden]
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = None
    try:
        args = parser.parse_args(argv)
        global _CLI_TOKEN
        _CLI_TOKEN = str(getattr(args, "token", "") or "").strip()
        return int(args.func(args))
    except ModlyCliError as exc:
        _json_print({"ok": False, "code": exc.code, "message": exc.message, "error": exc.message}, compact=getattr(args, "compact", False) if args else False)
        return 1
    except KeyboardInterrupt:
        _json_print({"ok": False, "code": "INTERRUPTED", "message": "interrupted", "error": "interrupted"}, compact=getattr(args, "compact", False) if args else False)
        return 130
    except Exception as exc:
        _json_print({"ok": False, "code": "UNEXPECTED_ERROR", "message": str(exc), "error": str(exc)}, compact=getattr(args, "compact", False) if args else False)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

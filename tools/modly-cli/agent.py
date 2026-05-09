#!/usr/bin/env python3
"""Minimal agent-friendly CLI for the local Modly API.

The Electron app owns the FastAPI server. This tool is intentionally tiny and
stdlib-only so automation agents can call a running Modly instance without
opening the UI or depending on npm/Python packages from the repo.
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

DEFAULT_BASE_URL = os.environ.get("MODLY_API_URL", "http://127.0.0.1:8765")
DEFAULT_TIMEOUT_SECONDS = int(os.environ.get("MODLY_CLI_TIMEOUT", os.environ.get("MODLY_AGENT_TIMEOUT", "1800")))
DEFAULT_POLL_SECONDS = float(os.environ.get("MODLY_CLI_POLL_SECONDS", os.environ.get("MODLY_AGENT_POLL_SECONDS", "2")))


class ModlyCliError(RuntimeError):
    pass


def _json_print(data: dict[str, Any]) -> None:
    print(json.dumps(data, indent=2, sort_keys=True))


def _request_json(method: str, url: str, *, timeout: float, data: bytes | None = None, headers: dict[str, str] | None = None) -> Any:
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


def _default_export_path(image_path: Path, output_url: str, fmt: str) -> Path:
    stem = image_path.stem or "modly-export"
    rel = _workspace_relative_path(output_url)
    if rel:
        remote_stem = Path(rel).stem
        if remote_stem:
            stem = remote_stem
    return image_path.resolve().parent / f"{stem}.{fmt}"


def cmd_health(args: argparse.Namespace) -> int:
    data = _request_json("GET", f"{args.base_url.rstrip('/')}/health", timeout=args.request_timeout)
    _json_print({"ok": True, "base_url": args.base_url, "health": data})
    return 0


def cmd_models(args: argparse.Namespace) -> int:
    data = _request_json("GET", f"{args.base_url.rstrip('/')}/model/all", timeout=args.request_timeout)
    _json_print({"ok": True, "base_url": args.base_url, "models": data})
    return 0


def _parse_params(params_json: str | None, params_file: str | None) -> str:
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
    return json.dumps(parsed, separators=(",", ":"))


def _choose_auto_model(base_url: str, request_timeout: float) -> str:
    models = _request_json("GET", f"{base_url}/model/all", timeout=request_timeout)
    if not isinstance(models, list) or not models:
        active = _request_json("GET", f"{base_url}/model/status", timeout=request_timeout)
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


def cmd_generate(args: argparse.Namespace) -> int:
    base_url = args.base_url.rstrip("/")
    image_path = Path(args.image).expanduser().resolve()
    if not image_path.exists() or not image_path.is_file():
        raise ModlyCliError(f"image file not found: {image_path}")

    params = _parse_params(args.params_json, args.params_file)
    model_id = args.model
    if not model_id or model_id == "auto":
        model_id = _choose_auto_model(base_url, args.request_timeout)
    elif model_id == "active":
        active = _request_json("GET", f"{base_url}/model/status", timeout=args.request_timeout)
        if not isinstance(active, dict) or not active.get("id"):
            raise ModlyCliError(f"Could not resolve active model id: {active}")
        model_id = str(active["id"])

    fields = {
        "model_id": model_id,
        "collection": args.collection,
        "remesh": args.remesh,
        "enable_texture": "true" if args.enable_texture else "false",
        "texture_resolution": str(args.texture_resolution),
        "params": params,
    }
    body, content_type = _multipart_form(fields, "image", image_path)
    started = _request_json(
        "POST",
        f"{base_url}/generate/from-image",
        timeout=args.request_timeout,
        data=body,
        headers={"Content-Type": content_type},
    )
    job_id = started.get("job_id")
    if not job_id:
        raise ModlyCliError(f"Modly did not return a job_id: {started}")

    deadline = time.monotonic() + args.timeout
    last_status: dict[str, Any] = {}
    while time.monotonic() < deadline:
        status = _request_json("GET", f"{base_url}/generate/status/{urllib.parse.quote(job_id)}", timeout=args.request_timeout)
        last_status = status if isinstance(status, dict) else {"raw": status}
        state = last_status.get("status")
        if state == "done":
            output_url = str(last_status.get("output_url") or "")
            if not output_url:
                raise ModlyCliError(f"Job completed without output_url: {last_status}")
            rel_path = _workspace_relative_path(output_url)
            export_dest = Path(args.output).expanduser().resolve() if args.output else _default_export_path(image_path, output_url, args.format)
            export_url = f"{base_url}/export/{urllib.parse.quote(args.format)}?{urllib.parse.urlencode({'path': rel_path})}"
            bytes_written = _download(export_url, export_dest, timeout=args.request_timeout)
            _json_print({
                "ok": True,
                "base_url": base_url,
                "job_id": job_id,
                "status": last_status,
                "workspace_path": rel_path,
                "export_format": args.format,
                "export_path": str(export_dest),
                "bytes_written": bytes_written,
            })
            return 0
        if state in {"error", "cancelled"}:
            raise ModlyCliError(f"Job {job_id} ended with status {state}: {last_status}")
        if args.progress:
            progress = last_status.get("progress", 0)
            step = last_status.get("step", "")
            print(json.dumps({"job_id": job_id, "status": state, "progress": progress, "step": step}), file=sys.stderr)
        time.sleep(args.poll)

    raise ModlyCliError(f"Timed out waiting for job {job_id}. Last status: {last_status}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="modly-cli",
        description="Tiny stdlib-only CLI for agents calling a running Modly desktop API.",
    )
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help=f"Modly API URL (default: {DEFAULT_BASE_URL})")
    parser.add_argument("--request-timeout", type=float, default=30, help="Per-request timeout in seconds (default: 30)")
    sub = parser.add_subparsers(dest="command", required=True)

    health = sub.add_parser("health", help="Check that Modly's local API is reachable")
    health.set_defaults(func=cmd_health)

    models = sub.add_parser("models", help="List installed/available model adapters")
    models.set_defaults(func=cmd_models)

    gen = sub.add_parser("generate", help="Generate a 3D mesh from an image, wait, export it, and print JSON")
    gen.add_argument("--image", required=True, help="Input image path")
    gen.add_argument("--output", help="Export destination path. Defaults beside the input image")
    gen.add_argument("--format", choices=["glb", "stl", "obj", "ply"], default="glb", help="Export format (default: glb)")
    gen.add_argument("--model", default="auto", help="Model id to use, 'active', or 'auto' to prefer an image generation model (default: auto)")
    gen.add_argument("--collection", default="Agent", help="Modly workspace collection (default: Agent)")
    gen.add_argument("--remesh", choices=["quad", "triangle", "none"], default="quad", help="Remesh mode (default: quad)")
    gen.add_argument("--enable-texture", action="store_true", help="Enable texture generation")
    gen.add_argument("--texture-resolution", type=int, default=1024, help="Texture resolution when texturing is enabled")
    gen.add_argument("--params-json", help="Model-specific params as a JSON object")
    gen.add_argument("--params-file", help="Path to model-specific params JSON file")
    gen.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_SECONDS, help=f"Generation timeout in seconds (default: {DEFAULT_TIMEOUT_SECONDS})")
    gen.add_argument("--poll", type=float, default=DEFAULT_POLL_SECONDS, help=f"Polling interval in seconds (default: {DEFAULT_POLL_SECONDS})")
    gen.add_argument("--progress", action="store_true", help="Emit progress JSON lines to stderr while waiting")
    gen.set_defaults(func=cmd_generate)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except ModlyCliError as exc:
        _json_print({"ok": False, "error": str(exc)})
        return 1
    except KeyboardInterrupt:
        _json_print({"ok": False, "error": "interrupted"})
        return 130


if __name__ == "__main__":
    raise SystemExit(main())

"""
Image operations (background removal, ...) on local files.

Ops may need things installed on first use (a runtime, model weights):
`GET /image/op/{op}/status` says what is missing, `POST /image/op/{op}/prepare`
installs it while streaming progress in the same SSE format as the LLM
downloads (src/shared/services/llmDownloads.ts), and `POST /image/op/{op}`
runs the op once everything is there.
"""
import asyncio
import json
import threading
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

import services.generator_registry as registry
from services.image_ops import (
    ImageOp,
    ImageOpContext,
    ImageOpExecutionError,
    ImageOpInputError,
    ImageOpNotFoundError,
    ImageOpNotReadyError,
    image_ops_registry,
)

router = APIRouter(tags=["image"])

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}


class ImageOpRequest(BaseModel):
    path: str
    params: dict[str, Any] = Field(default_factory=dict)


def _fmt(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"


def _get_op(op_name: str) -> ImageOp:
    try:
        return image_ops_registry.get(op_name)
    except ImageOpNotFoundError as exc:
        raise HTTPException(404, f"Unknown image operation: {op_name}") from exc


def _missing_bytes(op: ImageOp) -> Optional[int]:
    sizes = [req.download_bytes() for req in op.requirements if not req.is_ready()]
    known = [size for size in sizes if size is not None]
    return sum(known) if known else None


# ─── Catalog / status ─────────────────────────────────────────────────────────

@router.get("/ops")
def list_image_operations():
    return {"ops": image_ops_registry.describe()}


@router.get("/op/{op_name}/status")
def image_operation_status(op_name: str):
    op = _get_op(op_name)
    missing = op.missing()
    state = _prepares.get(op_name)
    return {
        "ready": not missing,
        "missing": missing,
        "download_bytes": _missing_bytes(op) if missing else None,
        "preparing": bool(state and state.task and not state.task.done()),
    }


# ─── Prepare (SSE) ────────────────────────────────────────────────────────────

class _PrepareState:
    """One op's in-flight prepare, independent of any SSE connection, so a
    second caller (or a reopened panel) attaches instead of starting a second
    pip install / download racing the first."""

    def __init__(self) -> None:
        self.last_msg: dict = {}
        self.subscribers: list[asyncio.Queue] = []
        self.task: Optional[asyncio.Task] = None


_prepares: dict[str, _PrepareState] = {}
# Two ops sharing a requirement (same runtime) must not install it twice at once.
_install_locks: dict[str, threading.Lock] = {}


def _is_terminal(msg: dict) -> bool:
    return msg.get("status") == "done" or "error" in msg


async def _run_prepare(op: ImageOp, state: _PrepareState) -> None:
    loop = asyncio.get_running_loop()

    def _broadcast(msg: dict) -> None:
        def _do() -> None:
            state.last_msg = msg
            for queue in list(state.subscribers):
                queue.put_nowait(msg)
        loop.call_soon_threadsafe(_do)

    try:
        pending = [req for req in op.requirements if not req.is_ready()]
        # Weight each step by its download size so the bar is roughly linear in time.
        weights = [max(1, req.download_bytes() or 1) for req in pending]
        total = sum(weights) or 1
        done_weight = 0
        _broadcast({"percent": 0, "status": "Starting…"})

        for req, weight in zip(pending, weights):
            def _progress(msg: dict, _base: int = done_weight, _weight: int = weight, _kind: str = req.kind) -> None:
                step_pct = max(0, min(100, msg.get("percent") or 0))
                overall = min(99, round((_base + _weight * step_pct / 100) / total * 100))
                _broadcast({**msg, "percent": overall, "step": _kind})

            lock = _install_locks.setdefault(req.id, threading.Lock())

            def _install(req=req, lock=lock, cb=_progress) -> None:
                with lock:
                    req.install(cb)

            await loop.run_in_executor(None, _install)
            done_weight += weight

        _broadcast({"percent": 100, "status": "done"})
    except Exception as exc:
        _broadcast({"error": str(exc)})


@router.post("/op/{op_name}/prepare")
async def prepare_image_operation(op_name: str):
    """Install what the op is missing, streaming progress. Idempotent: an op
    that is already ready gets a single `done` frame; a call while a prepare is
    running joins it. POST only: it downloads and installs, so a plain GET (a
    link, a prefetch) must never start it."""
    op = _get_op(op_name)
    state = _prepares.get(op_name)
    running = state is not None and state.task is not None and not state.task.done()

    if not running and not op.missing():
        async def already():
            yield _fmt({"percent": 100, "status": "done"})
        return StreamingResponse(already(), media_type="text/event-stream")

    if not running:
        state = _PrepareState()
        _prepares[op_name] = state
        state.task = asyncio.create_task(_run_prepare(op, state))

    queue: asyncio.Queue[dict] = asyncio.Queue()
    state.subscribers.append(queue)
    if state.last_msg:
        queue.put_nowait(state.last_msg)  # replay current progress on (re)connect

    async def stream():
        try:
            while True:
                msg = await queue.get()
                yield _fmt(msg)
                if _is_terminal(msg):
                    break
        finally:
            if queue in state.subscribers:
                state.subscribers.remove(queue)

    return StreamingResponse(stream(), media_type="text/event-stream")


# ─── Run ──────────────────────────────────────────────────────────────────────

def _resolve_image_path(raw_path: str) -> Path:
    """The input file, which must be inside the workspace.

    Absolute or workspace-relative; checked once fully resolved, so `..` and
    symlinks pointing out of the workspace are refused too. The Image Studio
    copies an image from elsewhere into <workspace>/Images before running an
    op on it (it reads the 403 code `outside_workspace`).
    """
    if not raw_path or not raw_path.strip():
        raise HTTPException(400, "path is required")
    candidate = Path(raw_path)
    if not candidate.is_absolute():
        candidate = registry.WORKSPACE_DIR / candidate
    resolved = candidate.resolve()
    if not registry.is_within_workspace(resolved):
        raise HTTPException(403, {"code": "outside_workspace", "message": "The image must be inside the workspace folder."})
    if resolved.suffix.lower() not in IMAGE_EXTENSIONS:
        raise HTTPException(400, f"Unsupported image type {resolved.suffix or '(none)'}: use png, jpg, jpeg or webp")
    if not resolved.is_file():
        raise HTTPException(404, f"File not found: {raw_path}")
    return resolved


def _workspace_url(path: Path) -> Optional[str]:
    try:
        relative = path.resolve().relative_to(registry.WORKSPACE_DIR.resolve()).as_posix()
    except ValueError:
        return None
    return f"/workspace/{relative}"


@router.post("/op/{op_name}")
async def run_image_operation(op_name: str, body: ImageOpRequest):
    op = _get_op(op_name)
    input_path = _resolve_image_path(body.path)
    missing = op.missing()
    if missing:
        raise HTTPException(409, {"code": "not_ready", "missing": missing})

    context = ImageOpContext(workspace_dir=registry.WORKSPACE_DIR)
    try:
        # Inference takes seconds on CPU: keep the event loop free.
        result = await run_in_threadpool(image_ops_registry.run, op_name, input_path, body.params, context)
    except ImageOpNotReadyError as exc:
        raise HTTPException(409, {"code": "not_ready", "missing": exc.missing}) from exc
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    except (ImageOpInputError, TypeError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc
    except ImageOpExecutionError as exc:
        raise HTTPException(500, str(exc)) from exc

    response: dict[str, Any] = {
        "path": str(result.path.resolve()),
        "mask_path": str(result.mask_path.resolve()) if result.mask_path else None,
    }
    url = _workspace_url(result.path)
    if url:
        response["url"] = url
    if result.mask_path is not None:
        mask_url = _workspace_url(result.mask_path)
        if mask_url:
            response["mask_url"] = mask_url
    return response

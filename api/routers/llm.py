"""
Local LLM engine endpoints — model catalog, GGUF downloads, llama-server lifecycle.
Reuses the streamed/resumable downloader from routers.model.
"""
import asyncio
import json
import threading
from pathlib import Path
from typing import Optional
import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from routers.model import DownloadCancelled, DownloadPaused, _download_file_streamed
from services import llm_server
from services.llm_server import llama_pool

router = APIRouter(tags=["llm"])

_controls: dict[str, dict[str, threading.Event]] = {}


class _DownloadState:
    """Tracks one model's in-flight download independent of any single SSE
    connection, so closing/reopening the Model Library modal reattaches to the
    same download instead of racing a second one against the same .part file."""

    def __init__(self) -> None:
        self.last_msg: dict = {}
        self.subscribers: list[asyncio.Queue] = []
        self.task: asyncio.Task | None = None


_downloads: dict[str, _DownloadState] = {}


def _new_control(key: str) -> dict[str, threading.Event]:
    control: dict[str, threading.Event] = {"pause": threading.Event(), "cancel": threading.Event()}
    _controls[key] = control
    return control


def _check_control(control: dict[str, threading.Event]) -> None:
    if control["cancel"].is_set():
        raise DownloadCancelled()
    if control["pause"].is_set():
        raise DownloadPaused()


def _fmt(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"


# ─── Catalog / status ─────────────────────────────────────────────────────────

@router.get("/models")
async def list_models(tag: Optional[str] = None, downloaded: bool = False):
    """Model library. `tag` filters catalog entries by category (e.g. tag=code
    for coder models); custom user GGUFs are always included since their
    capabilities are unknown. `downloaded=true` keeps only ready-to-use models."""
    models = llm_server.list_models()
    if tag:
        models = [m for m in models if m.get("source") == "custom" or tag in (m.get("tags") or [])]
    if downloaded:
        models = [m for m in models if m.get("downloaded")]
    return {"models": models}


@router.get("/status")
async def status():
    return {
        "binary_installed": llm_server.binary_installed(),
        "has_nvidia_gpu": llm_server.has_nvidia_gpu(),
        "vram_gb": llm_server.detect_vram_gb() or None,
        "models_dir": str(llm_server.LLM_MODELS_DIR),
        "server": await asyncio.to_thread(llama_pool.snapshot),
    }


class LlmConfigRequest(BaseModel):
    max_models: str | int  # "auto" or 1..MAX_SLOT_PORTS


@router.get("/config")
async def get_config():
    return {
        "max_models": llm_server.load_config().get("max_models", "auto"),
        "resolved_max_models": llm_server.resolve_max_models(),
        "vram_gb": llm_server.detect_vram_gb() or None,
        "max_slot_ports": llm_server.MAX_SLOT_PORTS,
    }


@router.post("/config")
async def set_config(request: LlmConfigRequest):
    value: str | int = request.max_models
    if isinstance(value, str) and value.lower() != "auto":
        try:
            value = int(value)
        except ValueError:
            raise HTTPException(status_code=422, detail="max_models must be 'auto' or an integer")
    if isinstance(value, int) and not (1 <= value <= llm_server.MAX_SLOT_PORTS):
        raise HTTPException(status_code=422, detail=f"max_models must be between 1 and {llm_server.MAX_SLOT_PORTS}")
    cfg = llm_server.load_config()
    cfg["max_models"] = value
    llm_server.save_config(cfg)
    # A lowered limit applies immediately — small-VRAM users count on it.
    await asyncio.to_thread(llama_pool.enforce_limit)
    return {"max_models": value, "resolved_max_models": llm_server.resolve_max_models()}


@router.post("/unload")
async def unload():
    await asyncio.to_thread(llama_pool.unload_all)
    return {"unloaded": True}


@router.delete("/models/{model_id}")
async def delete_model(model_id: str):
    try:
        spec = llm_server.resolve_model(model_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    if await asyncio.to_thread(llama_pool.is_loaded, model_id):
        await asyncio.to_thread(llama_pool.unload, model_id)
    spec["gguf_path"].unlink(missing_ok=True)
    if spec.get("mmproj_path"):
        spec["mmproj_path"].unlink(missing_ok=True)
    return {"deleted": True}


# ─── Chat completion through the managed server ───────────────────────────────

class LlmChatRequest(BaseModel):
    model: str
    messages: list[dict]
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None
    stream: Optional[bool] = False


@router.post("/chat")
async def llm_chat(request: LlmChatRequest):
    """Load `model` (hot-swapping if needed) and run one OpenAI-format chat completion.

    Used by workflow nodes (LLM, Text to CAD, …) so they share the managed
    llama-server instead of loading their own copy of the model. When
    `stream` is set, the llama-server SSE chunks are proxied straight through so
    the caller can render tokens as they arrive.
    """
    try:
        spec = llm_server.resolve_model(request.model)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    try:
        # hold=True: the slot comes back claimed, so a model loading in another
        # thread cannot evict it between here and the request below.
        slot = await asyncio.to_thread(llama_pool.ensure, request.model, spec, True)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Could not start the local LLM: {e}")

    payload: dict = {"model": request.model, "messages": request.messages, "stream": bool(request.stream)}
    if request.temperature is not None:
        payload["temperature"] = request.temperature
    if request.max_tokens is not None:
        payload["max_tokens"] = request.max_tokens

    # The claim spans the whole completion, not just its end: a generation longer
    # than the idle TTL (a Text-to-CAD node can sit here for minutes) used to be
    # reaped mid-answer, since only a *finished* call marked the slot as used.
    if request.stream:
        async def proxy():
            try:
                async with httpx.AsyncClient(timeout=600.0) as client:
                    async with client.stream("POST", f"{slot.base_url}/chat/completions", json=payload) as r:
                        if r.status_code != 200:
                            body = (await r.aread()).decode("utf-8", "replace")[:300]
                            yield f"data: {json.dumps({'error': f'llama-server error ({r.status_code}): {body}'})}\n\n"
                            return
                        async for line in r.aiter_lines():
                            if line.startswith("data: "):
                                yield f"{line}\n\n"
            finally:
                slot.release()
        return StreamingResponse(proxy(), media_type="text/event-stream")

    try:
        async with httpx.AsyncClient(timeout=600.0) as client:
            r = await client.post(f"{slot.base_url}/chat/completions", json=payload)
            if r.status_code != 200:
                raise HTTPException(status_code=502, detail=f"llama-server error ({r.status_code}): {r.text[:300]}")
            return r.json()
    finally:
        slot.release()


# ─── GGUF download (SSE) ──────────────────────────────────────────────────────

@router.post("/download/pause")
async def pause_download(model_id: str):
    control = _controls.get(model_id)
    if control:
        control["pause"].set()
    return {"paused": True}


@router.post("/download/cancel")
async def cancel_download(model_id: str):
    """Cancel an in-flight download, or clean up a paused one.

    A paused download has already left `_run_download` — its control is gone
    from `_controls`, so setting the cancel event would be a no-op. Reporting
    success there left the user with a multi-GB .part file they believed they
    had deleted, so the partial files are removed here instead."""
    control = _controls.get(model_id)
    if control:
        control["cancel"].set()
        return {"cancelled": True, "removed_partials": []}

    entry = next((e for e in llm_server.load_catalog() if e["id"] == model_id), None)
    removed = _discard_incomplete(entry) if entry else []
    _downloads.pop(model_id, None)
    return {"cancelled": bool(removed), "removed": removed}


def _model_files(entry: dict) -> list[Path]:
    """Every file a model needs on disk: the weights, plus the vision projector."""
    paths = [llm_server.LLM_MODELS_DIR / entry["hf_filename"]]
    if entry.get("hf_mmproj_filename"):
        paths.append(llm_server.LLM_MODELS_DIR / llm_server.mmproj_local_name(entry))
    return paths


def _discard_incomplete(entry: dict) -> list[str]:
    """Drop what a cancelled download left behind, and report what went.

    Not just the .part: a vision model downloads weights then projector, so
    cancelling during the second one left 2.5 GB of finished weights on disk
    under a model still reported as `downloaded: false` — no trash button is
    offered for those, so the space could not be reclaimed from the UI at all.
    A model whose files are all present is complete, not in flight, and is
    never touched here (deleting it is what DELETE /llm/models/{id} is for)."""
    paths = _model_files(entry)
    if all(p.exists() for p in paths):
        return []
    removed = []
    for path in paths:
        for target in (path.with_suffix(path.suffix + ".part"), path):
            if target.exists():
                target.unlink(missing_ok=True)
                removed.append(target.name)
    return removed


def _is_terminal(msg: dict) -> bool:
    return msg.get("status") == "done" or "error" in msg or msg.get("cancelled") or msg.get("paused")


async def _run_download(model_id: str, entry: dict, control: dict[str, threading.Event], state: _DownloadState) -> None:
    """Owns one model's download end to end, independent of any SSE connection.
    Broadcasts progress to every currently-attached watcher (see `_broadcast`)."""
    loop = asyncio.get_running_loop()

    def _broadcast(msg: dict) -> None:
        # _progress (below) runs in a worker thread — hop back onto the loop.
        def _do() -> None:
            state.last_msg = msg
            for q in list(state.subscribers):
                q.put_nowait(msg)
        loop.call_soon_threadsafe(_do)

    from huggingface_hub import hf_hub_url

    # Vision models ship a companion mmproj file — download it alongside the
    # weights, stored under a per-model local name (HF names collide).
    files: list[tuple[str, str, int]] = [(entry["hf_filename"], entry["hf_filename"], entry.get("size_bytes") or 0)]
    if entry.get("hf_mmproj_filename"):
        files.append((
            entry["hf_mmproj_filename"],
            llm_server.mmproj_local_name(entry),
            entry.get("mmproj_size_bytes") or 0,
        ))
    grand_total = sum(size for _, _, size in files)

    try:
        _broadcast({"percent": 0, "status": "Starting download…"})
        completed_bytes = 0

        for index, (hf_filename, local_filename, _size) in enumerate(files):
            url = hf_hub_url(repo_id=entry["hf_repo"], filename=hf_filename)

            def _progress(msg: dict, _base: int = completed_bytes) -> None:
                done = _base + msg.get("bytesDownloaded", 0)
                if grand_total:
                    pct = min(99, round(done / grand_total * 100))
                    # The streaming helper reports per-file figures. A vision
                    # model downloads two files, so the bar (combined percent)
                    # and the label baked into `status` (per-file percent) drew
                    # two different numbers side by side. Restate all of it
                    # against the combined total; `file`/`fileIndex` stay
                    # per-file, which is what they're for.
                    msg["percent"] = pct
                    msg["bytesDownloaded"] = done
                    msg["totalBytes"] = grand_total
                    status = msg.get("status") or ""
                    if status.endswith("%"):
                        msg["status"] = f"{status.rsplit(' ', 1)[0]} {pct}%"
                _broadcast(msg)

            await loop.run_in_executor(
                None,
                lambda url=url, filename=local_filename, cb=_progress: _download_file_streamed(
                    url=url,
                    filename=filename,
                    dest_dir=str(llm_server.LLM_MODELS_DIR),
                    file_index=index + 1,
                    total_files=len(files),
                    base_percent=0,
                    progress_cb=cb,
                    control=control,
                ),
            )
            completed_bytes += _size

        _broadcast({"percent": 100, "status": "done"})

    except DownloadPaused:
        # Carry the last percent so the modal's bar stays where it stopped
        # instead of snapping back to 0 behind the Resume button.
        _broadcast({"paused": True, "status": "paused", "percent": state.last_msg.get("percent", 0)})
    except DownloadCancelled:
        _discard_incomplete(entry)
        _broadcast({"cancelled": True, "status": "cancelled", "percent": 0})
    except Exception as exc:
        _broadcast({"error": str(exc)})
    finally:
        if _controls.get(model_id) is control:
            _controls.pop(model_id, None)


@router.get("/download")
async def download_model(model_id: str):
    entry = next((e for e in llm_server.load_catalog() if e["id"] == model_id), None)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"Unknown catalog model: {model_id}")

    # Reconnect-safe: if this model is already downloading, attach a new watcher
    # instead of starting a second download racing the same .part file — this is
    # what lets the Model Library modal be closed and reopened mid-download.
    state = _downloads.get(model_id)
    if state is None or state.task is None or state.task.done():
        control = _new_control(model_id)
        state = _DownloadState()
        _downloads[model_id] = state
        state.task = asyncio.create_task(_run_download(model_id, entry, control, state))

    queue: asyncio.Queue[dict] = asyncio.Queue()
    state.subscribers.append(queue)
    if state.last_msg:
        queue.put_nowait(state.last_msg)  # replay current progress immediately on (re)connect

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


# ─── Engine (llama-server binary) install (SSE) ───────────────────────────────

@router.get("/binary/install")
async def install_binary():
    if llm_server.binary_installed():
        async def already():
            yield _fmt({"percent": 100, "status": "done"})
        return StreamingResponse(already(), media_type="text/event-stream")

    control = _new_control("__binary__")

    async def stream():
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[dict] = asyncio.Queue()

        def _progress(msg: dict) -> None:
            loop.call_soon_threadsafe(queue.put_nowait, msg)

        try:
            future = loop.run_in_executor(
                None,
                lambda: llm_server.install_binary(_progress, lambda: _check_control(control)),
            )
            while not future.done():
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=2.0)
                except asyncio.TimeoutError:
                    continue
                else:
                    yield _fmt(msg)
            await future
            while not queue.empty():
                yield _fmt(queue.get_nowait())
        except (DownloadPaused, DownloadCancelled):
            yield _fmt({"cancelled": True, "status": "cancelled"})
        except Exception as exc:
            yield _fmt({"error": str(exc)})
        finally:
            if _controls.get("__binary__") is control:
                _controls.pop("__binary__", None)

    return StreamingResponse(stream(), media_type="text/event-stream")

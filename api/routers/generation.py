import asyncio
import json
import threading
import time
import traceback
import uuid
from typing import Dict
from fastapi import APIRouter, File, Form, UploadFile, HTTPException, BackgroundTasks
from services.generators.base import smooth_progress, GenerationCancelled

import re as _re
# Import the module (not the name) so WORKSPACE_DIR is read at call time: the
# settings endpoint rebinds it when the user relocates the workspace, and a
# binding captured at import would keep writing output to the old directory.
import services.generator_registry as registry
from services.generator_registry import generator_registry
from schemas.generation import JobStatus

router = APIRouter(tags=["generation"])

# Shared with workflow_runs.create_run_from_image so the two endpoints can't drift apart on
# what counts as a valid remesh mode the way they had drifted on `collection` before #238.
VALID_REMESH_MODES = ("quad", "triangle", "none")

_jobs: Dict[str, JobStatus] = {}
_cancelled: set = set()
_cancel_events: Dict[str, threading.Event] = {}
_completed_at: Dict[str, float] = {}

_JOB_TTL = 1800  # purge terminal jobs after 30 minutes


def _purge_old_jobs() -> None:
    cutoff = time.monotonic() - _JOB_TTL
    stale = [jid for jid, t in _completed_at.items() if t < cutoff]
    for jid in stale:
        _jobs.pop(jid, None)
        _cancelled.discard(jid)
        _cancel_events.pop(jid, None)
        _completed_at.pop(jid, None)


def sanitize_collection(collection: str) -> str:
    """Normalize a caller-supplied collection name into a safe workspace subfolder.

    The value becomes a directory under the workspace (``WORKSPACE_DIR / collection``), so a
    name carrying a path separator or a drive/wildcard character could escape that root or fail
    to create on Windows. Such a name, or an empty one, falls back to ``"Default"`` rather than
    raising, because a generation the caller already paid for should still land somewhere
    sensible. Shared so every entry point that routes output into a collection sanitizes it the
    same way; a second copy of this rule is a second chance to forget a character.

    Legality and containment are different questions, so they are asked separately: the
    reserved characters above are refused outright, and containment is put to the path
    library rather than to the spelling -- the same ``relative_to`` check
    ``generator_registry._path_belongs_to`` uses, so the two containment checks in this
    backend agree rather than drifting on their own semantics. A character blocklist alone
    lets ``".."`` through -- it contains none of the listed characters -- and
    ``WORKSPACE_DIR / ".."`` resolves to the workspace's *parent*, so the generated mesh
    would land outside the root.

    A name ending in a dot or space is refused too, even once it clears both checks above:
    Windows silently drops trailing dots/spaces from the final path component it actually
    creates, so ``mkdir()`` on ``"Exports..."`` lands in the very same folder as
    ``"Exports"`` -- two collections that look distinct to this function would otherwise
    merge their output on disk without either caller being told.
    """
    collection = (collection or "").strip()
    if (
        not collection
        or _re.search(r'[/:*?"<>|\\]', collection)
        or collection != collection.rstrip(". ")
    ):
        return "Default"

    try:
        (registry.WORKSPACE_DIR / collection).resolve().relative_to(
            registry.WORKSPACE_DIR.resolve()
        )
    except (OSError, ValueError):
        return "Default"

    return collection


@router.post("/from-image")
async def generate_from_image(
    background_tasks: BackgroundTasks,
    image: UploadFile = File(...),
    model_id: str = Form("sf3d"),
    collection: str = Form("Default"),
    remesh: str = Form("quad"),
    enable_texture: bool = Form(False),
    texture_resolution: int = Form(1024),
    params: str = Form("{}"),
):
    if not image.content_type or not image.content_type.startswith("image/"):
        raise HTTPException(400, "File must be an image")

    if remesh not in VALID_REMESH_MODES:
        raise HTTPException(400, "remesh must be 'quad', 'triangle', or 'none'")

    collection = sanitize_collection(collection)

    # Verify the requested model exists in the registry
    try:
        generator_registry.get_generator(model_id)
    except ValueError as e:
        raise HTTPException(400, str(e))

    generator_registry.switch_model(model_id)

    # Parse model-specific params from JSON and merge with common fields
    try:
        model_params = json.loads(params)
    except (json.JSONDecodeError, TypeError):
        model_params = {}

    job_id      = str(uuid.uuid4())
    image_bytes = await image.read()
    full_params = {
        "remesh":             remesh,
        "enable_texture":     enable_texture,
        "texture_resolution": texture_resolution,
        **model_params,
    }

    _purge_old_jobs()

    job = JobStatus(job_id=job_id, status="pending", progress=0)
    _jobs[job_id] = job
    _cancel_events[job_id] = threading.Event()

    background_tasks.add_task(_run_generation, job_id, image_bytes, full_params, collection)

    return {"job_id": job_id}



@router.get("/status/{job_id}")
async def job_status(job_id: str):
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} not found")
    return job


@router.post("/cancel/{job_id}")
async def cancel_job(job_id: str):
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} not found")
    _cancelled.add(job_id)
    if job_id in _cancel_events:
        _cancel_events[job_id].set()
    if job.status in ("pending", "running"):
        job.status = "cancelled"
        _completed_at[job_id] = time.monotonic()
    # Kill the active generator subprocess immediately so inference stops now.
    # _run_generation will catch the resulting exception, see job_id in _cancelled,
    # and return cleanly without setting an error status.
    try:
        gen = generator_registry._generators.get(generator_registry._active_id)
        if gen is not None and hasattr(gen, "_proc") and gen._proc and gen._proc.poll() is None:
            gen._proc.kill()
            gen._loaded = False
            gen._proc = None
    except Exception:
        pass
    return {"cancelled": True}


async def _run_generation(job_id: str, image_bytes: bytes, params: dict, collection: str = "Default") -> None:
    job = _jobs[job_id]
    job.status = "running"

    def progress_cb(pct: int, step: str = "") -> None:
        # Monotonic: the loading phase walks the bar up on a background thread and
        # extensions then report their own 0->100 scale, so an unguarded assignment
        # yanks the bar backwards on the first generation progress message.
        if pct > job.progress:
            job.progress = pct
        if step:
            job.step = step

    try:
        loop = asyncio.get_running_loop()

        # Check if the model needs to be loaded BEFORE calling get_active(),
        # because get_active() loads the model in a blocking manner.
        # active_status() is an instantaneous operation (simple dict lookup).
        if not generator_registry.active_status()["loaded"]:
            active = generator_registry.active_status()
            model_name = active['name']
            init_label = f"Downloading {model_name}…" if not active['downloaded'] else f"Loading {model_name}…"
            progress_cb(0, init_label)
            stop_load_evt = threading.Event()
            load_thread = threading.Thread(
                target=smooth_progress,
                args=(progress_cb, 0, 9, init_label, stop_load_evt, 4.0),
                daemon=True,
            )
            load_thread.start()
            try:
                gen = await loop.run_in_executor(None, generator_registry.get_active)
            finally:
                stop_load_evt.set()
        else:
            gen = await loop.run_in_executor(None, generator_registry.get_active)

        if job_id in _cancelled:
            return

        # Direct output to the collection subfolder
        coll_dir = registry.WORKSPACE_DIR / collection
        coll_dir.mkdir(parents=True, exist_ok=True)
        gen.outputs_dir = coll_dir

        cancel_event = _cancel_events.get(job_id)
        import inspect
        supports_cancel = "cancel_event" in inspect.signature(gen.generate).parameters
        output_path = await loop.run_in_executor(
            None,
            lambda: gen.generate(image_bytes, params, progress_cb, cancel_event)
                    if supports_cancel
                    else gen.generate(image_bytes, params, progress_cb),
        )

        if job_id in _cancelled:
            return

        job.status   = "done"
        job.progress = 100
        _completed_at[job_id] = time.monotonic()
        try:
            rel = output_path.relative_to(registry.WORKSPACE_DIR)
            job.output_url = f"/workspace/{rel.as_posix()}"
        except ValueError:
            job.output_url = f"/workspace/{collection}/{output_path.name}"

    except GenerationCancelled:
        job.status = "cancelled"
        _completed_at[job_id] = time.monotonic()
    except Exception as exc:
        if job_id in _cancelled:
            return
        tb = traceback.format_exc()
        msg = f"[Generation ERROR] {exc}\n{tb}"
        try:
            print(msg)
        except UnicodeEncodeError:
            print(msg.encode("ascii", errors="replace").decode("ascii"))
        job.status = "error"
        job.error  = tb.strip()
        _completed_at[job_id] = time.monotonic()

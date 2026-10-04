import asyncio
import json
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Dict, Optional, Union
from fastapi import APIRouter, File, Form, UploadFile, HTTPException, BackgroundTasks
from services.generators.base import smooth_progress, GenerationCancelled

import re as _re
# Import the module (not the name) so WORKSPACE_DIR is read at call time: the
# settings endpoint rebinds it when the user relocates the workspace, and a
# binding captured at import would keep writing output to the old directory.
import services.generator_registry as registry
from services.generator_registry import generator_registry
from schemas.generation import GenerateFromArtifactRequest, JobStatus
from services.artifact_input import (
    RESERVED_ARTIFACT_PARAMS,
    TypedArtifactInput,
    validate_artifact_input,
)

router = APIRouter(tags=["generation"])

# Shared with workflow_runs.create_run_from_image so the two endpoints can't drift apart on
# what counts as a valid remesh mode the way they had drifted on `collection` before #238.
VALID_REMESH_MODES = ("quad", "triangle", "none")

_jobs: Dict[str, JobStatus] = {}
_cancelled: set = set()
_cancel_events: Dict[str, threading.Event] = {}
_completed_at: Dict[str, float] = {}
_job_generators: Dict[str, object] = {}
# A pinned generation owns the complete switch/load/generate lifecycle.  Keeping
# that lifecycle on one dedicated worker provides process-wide serialization
# without parking default-executor workers on a blocking lock acquisition.
_pinned_generation_executor = ThreadPoolExecutor(
    max_workers=1,
    thread_name_prefix="modly-pinned-generation",
)

_JOB_TTL = 1800  # purge terminal jobs after 30 minutes


def _purge_old_jobs() -> None:
    cutoff = time.monotonic() - _JOB_TTL
    stale = [jid for jid, t in _completed_at.items() if t < cutoff]
    for jid in stale:
        _jobs.pop(jid, None)
        _cancelled.discard(jid)
        _cancel_events.pop(jid, None)
        _job_generators.pop(jid, None)
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
        output_kind = generator_registry.get_manifest(model_id).get("output", "mesh")
    except ValueError as e:
        raise HTTPException(400, str(e))

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

    background_tasks.add_task(
        _run_generation, job_id, image_bytes, full_params, collection, output_kind, model_id
    )

    return {"job_id": job_id}


@router.post("/from-artifact")
async def generate_from_artifact(
    request: GenerateFromArtifactRequest,
    background_tasks: BackgroundTasks,
):
    """Queue a validated typed artifact without serializing it as image bytes."""
    try:
        manifest = generator_registry.get_manifest(request.model_id)
    except (KeyError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc
    declared = manifest.get("inputs") or [manifest.get("input", "image")]
    if request.input_kind not in declared:
        raise HTTPException(400, f"Model {request.model_id} does not accept {request.input_kind} input")
    try:
        artifact = validate_artifact_input(registry.WORKSPACE_DIR, request.input_kind, request.input_path)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    params = {k: v for k, v in request.params.items() if k not in RESERVED_ARTIFACT_PARAMS}
    if artifact.kind == "scene":
        params["scene_manifest_path"] = str(artifact.path)
    collection = sanitize_collection(request.collection)
    job_id = str(uuid.uuid4())
    _purge_old_jobs()
    _jobs[job_id] = JobStatus(job_id=job_id, status="pending", progress=0)
    _cancel_events[job_id] = threading.Event()
    background_tasks.add_task(
        _run_generation, job_id, artifact, params, collection, manifest.get("output", "mesh"), request.model_id
    )
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
    # Kill only the subprocess bound to this job. A queued cancellation must not
    # terminate whichever earlier job currently owns the active generator.
    try:
        gen = _job_generators.get(job_id)
        if gen is not None and hasattr(gen, "_proc") and gen._proc and gen._proc.poll() is None:
            gen._proc.kill()
            gen._loaded = False
            gen._proc = None
    except Exception:
        pass
    return {"cancelled": True}


async def _run_generation(
    job_id: str,
    model_input: Union[bytes, TypedArtifactInput],
    params: dict,
    collection: str = "Default",
    output_kind: str = "mesh",
    model_id: Optional[str] = None,
) -> None:
    # Pinned jobs share one model lifecycle. Switching is deliberately deferred
    # until this job runs on the dedicated worker: request-time switches can
    # otherwise unload a running job or leave A loading beside B.  Crucially,
    # queued jobs are executor work items rather than default-executor threads
    # blocked on a lock, so cancelling a waiter cannot orphan queue ownership or
    # starve the worker that performs generation.
    loop = asyncio.get_running_loop()
    executor = _pinned_generation_executor if model_id is not None else None
    # Shown while this job waits behind another one on the single worker;
    # _run_generation_impl clears it as soon as the job actually starts.
    queued_job = _jobs.get(job_id)
    if queued_job is not None and executor is not None:
        queued_job.step = "Waiting for the previous generation…"
    future = loop.run_in_executor(
        executor,
        _run_generation_impl,
        job_id,
        model_input,
        params,
        collection,
        output_kind,
        model_id,
    )
    try:
        await future
    except asyncio.CancelledError:
        # asyncio cancellation attempts to cancel a queued concurrent future.
        # If it has already begun, the event lets the generator stop safely.
        _cancelled.add(job_id)
        cancel_event = _cancel_events.get(job_id)
        if cancel_event is not None:
            cancel_event.set()
        job = _jobs.get(job_id)
        if job is not None and job.status in ("pending", "running"):
            job.status = "cancelled"
            _completed_at[job_id] = time.monotonic()
        raise


def _run_generation_impl(
    job_id: str,
    model_input: Union[bytes, TypedArtifactInput],
    params: dict,
    collection: str,
    output_kind: str,
    model_id: Optional[str],
) -> None:
    if job_id in _cancelled:
        return
    job = _jobs[job_id]
    job.status = "running"
    job.step = None

    def progress_cb(pct: int, step: str = "") -> None:
        # Monotonic: the loading phase walks the bar up on a background thread and
        # extensions then report their own 0->100 scale, so an unguarded assignment
        # yanks the bar backwards on the first generation progress message.
        if pct > job.progress:
            job.progress = pct
        if step:
            job.step = step

    try:
        # Refuse a selected weight variant that is not installed before loading
        # anything. Uses the job's model: the switch to it happens below.
        generator_registry.assert_weight_variant_installed(params, model_id)

        # Check if the model needs to be loaded BEFORE calling the generator
        # getter, because that call can load the model in a blocking manner.
        get_generator = (lambda: generator_registry.activate_ready_generator(model_id)) \
            if model_id is not None else generator_registry.get_active
        if model_id is not None:
            _job_generators[job_id] = generator_registry.get_generator(model_id)
        status_reader = (lambda: generator_registry.model_status(model_id)) \
            if model_id is not None else generator_registry.active_status
        status = status_reader()
        if not status["loaded"]:
            active = status
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
                gen = get_generator()
            finally:
                stop_load_evt.set()
        else:
            gen = get_generator()

        _job_generators[job_id] = gen
        if job_id in _cancelled:
            return

        # Direct output to the collection subfolder
        coll_dir = registry.WORKSPACE_DIR / collection
        coll_dir.mkdir(parents=True, exist_ok=True)
        gen.outputs_dir = coll_dir

        cancel_event = _cancel_events.get(job_id)
        if isinstance(model_input, TypedArtifactInput):
            # Revalidate just before crossing the inference boundary. The
            # subprocess runner repeats this check inside the worker.
            from services.artifact_input import revalidate_artifact_input
            model_input = revalidate_artifact_input(registry.WORKSPACE_DIR, model_input)
            import inspect
            artifact_parameters = inspect.signature(gen.generate_artifact).parameters
            artifact_kwargs = {}
            if "cancel_event" in artifact_parameters:
                artifact_kwargs["cancel_event"] = cancel_event
            if "artifact_snapshot" in artifact_parameters:
                artifact_kwargs["artifact_snapshot"] = model_input.snapshot
            output_path = gen.generate_artifact(
                model_input.kind,
                model_input.path,
                params,
                progress_cb,
                **artifact_kwargs,
            )
        else:
            import inspect
            supports_cancel = "cancel_event" in inspect.signature(gen.generate).parameters
            output_path = (
                gen.generate(model_input, params, progress_cb, cancel_event)
                if supports_cancel
                else gen.generate(model_input, params, progress_cb)
            )

        if job_id in _cancelled:
            return

        output_path = Path(output_path).resolve(strict=True)
        if output_kind == "scene":
            from services.scene_input import validate_scene_input
            try:
                output_relative = output_path.relative_to(registry.WORKSPACE_DIR.resolve())
                output_path = validate_scene_input(registry.WORKSPACE_DIR, output_relative.as_posix())
            except (OSError, ValueError) as exc:
                raise ValueError("Generated scene output is not a valid workspace scene") from exc

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
    finally:
        _job_generators.pop(job_id, None)

import json
import threading
import uuid
from typing import Optional
from fastapi import APIRouter, BackgroundTasks, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from routers.generation import (
    VALID_REMESH_MODES,
    _cancel_events,
    _jobs,
    _purge_old_jobs,
    _run_generation,
    cancel_job,
    sanitize_collection,
)
from schemas.generation import JobStatus
from services.generator_registry import generator_registry

router = APIRouter(tags=["workflow-runs"])


class WorkflowRunStatus(BaseModel):
    run_id: str
    status: str
    progress: int = 0
    step: Optional[str] = None
    output_url: Optional[str] = None
    error: Optional[str] = None
    scene_candidate: Optional[dict] = None


@router.post("/from-image")
async def create_run_from_image(
    background_tasks: BackgroundTasks,
    image: UploadFile = File(...),
    model_id: str = Form("sf3d"),
    # Where the result is filed. The legacy /generate/from-image already accepts this; the
    # canonical endpoint hardcoded "Default", so a run driven over REST/MCP landed in a folder
    # the Library does not index and stayed invisible in the app (#238). Same field, same
    # sanitizer, so both surfaces route output the same way.
    collection: str = Form("Default"),
    params: str = Form("{}"),
):
    if not image.content_type or not image.content_type.startswith("image/"):
        raise HTTPException(400, "File must be an image")

    # Malformed params used to fall back to {} and run on defaults, dropping every value the
    # caller set without a word (#384). Refuse instead, naming the field.
    try:
        model_params = json.loads(params)
    except (json.JSONDecodeError, TypeError):
        raise HTTPException(400, "params must be a JSON object")
    if not isinstance(model_params, dict):
        raise HTTPException(400, "params must be a JSON object")

    full_params = {
        "remesh": "quad",
        "enable_texture": False,
        "texture_resolution": 1024,
        **model_params,
    }

    # Keep the same request validation as /generate/from-image before filing a job.
    if full_params["remesh"] not in VALID_REMESH_MODES:
        raise HTTPException(400, "remesh must be 'quad', 'triangle', or 'none'")

    collection = sanitize_collection(collection)

    try:
        generator = generator_registry.get_generator(model_id)
        output_kind = generator_registry.get_manifest(model_id).get("output", "mesh")
    except ValueError as e:
        raise HTTPException(400, str(e))

    # Report the params this model does not declare, so a caller learns that e.g.
    # texture_resolution may have no effect on it (#384). Reported, not rejected: a schema
    # describes the UI controls, not every key a generator reads (hunyuan3d-mini consumes the
    # undeclared enable_texture), so a 400 here would refuse requests that work. Still
    # forwarded unchanged, exactly as /generate/from-image does.
    declared = {field.get("id") for field in generator.params_schema()}
    undeclared_params = [key for key in model_params if key not in declared]
    if undeclared_params:
        print(
            f"[workflow-runs] {model_id} does not declare params {undeclared_params}; "
            "the model may ignore them."
        )

    job_id = str(uuid.uuid4())
    image_bytes = await image.read()

    _purge_old_jobs()

    _jobs[job_id] = JobStatus(job_id=job_id, status="pending", progress=0)
    _cancel_events[job_id] = threading.Event()

    background_tasks.add_task(
        _run_generation, job_id, image_bytes, full_params, collection, output_kind, model_id
    )

    return {"run_id": job_id, "status": "pending", "undeclared_params": undeclared_params}


@router.get("/{run_id}", response_model=WorkflowRunStatus)
async def get_run(run_id: str):
    job = _jobs.get(run_id)
    if not job:
        raise HTTPException(404, f"Run {run_id} not found")

    scene_candidate = None
    if job.status == "done" and job.output_url:
        scene_candidate = {"workspace_path": job.output_url.removeprefix("/workspace/")}

    return WorkflowRunStatus(
        run_id=job.job_id,
        status=job.status,
        progress=job.progress,
        step=job.step,
        output_url=job.output_url,
        error=job.error,
        scene_candidate=scene_candidate,
    )


@router.post("/{run_id}/cancel")
async def cancel_run(run_id: str):
    return await cancel_job(run_id)

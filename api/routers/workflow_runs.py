import json
import threading
import uuid
from typing import Optional
from fastapi import APIRouter, BackgroundTasks, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from routers.generation import _cancel_events, _cancelled, _jobs, _run_generation
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
    params: str = Form("{}"),
):
    if not image.content_type or not image.content_type.startswith("image/"):
        raise HTTPException(400, "File must be an image")

    try:
        generator_registry.get_generator(model_id)
    except ValueError as e:
        raise HTTPException(400, str(e))

    generator_registry.switch_model(model_id)

    try:
        model_params = json.loads(params)
    except (json.JSONDecodeError, TypeError):
        model_params = {}

    full_params = {
        "remesh": "quad",
        "enable_texture": False,
        "texture_resolution": 1024,
        **model_params,
    }

    job_id = str(uuid.uuid4())
    image_bytes = await image.read()

    _jobs[job_id] = JobStatus(job_id=job_id, status="pending", progress=0)
    _cancel_events[job_id] = threading.Event()

    background_tasks.add_task(_run_generation, job_id, image_bytes, full_params, "Default")

    return {"run_id": job_id, "status": "pending"}


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
    job = _jobs.get(run_id)
    if not job:
        raise HTTPException(404, f"Run {run_id} not found")

    _cancelled.add(run_id)
    if run_id in _cancel_events:
        _cancel_events[run_id].set()
    if job.status in ("pending", "running"):
        job.status = "cancelled"

    try:
        gen = generator_registry._generators.get(generator_registry._active_id)
        if gen is not None and hasattr(gen, "_proc") and gen._proc and gen._proc.poll() is None:
            gen._proc.kill()
            gen._loaded = False
            gen._proc = None
    except Exception:
        pass

    return {"cancelled": True}

import asyncio
import threading
import traceback
import uuid
from typing import Dict, List
from fastapi import APIRouter, File, Form, UploadFile, HTTPException, BackgroundTasks
from services.generators.base import smooth_progress

import re as _re
from services.generator_registry import generator_registry, WORKSPACE_DIR
from schemas.generation import JobStatus

router = APIRouter(tags=["generation"])

_jobs: Dict[str, JobStatus] = {}


@router.post("/from-image")
async def generate_from_image(
    background_tasks: BackgroundTasks,
    image: List[UploadFile] = File(...),
    view_labels: str = Form(""),
    model_id: str = Form("sf3d"),
    collection: str = Form("Default"),
    vertex_count: int = Form(10000),
    remesh: str = Form("quad"),
    enable_texture: bool = Form(False),
    texture_resolution: int = Form(1024),
    octree_resolution: int = Form(380),
    guidance_scale: float = Form(5.5),
    seed: int = Form(-1),
    num_inference_steps: int = Form(30),
):
    for img in image:
        if not img.content_type or not img.content_type.startswith("image/"):
            raise HTTPException(400, "All files must be images")

    if remesh not in ("quad", "triangle", "none"):
        raise HTTPException(400, "remesh must be 'quad', 'triangle', or 'none'")

    # Sanitize collection name: strip, forbid path separators and special chars
    collection = collection.strip()
    if not collection or _re.search(r'[/:*?"<>|\\]', collection):
        collection = "Default"

    # Fix 1: verify that the REQUESTED model (not the active one) is downloaded
    try:
        requested = generator_registry.get_generator(model_id)
    except ValueError as e:
        raise HTTPException(400, str(e))

    if not requested.is_downloaded():
        raise HTTPException(
            400,
            f"Model '{model_id}' is not downloaded. "
            "Please download it from the app first."
        )

    generator_registry.switch_model(model_id)

    job_id = str(uuid.uuid4())
    image_bytes_list = [await img.read() for img in image]
    # Pass single bytes for backward compat, list for multi-view
    image_data = image_bytes_list[0] if len(image_bytes_list) == 1 else image_bytes_list
    # Parse view labels (e.g. "front,back" → ["front", "back"])
    parsed_view_labels = [v.strip() for v in view_labels.split(",") if v.strip()] if view_labels else []
    params      = {
        "vertex_count":       vertex_count,
        "remesh":             remesh,
        "enable_texture":     enable_texture,
        "texture_resolution": texture_resolution,
        "octree_resolution":    octree_resolution,
        "guidance_scale":       guidance_scale,
        "seed":                 seed,
        "num_inference_steps":  num_inference_steps,
        "view_labels":          parsed_view_labels,
    }

    job = JobStatus(job_id=job_id, status="pending", progress=0)
    _jobs[job_id] = job

    background_tasks.add_task(_run_generation, job_id, image_data, params, collection)

    return {"job_id": job_id}



@router.get("/status/{job_id}")
async def job_status(job_id: str):
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} not found")
    return job


async def _run_generation(job_id: str, image_bytes, params: dict, collection: str = "Default") -> None:
    job = _jobs[job_id]
    job.status = "running"

    def progress_cb(pct: int, step: str = "") -> None:
        job.progress = pct
        if step:
            job.step = step

    try:
        loop = asyncio.get_running_loop()

        # Check if the model needs to be loaded BEFORE calling get_active(),
        # because get_active() loads the model in a blocking manner.
        # active_status() is an instantaneous operation (simple dict lookup).
        if not generator_registry.active_status()["loaded"]:
            model_name = generator_registry.active_status()['name']
            progress_cb(0, f"Loading {model_name}…")
            stop_load_evt = threading.Event()
            load_thread = threading.Thread(
                target=smooth_progress,
                args=(progress_cb, 0, 9, f"Loading {model_name}…", stop_load_evt, 4.0),
                daemon=True,
            )
            load_thread.start()
            try:
                gen = await loop.run_in_executor(None, generator_registry.get_active)
            finally:
                stop_load_evt.set()
        else:
            gen = await loop.run_in_executor(None, generator_registry.get_active)

        # Direct output to the collection subfolder
        coll_dir = WORKSPACE_DIR / collection
        coll_dir.mkdir(parents=True, exist_ok=True)
        gen.outputs_dir = coll_dir

        output_path = await loop.run_in_executor(
            None,
            lambda: gen.generate(image_bytes, params, progress_cb),
        )
        job.status     = "done"
        job.progress   = 100
        job.output_url = f"/workspace/{collection}/{output_path.name}"

    except Exception as exc:
        tb = traceback.format_exc()
        print(f"[Generation ERROR] {exc}\n{tb}")
        job.status = "error"
        job.error  = tb.strip()

import asyncio
import json
from typing import Optional
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from services.generator_registry import generator_registry, MODELS_DIR

router = APIRouter(tags=["model"])


@router.get("/status")
async def model_status():
    """Status of the active model."""
    return generator_registry.active_status()


@router.get("/all")
async def all_models_status():
    """Status of all known models (downloaded, loaded, required VRAM)."""
    return generator_registry.all_status()


@router.get("/params")
async def model_params(model_id: Optional[str] = None):
    """Parameter schema of the active model (or a specified model)."""
    try:
        return generator_registry.params_schema(model_id)
    except KeyError:
        raise HTTPException(404, f"Unknown model ID: {model_id}")


@router.post("/switch")
async def switch_model(model_id: str):
    """Switch the active model."""
    try:
        generator_registry.switch_model(model_id)
        return {"active": model_id}
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/unload-all")
async def unload_all_models():
    """Unloads all models from memory to free VRAM/RAM."""
    generator_registry.unload_all()
    # Force Python to release memory back to the OS
    import gc
    gc.collect()
    try:
        import ctypes, sys
        if sys.platform == "win32":
            k32 = ctypes.windll.kernel32
            k32.SetProcessWorkingSetSizeEx(k32.GetCurrentProcess(), -1, -1, 0)
    except Exception:
        pass
    return {"unloaded": True}


@router.post("/unload/{model_id}")
async def unload_model(model_id: str):
    """Unloads a model from memory so its files can be safely deleted."""
    try:
        gen = generator_registry.get_generator(model_id)
        gen.unload()
        return {"unloaded": True}
    except ValueError:
        return {"unloaded": True}  # already not loaded, that's fine


@router.get("/hf-download")
async def hf_download(repo_id: str, model_id: str, skip_prefixes: Optional[str] = None):
    """
    Streams a HuggingFace Hub model download via SSE.
    Downloads into MODELS_DIR / model_id applying the filtering
    declared in the extension manifest (hf_skip_prefixes).

    skip_prefixes: JSON-encoded list of path prefixes to exclude (passed from Electron).
    Falls back to registry manifest if not provided.

    SSE format: data: {"percent": 0-100, "file": "...", "status": "..."}
    """
    import json as _json
    dest_dir  = str(MODELS_DIR / model_id)
    # Prefer skip_prefixes passed directly from the client (authoritative, no registry dep)
    if skip_prefixes:
        try:
            skip_list = _json.loads(skip_prefixes)
        except Exception:
            skip_list = []
    else:
        try:
            skip_list = generator_registry.get_manifest(model_id).get("hf_skip_prefixes", [])
        except KeyError:
            skip_list = []

    async def stream():
        loop = asyncio.get_running_loop()

        def _fmt(data: dict) -> str:
            return f"data: {json.dumps(data)}\n\n"

        try:
            yield _fmt({"percent": 0, "status": "Listing repository files…"})

            def _list_files():
                from huggingface_hub import list_repo_files
                return [
                    f for f in list_repo_files(repo_id)
                    if not any(f.startswith(p) for p in skip_list)
                ]

            files = await loop.run_in_executor(None, _list_files)
            total = len(files)

            if total == 0:
                yield _fmt({"error": f"No files found in HuggingFace repo: {repo_id}"})
                return

            yield _fmt({"percent": 1, "status": f"Downloading {total} files…"})

            from huggingface_hub import hf_hub_download

            for i, filename in enumerate(files):
                def _dl(f=filename):
                    hf_hub_download(
                        repo_id=repo_id,
                        filename=f,
                        local_dir=dest_dir,
                        local_dir_use_symlinks=False,
                    )

                await loop.run_in_executor(None, _dl)

                # Reserve 1-95 for file downloads, leave 95-100 for finalisation
                pct = 1 + round((i + 1) / total * 94)
                yield _fmt({"percent": pct, "file": filename, "fileIndex": i + 1, "totalFiles": total})

            yield _fmt({"percent": 100, "status": "done"})

        except Exception as exc:
            yield _fmt({"error": str(exc)})

    return StreamingResponse(stream(), media_type="text/event-stream")



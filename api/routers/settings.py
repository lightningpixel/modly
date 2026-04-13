import os
from fastapi import APIRouter
from pydantic import BaseModel
from pathlib import Path
from typing import Optional

import services.generator_registry as reg_module

router = APIRouter(prefix="/settings", tags=["settings"])


class PathsUpdate(BaseModel):
    models_dir:    Optional[str] = None
    workspace_dir: Optional[str] = None


class TokenUpdate(BaseModel):
    token: str


@router.get("/paths")
async def get_paths():
    return {
        "models_dir":    str(reg_module.MODELS_DIR),
        "workspace_dir": str(reg_module.WORKSPACE_DIR),
    }


@router.post("/paths")
async def update_paths(body: PathsUpdate):
    reg_module.generator_registry.update_paths(
        models_dir    = Path(body.models_dir)    if body.models_dir    else None,
        workspace_dir = Path(body.workspace_dir) if body.workspace_dir else None,
    )
    return {
        "models_dir":    str(reg_module.MODELS_DIR),
        "workspace_dir": str(reg_module.WORKSPACE_DIR),
    }


@router.post("/hf-token")
async def update_hf_token(body: TokenUpdate):
    """
    Update the HuggingFace token in this process's environment so that
    extension subprocesses spawned after this call inherit the new token.
    """
    if body.token:
        os.environ["HUGGING_FACE_HUB_TOKEN"] = body.token
        os.environ["HF_TOKEN"]               = body.token
    else:
        os.environ.pop("HUGGING_FACE_HUB_TOKEN", None)
        os.environ.pop("HF_TOKEN", None)
    return {"ok": True}

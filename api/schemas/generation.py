from typing import Any, Literal, Optional
from pydantic import BaseModel, Field


class JobStatus(BaseModel):
    job_id: str
    status: Literal["pending", "running", "done", "error", "cancelled"]
    progress: int = 0              # 0–100
    step: Optional[str] = None    # Human-readable current step
    output_url: Optional[str] = None
    error: Optional[str] = None


class GenerateFromArtifactRequest(BaseModel):
    """Generic typed-artifact request for model-only scene and video inputs."""
    input_kind: Literal["scene", "video"]
    input_path: str
    model_id: str
    collection: str = "Workflows"
    params: dict[str, Any] = Field(default_factory=dict)

from typing import Any, Literal, Optional
from pydantic import BaseModel, Field, computed_field

RunKind = Literal["generation", "workflow", "mesh_op"]
# JobStatus' vocabulary plus "interrupted": a run that was still pending/running when
# the backend stopped. It is terminal -- nothing will ever finish it.
RunStatusValue = Literal["pending", "running", "done", "error", "cancelled", "interrupted"]

TERMINAL_RUN_STATUSES = frozenset({"done", "error", "cancelled", "interrupted"})


class RunStep(BaseModel):
    """One timed phase of a run: a generation step label, or a workflow node."""
    name: str
    node_id: Optional[str] = None
    status: RunStatusValue = "running"
    started_at: float                    # epoch seconds
    ended_at: Optional[float] = None


class RunRecord(BaseModel):
    """What ran, with what, for how long, and what came out of it.

    One record per run, whatever drove it: a backend generation job, a workflow
    executed by the renderer, or a mesh operation. This is deliberately the shape
    the provenance model (T-F1) is meant to reuse -- an output's provenance is the
    record of the run that produced it (model or workflow, inputs, params,
    output_path) -- so there is one store of "how was this made", not two.

    Timestamps are epoch seconds. ``output_path`` is workspace-relative (POSIX
    separators) when the output lives in the workspace, absolute otherwise.
    """
    id: str
    kind: RunKind
    status: RunStatusValue = "pending"
    model_id: Optional[str] = None       # generation model, e.g. "triposg/generate"
    workflow_id: Optional[str] = None
    workflow_name: Optional[str] = None
    op_id: Optional[str] = None          # mesh operation id, e.g. "decimate"
    inputs: dict[str, Any] = Field(default_factory=dict)
    params: dict[str, Any] = Field(default_factory=dict)
    steps: list[RunStep] = Field(default_factory=list)
    error: Optional[str] = None
    output_path: Optional[str] = None
    created_at: float
    started_at: Optional[float] = None
    ended_at: Optional[float] = None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def duration_s(self) -> Optional[float]:
        start = self.started_at if self.started_at is not None else self.created_at
        if self.ended_at is None:
            return None
        return round(max(0.0, self.ended_at - start), 3)


class RunRecordPage(BaseModel):
    runs: list[RunRecord]
    total: int
    limit: int
    offset: int

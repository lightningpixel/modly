"""Shared types for Modly image operations.

Mirrors services.mesh_ops.types, plus what mesh ops never needed: an image op
can depend on things that are fetched on first use (a Python runtime, model
weights). Those are `Requirement`s; the router reports which are missing and
installs them on demand.
"""

from copy import deepcopy
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping, Optional, Protocol


# One progress frame, in the SSE format the renderer already consumes for LLM
# downloads (src/shared/services/llmDownloads.ts: percent, status,
# bytesDownloaded, totalBytes). Percent is 0..100 within the requirement.
ProgressCallback = Callable[[dict], None]


class ImageOpNotFoundError(LookupError):
    """Raised when a caller requests an operation that is not registered."""


class ImageOpNotReadyError(RuntimeError):
    """Raised when an operation runs before its requirements are installed."""

    def __init__(self, operation_id: str, missing: list[str]) -> None:
        super().__init__(f"{operation_id} is not ready: missing {', '.join(missing)}")
        self.operation_id = operation_id
        self.missing = missing


class ImageOpInputError(ValueError):
    """Raised when the input file is not an image the operation can read."""


class ImageOpExecutionError(RuntimeError):
    """Raised when an operation, or installing one of its requirements, fails."""


class Requirement(Protocol):
    """Something an op needs that is installed on first use."""

    kind: str   # "runtime" | "model"
    id: str     # e.g. "onnxruntime", "birefnet-lite"
    label: str  # shown in progress messages

    def is_ready(self) -> bool: ...

    def download_bytes(self) -> Optional[int]:
        """Approximate bytes still to fetch (best effort), None when unknown."""

    def install(self, progress: ProgressCallback) -> None:
        """Fetch and install; idempotent. Raises ImageOpExecutionError on failure."""


@dataclass(frozen=True)
class ImageOpContext:
    """Where an operation writes its outputs (read from the registry at call time)."""

    workspace_dir: Path

    @property
    def images_dir(self) -> Path:
        # Same folder Electron saves pasted images to (electron/main/workspace-images.ts).
        return self.workspace_dir / "Images"


@dataclass(frozen=True)
class ImageOpResult:
    path: Path
    mask_path: Optional[Path] = None
    details: Mapping[str, Any] = field(default_factory=dict)


ImageOpFn = Callable[[Path, Mapping[str, Any], ImageOpContext], ImageOpResult]


@dataclass(frozen=True)
class ImageOp:
    id: str
    label: str
    params_schema: tuple[Mapping[str, Any], ...]
    fn: ImageOpFn
    requirements: tuple[Requirement, ...] = ()

    def missing(self) -> list[str]:
        """Kinds of the requirements not installed yet, in install order."""
        return [req.kind for req in self.requirements if not req.is_ready()]

    def describe(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "params_schema": deepcopy(list(self.params_schema)),
            "requirements": [
                {"kind": req.kind, "id": req.id, "label": req.label}
                for req in self.requirements
            ],
        }

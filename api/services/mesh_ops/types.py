"""Shared types for Modly mesh operations."""

from copy import deepcopy
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping, Optional


ProgressCallback = Callable[[int, str], None]
LogCallback = Callable[[str], None]


class MeshOpNotFoundError(LookupError):
    """Raised when a caller requests an operation that is not registered."""


class MeshOpUnavailableError(RuntimeError):
    """Raised when an operation's runtime dependency is unavailable."""


class MeshOpExecutionError(RuntimeError):
    """Raised when an operation backend fails while processing a mesh."""


@dataclass(frozen=True)
class MeshOpContext:
    """Runtime paths and optional workflow-protocol callbacks for an operation."""

    workspace_dir: Path
    temp_dir: Path
    output_path: Optional[Path] = None
    preserve_visuals: bool = False
    progress_cb: Optional[ProgressCallback] = None
    log_cb: Optional[LogCallback] = None

    def progress(self, percent: int, label: str) -> None:
        if self.progress_cb is not None:
            self.progress_cb(percent, label)

    def log(self, message: str) -> None:
        if self.log_cb is not None:
            self.log_cb(message)


@dataclass(frozen=True)
class MeshOpResult:
    """The file produced by an operation and optional JSON-safe measurements."""

    file_path: Path
    details: Mapping[str, Any] = field(default_factory=dict)


MeshOpFn = Callable[[Path, Mapping[str, Any], MeshOpContext], MeshOpResult]


@dataclass(frozen=True)
class MeshOp:
    """One callable operation and the metadata consumed by the UI and agent."""

    id: str
    label: str
    params_schema: tuple[Mapping[str, Any], ...]
    fn: MeshOpFn
    category: str
    destructive: bool = False
    undoable: bool = True

    def describe(self) -> dict[str, Any]:
        """Return the public, serializable part of this registry entry."""
        return {
            "id": self.id,
            "label": self.label,
            "params_schema": deepcopy(list(self.params_schema)),
            "destructive": self.destructive,
            "undoable": self.undoable,
            "category": self.category,
        }

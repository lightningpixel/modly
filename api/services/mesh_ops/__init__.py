"""Unified mesh operation registry used by the API and workflow nodes."""

from .builtin import BUILTIN_MESH_OPS
from .registry import MeshOpsRegistry
from .types import (
    AgentTool,
    MeshOp,
    MeshOpContext,
    MeshOpExecutionError,
    MeshOpNotFoundError,
    MeshOpResult,
    MeshOpUnavailableError,
)


mesh_ops_registry = MeshOpsRegistry(BUILTIN_MESH_OPS)

__all__ = [
    "AgentTool",
    "MeshOp",
    "MeshOpContext",
    "MeshOpExecutionError",
    "MeshOpNotFoundError",
    "MeshOpResult",
    "MeshOpsRegistry",
    "MeshOpUnavailableError",
    "mesh_ops_registry",
]

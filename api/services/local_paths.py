"""Path confinement helpers for the local FastAPI server."""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

_EXTENSION_ID_CHARS = set("abcdefghijklmnopqrstuvwxyz0123456789._-")


def is_within_directory(root: Path, candidate: Path) -> bool:
    """True when *candidate* resolves inside *root* (symlink-aware)."""
    try:
        root_r = os.path.realpath(root)
        cand_r = os.path.realpath(candidate)
        return os.path.commonpath([root_r, cand_r]) == root_r
    except (ValueError, OSError):
        return False


def _is_windows_drive(component: str) -> bool:
    return len(component) >= 2 and component[0].isalpha() and component[1] == ":"


def resolve_workspace_file(workspace: Path, raw: str) -> Path:
    """Resolve a workspace-relative path and reject traversal / absolute inputs."""
    value = str(raw or "").strip()
    if not value:
        raise ValueError("path is required")

    normalized = value.replace("\\", "/")
    if normalized.startswith("/") or "://" in normalized:
        raise ValueError("absolute or remote paths are not allowed")

    parts = [part for part in normalized.split("/") if part not in ("", ".")]
    if not parts:
        raise ValueError("path is required")
    if any(part == ".." for part in parts):
        raise ValueError("path traversal is not allowed")
    if any(_is_windows_drive(part) for part in parts):
        raise ValueError("absolute or remote paths are not allowed")

    resolved = (workspace / value).resolve()
    if not is_within_directory(workspace, resolved):
        raise ValueError("path escapes workspace")
    return resolved


def is_modly_temp_file(path: Path) -> bool:
    """True for files Modly itself wrote under the process temp dir."""
    resolved = path.resolve()
    tmp = Path(tempfile.gettempdir()).resolve()
    if not is_within_directory(tmp, resolved):
        return False
    if resolved.name.startswith("modly_splat_"):
        return True
    return any(part.startswith("modly_import_") for part in resolved.parts)


def resolve_readable_mesh_path(workspace: Path, raw: str) -> Path:
    """Workspace-relative path, or an already-imported absolute temp/workspace file."""
    value = str(raw or "").strip()
    if not value:
        raise ValueError("path is required")

    candidate = Path(value)
    if candidate.is_absolute():
        resolved = candidate.resolve()
        if is_within_directory(workspace, resolved) or is_modly_temp_file(resolved):
            return resolved
        raise ValueError("absolute path is outside the workspace")

    return resolve_workspace_file(workspace, value)


def assert_safe_extension_id(ext_id: str) -> str:
    value = str(ext_id or "").strip()
    if not value or value in {".", ".."}:
        raise ValueError("invalid extension id")
    if "/" in value or "\\" in value:
        raise ValueError("invalid extension id")
    if value[0] == "." or any(ch not in _EXTENSION_ID_CHARS for ch in value):
        raise ValueError("invalid extension id")
    return value

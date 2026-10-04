"""Typed model artifact inputs shared by the API, worker bridge, and runner."""
from dataclasses import dataclass
from pathlib import Path

from services.scene_input import validate_scene_input
from services.video_input import VideoSnapshot, validate_video_input

SUPPORTED_ARTIFACT_INPUTS = frozenset({"scene", "video"})

# Transport parameters set by the host; callers must not be able to forge them.
RESERVED_ARTIFACT_PARAMS = frozenset({
    "artifact_path", "input_kind", "input_path", "scene_path", "scene_manifest_path",
    "video_path",
})


@dataclass(frozen=True)
class TypedArtifactInput:
    kind: str
    path: Path
    snapshot: VideoSnapshot | None = None


def validate_artifact_input(workspace: Path, kind: str, input_path: str) -> TypedArtifactInput:
    if kind not in SUPPORTED_ARTIFACT_INPUTS:
        raise ValueError(f"Unsupported artifact input kind: {kind}")
    if kind == "scene":
        return TypedArtifactInput(kind="scene", path=validate_scene_input(workspace, input_path))
    if kind == "video":
        path, snapshot = validate_video_input(workspace, input_path)
        return TypedArtifactInput(kind="video", path=path, snapshot=snapshot)
    raise ValueError(f"Unsupported artifact input kind: {kind}")


def revalidate_artifact_input(workspace: Path, value: TypedArtifactInput) -> TypedArtifactInput:
    try:
        relative = value.path.resolve(strict=True).relative_to(workspace.resolve(strict=True))
    except (OSError, ValueError) as exc:
        raise ValueError("Artifact input is outside the workspace") from exc
    validated = validate_artifact_input(workspace, value.kind, relative.as_posix())
    if value.kind == "video" and value.snapshot is not None and validated.snapshot != value.snapshot:
        raise ValueError("Video input changed after it was queued")
    return validated

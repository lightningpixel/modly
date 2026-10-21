"""Secure validation for workspace video model inputs."""
from dataclasses import dataclass
import hashlib
import os
import re
import stat
from pathlib import Path, PurePosixPath, PureWindowsPath

MAX_VIDEO_BYTES = 8 * 1024**3
SUPPORTED_VIDEO_EXTENSIONS = frozenset({".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi"})
_HEADER_BYTES = 64


@dataclass(frozen=True)
class VideoSnapshot:
    size: int
    mtime_ns: int
    device: int
    inode: int
    header_sha256: str


_SNAPSHOT_FIELDS = frozenset({"size", "mtime_ns", "device", "inode", "header_sha256"})


def video_snapshot_to_dict(snapshot: VideoSnapshot) -> dict:
    """Serialize a validated snapshot for the isolated runner envelope."""
    if not isinstance(snapshot, VideoSnapshot):
        raise ValueError("Video snapshot is required")
    return {
        "size": snapshot.size,
        "mtime_ns": snapshot.mtime_ns,
        "device": snapshot.device,
        "inode": snapshot.inode,
        "header_sha256": snapshot.header_sha256,
    }


def video_snapshot_from_dict(value: object) -> VideoSnapshot:
    """Strictly reconstruct a snapshot received across the process boundary."""
    if not isinstance(value, dict) or set(value) != _SNAPSHOT_FIELDS:
        raise ValueError("Video snapshot must contain exactly the expected fields")
    numeric = ("size", "mtime_ns", "device", "inode")
    if any(isinstance(value[field], bool) or not isinstance(value[field], int)
           for field in numeric):
        raise ValueError("Video snapshot numeric fields must be integers")
    if value["size"] <= 0 or any(value[field] < 0 for field in numeric[1:]):
        raise ValueError("Video snapshot contains invalid numeric values")
    digest = value["header_sha256"]
    if not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
        raise ValueError("Video snapshot contains an invalid header digest")
    return VideoSnapshot(
        size=value["size"],
        mtime_ns=value["mtime_ns"],
        device=value["device"],
        inode=value["inode"],
        header_sha256=digest,
    )


def _safe_relative(value: str) -> Path:
    if not isinstance(value, str) or not value or value != value.strip() or "\x00" in value:
        raise ValueError("Video path must be a nonempty workspace-relative path")
    normalized = value.replace("\\", "/")
    if (PurePosixPath(normalized).is_absolute() or PureWindowsPath(normalized).is_absolute()
            or re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", normalized)
            or re.search(r"%(?:25|2e|2f|5c|00)", normalized, re.I)
            or re.search(r"%(?![0-9a-f]{2})", normalized, re.I)
            or any(part in ("", ".", "..") for part in normalized.split("/"))):
        raise ValueError("Video path must be a safe workspace-relative path")
    return Path(*normalized.split("/"))


def _reject_link_components(path: Path, root: Path) -> None:
    try:
        relative = path.relative_to(root)
    except ValueError as exc:
        raise ValueError("Video path escapes the workspace") from exc
    current = root
    for part in relative.parts:
        current = current / part
        try:
            info = current.lstat()
        except OSError as exc:
            raise ValueError("Video file is missing or unreadable") from exc
        is_reparse = bool(getattr(info, "st_file_attributes", 0)
                          & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0))
        if current.is_symlink() or is_reparse:
            raise ValueError("Video path must not use symlinks or reparse points")


def _signature_matches(suffix: str, header: bytes) -> bool:
    if suffix in {".mp4", ".m4v", ".mov"}:
        return len(header) >= 12 and header[4:8] == b"ftyp"
    if suffix in {".webm", ".mkv"}:
        return header.startswith(b"\x1a\x45\xdf\xa3")
    if suffix == ".avi":
        return len(header) >= 12 and header[:4] == b"RIFF" and header[8:12] == b"AVI "
    return False


def validate_video_input(workspace: Path, video_path: str) -> tuple[Path, VideoSnapshot]:
    """Return a canonical file and stable snapshot without decoding the video."""
    root = workspace.resolve(strict=True)
    candidate = root / _safe_relative(video_path)
    _reject_link_components(candidate, root)
    suffix = candidate.suffix.lower()
    if suffix not in SUPPORTED_VIDEO_EXTENSIONS:
        raise ValueError("Video input uses an unsupported file extension")

    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(candidate, flags)
    except OSError as exc:
        raise ValueError("Video file is missing or unreadable") from exc
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            raise ValueError("Video input must be a regular file")
        if info.st_size <= 0:
            raise ValueError("Video input must not be empty")
        if info.st_size > MAX_VIDEO_BYTES:
            raise ValueError("Video input exceeds the 8 GiB size limit")
        header = os.read(descriptor, _HEADER_BYTES)
    finally:
        os.close(descriptor)

    try:
        canonical = candidate.resolve(strict=True)
        canonical.relative_to(root)
        after = candidate.lstat()
    except (OSError, ValueError) as exc:
        raise ValueError("Video path escapes the workspace") from exc
    if not stat.S_ISREG(after.st_mode) or (after.st_dev, after.st_ino) != (info.st_dev, info.st_ino):
        raise ValueError("Video file changed while it was being validated")
    if not _signature_matches(suffix, header):
        raise ValueError("Video file signature does not match its extension")
    snapshot = VideoSnapshot(
        size=info.st_size,
        mtime_ns=info.st_mtime_ns,
        device=info.st_dev,
        inode=info.st_ino,
        header_sha256=hashlib.sha256(header).hexdigest(),
    )
    return canonical, snapshot

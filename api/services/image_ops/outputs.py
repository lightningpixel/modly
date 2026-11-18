"""Output file naming for image ops, matching electron/main/workspace-images.ts:
`<stem>-<tag>-YYYYMMDD-HHMMSS-<hex>.png`, sortable by time, never overwriting."""

import io
import re
import secrets
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional, Sequence

_WINDOWS_RESERVED = re.compile(r"^(con|prn|aux|nul|com[0-9]|lpt[0-9])$", re.IGNORECASE)
_MAX_STEM = 60


def sanitize_stem(name: str) -> str:
    """Filesystem-safe stem: only [A-Za-z0-9_-], no reserved Windows name, else "image"."""
    leaf = re.split(r"[\\/]", name or "")[-1]
    stem = Path(leaf).stem or leaf
    ascii_only = unicodedata.normalize("NFKD", stem).encode("ascii", "ignore").decode("ascii")
    safe = re.sub(r"[^A-Za-z0-9_-]+", "-", ascii_only)
    safe = re.sub(r"-{2,}", "-", safe).strip("-_")[:_MAX_STEM].rstrip("-_")
    if not safe or _WINDOWS_RESERVED.match(safe):
        return "image"
    return safe


def output_name(stem: str, tag: str, now: datetime, suffix: str) -> str:
    return f"{stem}-{tag}-{now:%Y%m%d-%H%M%S}-{suffix}.png"


def write_new_files(
    directory: Path,
    stem: str,
    payloads: Sequence[tuple[str, bytes]],
    now: Optional[datetime] = None,
    token: Callable[[], str] = lambda: secrets.token_hex(3),
    attempts: int = 20,
) -> list[Path]:
    """Write each (tag, bytes) as a new file sharing one timestamp and suffix.

    Files are created exclusively ("xb"), so an existing file is never
    overwritten: on a name clash every file of the set is removed and the set
    is retried with a fresh suffix.
    """
    directory.mkdir(parents=True, exist_ok=True)
    stamp = now or datetime.now()
    for _ in range(attempts):
        suffix = token()
        written: list[Path] = []
        try:
            for tag, data in payloads:
                path = directory / output_name(stem, tag, stamp, suffix)
                with open(path, "xb") as handle:
                    written.append(path)
                    handle.write(data)
            return written
        except FileExistsError:
            for path in written:
                path.unlink(missing_ok=True)
            continue
        except BaseException:
            for path in written:
                path.unlink(missing_ok=True)
            raise
    raise FileExistsError(f"Could not find a free output name in {directory}")


def png_bytes(image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()

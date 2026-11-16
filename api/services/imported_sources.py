"""Registry of meshes the user explicitly imported from outside the workspace.

`/optimize/import-by-path` serves files the user picked through the OS file
dialog, either in place or converted into a temp dir — never from the workspace.
The slicer export route confines itself to the workspace by design, so those
imports would be unsliceable without widening that guard to arbitrary absolute
paths, which would be a real regression.

This registry is the narrow alternative: a route may accept an absolute path
only if it is an EXACT member here, i.e. a file the user chose themselves in
this session. Membership is an equality test, never a prefix test, so it grants
no traversal.

It also remembers each file's ORIGINAL suffix. An imported `.stl` is converted
to GLB on import without any axis change, so the container extension alone would
mislead a consumer into applying the glTF Y-up -> Z-up rotation to data that is
already Z-up.

Session-scoped and in-memory: it is emptied when the backend restarts, so a
deeplink replayed after a restart is rejected rather than silently served. Links
are consumed within a second of the click, so this is not worth persisting.
"""

from pathlib import Path

# resolved absolute path (str) -> original suffix, lowercase, with the dot
_SOURCES: dict[str, str] = {}


def register(served_path: str | Path, original_path: str | Path) -> str:
    """Record a user-imported file as sliceable and return its resolved path.

    ``served_path`` is what gets served (possibly a converted temp GLB);
    ``original_path`` is the file the user actually picked, whose suffix decides
    the source format.
    """
    resolved = str(Path(served_path).resolve())
    _SOURCES[resolved] = Path(original_path).suffix.lower()
    return resolved


def source_suffix(path: str | Path) -> str | None:
    """Original suffix of a registered import, or None if it is not registered."""
    return _SOURCES.get(str(Path(path).resolve()))


def is_registered(path: str | Path) -> bool:
    return source_suffix(path) is not None


def clear() -> None:
    """Drop every entry — for tests."""
    _SOURCES.clear()

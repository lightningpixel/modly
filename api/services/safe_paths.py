"""
Containment helpers for every path that comes from outside the process.

The API listens on loopback with no authentication, so "outside" is not only
the app's own renderer: any page the user has open in a browser can reach these
endpoints. A path parameter that escapes its directory is therefore a remote
primitive, not a local one — arbitrary read for a served file, arbitrary write
for a download destination, and arbitrary code execution for a directory whose
setup.py gets run.

Two rules, deliberately separate:
  * `resolve_within` — a *relative* path under a root (workspace files).
  * `safe_segment`   — a *single* name, no separators at all (model ids,
                       extension ids: the caller joins them onto a root and
                       nothing below them may be addressed).
"""
from pathlib import Path


class UnsafePath(ValueError):
    """A caller-supplied path tried to leave the directory it belongs to."""


def resolve_within(root: Path, user_path: str) -> Path:
    """Resolve `user_path` under `root`, or raise UnsafePath.

    Uses containment on the resolved paths rather than a string prefix test:
    `str(p).startswith(str(root))` also accepts a *sibling* whose name merely
    starts with the root's ("…/workspace_evil/leak.splat" passed it), and it
    misses the separator that a real parent/child relation requires.

    An absolute `user_path` is allowed only when it already points inside the
    root: joining it replaces the root, and the containment test below then
    decides. Callers that hand out absolute paths of their own (the splat/GLB
    conversion cache) rely on that.
    """
    root = Path(root).resolve()
    candidate = (root / user_path).resolve()
    if candidate != root and root not in candidate.parents:
        raise UnsafePath(f"Path escapes {root}: {user_path!r}")
    return candidate


def safe_segment(name: str) -> str:
    """Return `name` if it is a single, plain path component, else raise.

    Rejects both separators, not just the platform's: on Windows a backslash
    ends a path component too, and `POST /extensions/setup/..\evil` was enough
    to run any setup.py on the disk — the URL router never sees a backslash as
    a separator, so the traversal reached the filesystem intact.
    """
    if not name or name in (".", ".."):
        raise UnsafePath(f"Invalid name: {name!r}")
    if "/" in name or "\\" in name or "\x00" in name:
        raise UnsafePath(f"Name must not contain a path separator: {name!r}")
    # "C:", "C:evil" — a drive-relative path on Windows.
    if len(name) >= 2 and name[1] == ":":
        raise UnsafePath(f"Name must not contain a drive letter: {name!r}")
    return name

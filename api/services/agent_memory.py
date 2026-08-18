"""
Persistent agent memory — one markdown note per fact, stored as plain files.

Obsidian-style: the folder is plain .md files the user can open, edit or sync
with any editor. The agent sees a compact index in its system prompt and reads
full notes on demand via the recall tool.
"""
import json
import os
import re
from pathlib import Path

MEMORY_DIR = Path(os.environ.get("MODLY_MEMORY_DIR") or Path.home() / ".modly" / "agent_memory")

MAX_NOTES = 200
MAX_NOTE_CHARS = 2000

# Distinct note names can collapse to the same slug (e.g. "Node tips!" and
# "node tips"). This sidecar maps slug-stem -> exact name so a genuinely
# different name gets a "-2", "-3", … suffix instead of silently overwriting
# an unrelated note. Missing/corrupt file → treated as empty (backward
# compatible with notes saved before this map existed).
_SLUG_MAP_PATH = MEMORY_DIR / ".slug-names.json"


def _slug(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:60]
    return slug or "note"


def _files() -> list[Path]:
    if not MEMORY_DIR.exists():
        return []
    return sorted(MEMORY_DIR.glob("*.md"))


def _load_slug_map() -> dict[str, str]:
    try:
        return json.loads(_SLUG_MAP_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_slug_map(mapping: dict[str, str]) -> None:
    _SLUG_MAP_PATH.write_text(json.dumps(mapping, indent=2), encoding="utf-8")


def _resolve_stem(name: str) -> str:
    """Stem to write `name`'s note under: the base slug if it's free or
    already holds this exact name, otherwise the first free (or
    already-this-name) `-N` suffix on that slug."""
    base_slug = _slug(name)
    mapping = _load_slug_map()
    name_norm = name.strip().lower()

    candidates = [base_slug] + [f"{base_slug}-{i}" for i in range(2, MAX_NOTES + 2)]
    stem = None
    for candidate in candidates:
        path = MEMORY_DIR / f"{candidate}.md"
        known_name = mapping.get(candidate)
        if not path.exists():
            stem = candidate  # free slot (new note, or a legacy note with no map entry got deleted)
            break
        if known_name == name_norm or (known_name is None and candidate == base_slug):
            stem = candidate  # this exact note, or a legacy note we have no name record for
            break
    if stem is None:
        stem = candidates[-1]  # extremely unlikely: exhausted all suffixes

    if mapping.get(stem) != name_norm:
        mapping[stem] = name_norm
        _save_slug_map(mapping)
    return stem


def save(name: str, content: str) -> str:
    """Write (or overwrite) a note. Returns the note's slug name."""
    MEMORY_DIR.mkdir(parents=True, exist_ok=True)
    stem = _resolve_stem(name)
    path = MEMORY_DIR / f"{stem}.md"
    if not path.exists() and len(_files()) >= MAX_NOTES:
        raise ValueError(f"Memory is full ({MAX_NOTES} notes). Delete old notes first.")
    path.write_text(content.strip()[:MAX_NOTE_CHARS] + "\n", encoding="utf-8")
    return path.stem


def notes() -> list[dict]:
    """All notes with full content, most recently modified first."""
    files = sorted(_files(), key=lambda p: p.stat().st_mtime, reverse=True)
    return [{"name": p.stem, "content": p.read_text(encoding="utf-8").strip()} for p in files]


def index() -> list[dict]:
    """Compact listing for prompt injection: note name + its first line.

    Runs on every chat request, so we read only the first non-blank line per
    note instead of loading each file's full contents.
    """
    out = []
    for p in _files():
        summary = ""
        try:
            with p.open(encoding="utf-8") as fh:
                for line in fh:
                    stripped = line.strip()
                    if stripped:
                        summary = stripped[:120]
                        break
        except Exception:
            pass
        out.append({"name": p.stem, "summary": summary})
    return out


def search(query: str) -> list[dict]:
    """Case-insensitive substring match on name or content."""
    q = query.strip().lower()
    if not q:
        return []
    return [n for n in notes() if q in n["name"].lower() or q in n["content"].lower()]


def delete(name: str) -> bool:
    name_norm = name.strip().lower()
    base_slug = _slug(name)
    mapping = _load_slug_map()

    # Prefer an exact name match recorded in the slug map (handles notes that
    # got a "-N" suffix because their slug collided with a different name).
    for stem, known_name in mapping.items():
        if known_name == name_norm and stem.startswith(base_slug) and (MEMORY_DIR / f"{stem}.md").exists():
            (MEMORY_DIR / f"{stem}.md").unlink()
            mapping.pop(stem, None)
            _save_slug_map(mapping)
            return True

    path = MEMORY_DIR / f"{base_slug}.md"
    if path.exists():
        path.unlink()
        mapping.pop(base_slug, None)
        _save_slug_map(mapping)
        return True
    return False


def clear() -> int:
    files = _files()
    for p in files:
        p.unlink()
    return len(files)

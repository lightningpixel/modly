"""Validation and readiness helpers for manifest-declared Hugging Face sources."""

from __future__ import annotations

import re
import unicodedata
from pathlib import Path
from typing import Any


_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_WINDOWS_DEVICE = re.compile(
    r"^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$", re.IGNORECASE
)
_WINDOWS_UNSAFE = re.compile(r'[<>"|?*\x00-\x1f]')


def _portable_segment(value: str, field: str) -> str:
    if (
        not value
        or value in {".", ".."}
        or value.endswith((".", " "))
        or ":" in value
        or _WINDOWS_UNSAFE.search(value)
        or _WINDOWS_DEVICE.fullmatch(value)
    ):
        raise ValueError(f'{field} contains unsafe path segment "{value}"')
    return value


def safe_source_id(value: Any, field: str = "model source id") -> str:
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or _SAFE_ID.fullmatch(value) is None
    ):
        raise ValueError(f"{field} must be a safe non-empty identifier")
    return _portable_segment(value, field)


def safe_relative_path(value: Any, field: str, *, allow_dot: bool = False) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise ValueError(f"{field} must be a non-empty relative path")
    if allow_dot and value == ".":
        return value
    if value == "." or value.startswith("/") or "\\" in value:
        raise ValueError(f"{field} must be a safe relative POSIX path")
    for part in value.split("/"):
        _portable_segment(part, field)
    return value


def _safe_prefix(value: Any, field: str) -> str:
    path = value[:-1] if isinstance(value, str) and value.endswith("/") else value
    safe_relative_path(path, field)
    return value


def _prefixes(value: Any, field: str) -> list[str] | None:
    if not isinstance(value, list):
        raise ValueError(f"{field} must be an array")
    return [_safe_prefix(entry, f"{field}[{index}]") for index, entry in enumerate(value)]


def _safe_repo_id(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip() or "\\" in value:
        raise ValueError(f"{field} must be a non-empty Hugging Face repository id")
    parts = value.split("/")
    if len(parts) > 2 or any(
        part in {"", ".", ".."} or _SAFE_ID.fullmatch(part) is None for part in parts
    ):
        raise ValueError(f"{field} is not a safe Hugging Face repository id")
    return value


def _safe_revision(value: Any, field: str) -> str | None:
    if value is None:
        return None
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or value.startswith("/")
        or "\\" in value
        or "\0" in value
        or any(part in {"", ".", ".."} for part in value.split("/"))
    ):
        raise ValueError(f"{field} must be a safe non-empty revision")
    return value


def normalize_model_sources(node: dict[str, Any]) -> list[dict[str, Any]] | None:
    """Validate only the new contract; legacy fields remain untouched."""
    if "model_sources" not in node:
        return None
    raw_sources = node["model_sources"]
    if not isinstance(raw_sources, list) or not raw_sources:
        raise ValueError("model_sources must be a non-empty array")

    aliases: dict[str, str] = {}
    sources: list[dict[str, Any]] = []
    for index, raw in enumerate(raw_sources):
        field = f"model_sources[{index}]"
        if not isinstance(raw, dict):
            raise ValueError(f"{field} must be an object")
        source_id = safe_source_id(raw.get("id"), f"{field}.id")
        alias = unicodedata.normalize("NFC", source_id).casefold()
        if alias in aliases:
            raise ValueError(
                f'model source ids "{aliases[alias]}" and "{source_id}" are not portable-unique'
            )
        aliases[alias] = source_id
        if raw.get("provider") != "huggingface":
            raise ValueError(f'{field}.provider must be "huggingface"')
        checks = raw.get("checks")
        if not isinstance(checks, list) or not checks:
            raise ValueError(f"{field}.checks must be a non-empty array")

        source: dict[str, Any] = {
            "id": source_id,
            "provider": "huggingface",
            "repo_id": _safe_repo_id(raw.get("repo_id"), f"{field}.repo_id"),
            "destination": safe_relative_path(
                raw.get("destination"), f"{field}.destination", allow_dot=True
            ),
            "checks": [
                safe_relative_path(check, f"{field}.checks[{check_index}]")
                for check_index, check in enumerate(checks)
            ],
        }
        revision = (
            _safe_revision(raw["revision"], f"{field}.revision")
            if "revision" in raw
            else None
        )
        if "revision" in raw and revision is None:
            raise ValueError(f"{field}.revision must be a safe non-empty revision")
        include = (
            _prefixes(raw["include_prefixes"], f"{field}.include_prefixes")
            if "include_prefixes" in raw
            else None
        )
        skip = (
            _prefixes(raw["skip_prefixes"], f"{field}.skip_prefixes")
            if "skip_prefixes" in raw
            else None
        )
        if revision is not None:
            source["revision"] = revision
        if include is not None:
            source["include_prefixes"] = include
        if skip is not None:
            source["skip_prefixes"] = skip
        sources.append(source)
    return sources


def _path_has_symlink(root: Path, candidate: Path) -> bool:
    root = root.absolute()
    candidate = candidate.absolute()
    try:
        relative = candidate.relative_to(root)
    except ValueError:
        return True
    current = root
    if current.exists() and current.is_symlink():
        return True
    for part in relative.parts:
        current /= part
        if current.exists() and current.is_symlink():
            return True
    return False


def resolve_model_root(models_dir: Path, model_id: str) -> Path:
    if not isinstance(model_id, str):
        raise ValueError("Model id must be a string")
    parts = model_id.split("/")
    if len(parts) != 2:
        raise ValueError("Model id must identify one extension node")
    extension_id = safe_source_id(parts[0], "extension id")
    node_id = safe_source_id(parts[1], "model node id")
    root = models_dir.absolute()
    candidate = root / extension_id / node_id
    if _path_has_symlink(root, candidate):
        raise ValueError("Model path resolves through a symlink")
    try:
        candidate.resolve().relative_to(root.resolve())
    except ValueError as exc:
        raise ValueError("Model path escapes the models directory") from exc
    return candidate


def resolve_source_destination(models_dir: Path, model_id: str, destination: str) -> Path:
    model_root = resolve_model_root(models_dir, model_id)
    safe_destination = safe_relative_path(destination, "destination", allow_dot=True)
    candidate = model_root if safe_destination == "." else model_root.joinpath(*safe_destination.split("/"))
    if _path_has_symlink(model_root, candidate):
        raise ValueError("Source destination resolves through a symlink")
    return candidate


def resolve_download_path(destination: Path, filename: str) -> Path:
    safe_filename = safe_relative_path(filename, "Hugging Face repository file")
    candidate = destination.joinpath(*safe_filename.split("/"))
    if _path_has_symlink(destination, candidate):
        raise ValueError("Download target resolves through a symlink")
    return candidate


def model_sources_are_downloaded(
    models_dir: Path, model_id: str, sources: list[dict[str, Any]]
) -> bool:
    try:
        model_root = resolve_model_root(models_dir, model_id)
        if not model_root.is_dir():
            return False
        for source in sources:
            destination = resolve_source_destination(
                models_dir, model_id, source["destination"]
            )
            if not destination.is_dir():
                return False
            for check in source["checks"]:
                candidate = resolve_download_path(destination, check)
                if not candidate.exists() or _path_has_symlink(model_root, candidate):
                    return False
        return bool(sources)
    except (KeyError, OSError, TypeError, ValueError):
        return False


def validate_source_file_plan(
    sources: list[dict[str, Any]], files_by_source: dict[str, list[str]]
) -> None:
    """Reject cross-source aliases before the first file is written."""
    aliases: dict[str, tuple[str, str]] = {}
    for source in sources:
        source_id = source["id"]
        destination = source["destination"]
        for filename in files_by_source[source_id]:
            safe_filename = safe_relative_path(filename, f'model source "{source_id}" file')
            target = safe_filename if destination == "." else f"{destination}/{safe_filename}"
            for value in (target, f"{target}.part"):
                alias = unicodedata.normalize("NFC", value).casefold()
                for previous_alias, (previous_source, previous_target) in aliases.items():
                    if previous_source == source_id:
                        continue
                    if (
                        alias == previous_alias
                        or alias.startswith(f"{previous_alias}/")
                        or previous_alias.startswith(f"{alias}/")
                    ):
                        raise ValueError(
                            "Model sources have a portable target collision: "
                            f'"{previous_source}:{previous_target}" and "{source_id}:{value}"'
                        )
                aliases[alias] = (source_id, value)

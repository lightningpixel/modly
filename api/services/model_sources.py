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


def normalize_model_sources(
    node: dict[str, Any], *, field_name: str = "model_sources"
) -> list[dict[str, Any]] | None:
    """Validate only the new contract; legacy fields remain untouched."""
    if "model_sources" not in node:
        return None
    raw_sources = node["model_sources"]
    if not isinstance(raw_sources, list) or not raw_sources:
        raise ValueError(f"{field_name} must be a non-empty array")

    aliases: dict[str, str] = {}
    sources: list[dict[str, Any]] = []
    for index, raw in enumerate(raw_sources):
        field = f"{field_name}[{index}]"
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


def validate_model_node_ids(nodes: list[dict[str, Any]]) -> None:
    """Managed node roots must be unique on case-insensitive filesystems too."""
    seen: set[str] = set()
    for node in nodes:
        if not isinstance(node, dict):
            raise ValueError("model node must be an object")
        if isinstance(node.get("id"), str) and node["id"].casefold() == "_shared":
            raise ValueError('model node id "_shared" is reserved')
        node_id = safe_source_id(node.get("id"), "model node id")
        alias = node_id.casefold()
        if alias in seen:
            raise ValueError(f'model node id "{node_id}" is not portable-unique')
        seen.add(alias)


def normalize_weight_groups(manifest: dict[str, Any]) -> list[dict[str, Any]] | None:
    if "weight_groups" not in manifest:
        return None
    raw_groups = manifest["weight_groups"]
    if not isinstance(raw_groups, list) or not raw_groups:
        raise ValueError("weight_groups must be a non-empty array")

    aliases: dict[str, str] = {}
    groups: list[dict[str, Any]] = []
    for index, raw in enumerate(raw_groups):
        field = f"weight_groups[{index}]"
        if not isinstance(raw, dict):
            raise ValueError(f"{field} must be an object")
        raw_group_id = raw.get("id")
        if isinstance(raw_group_id, str) and raw_group_id.casefold() == "_shared":
            raise ValueError(f'{field}.id uses the reserved identifier "_shared"')
        group_id = safe_source_id(raw_group_id, f"{field}.id")
        alias = unicodedata.normalize("NFC", group_id).casefold()
        if alias in aliases:
            raise ValueError(
                f'weight group ids "{aliases[alias]}" and "{group_id}" '
                "are not portable-unique"
            )
        aliases[alias] = group_id
        sources = normalize_model_sources(
            {"model_sources": raw.get("model_sources")},
            field_name=f"{field}.model_sources",
        )
        groups.append({"id": group_id, "model_sources": sources})
    return groups


def normalize_weight_group_references(
    node: dict[str, Any],
    groups: list[dict[str, Any]] | None,
    *,
    field_name: str = "weight_groups",
) -> list[str] | None:
    if "weight_groups" not in node:
        return None
    raw_refs = node["weight_groups"]
    if not isinstance(raw_refs, list) or not raw_refs:
        raise ValueError(f"{field_name} must be a non-empty array of weight group ids")

    available = {
        unicodedata.normalize("NFC", group["id"]).casefold(): group["id"]
        for group in groups or []
    }
    aliases: dict[str, str] = {}
    refs: list[str] = []
    for index, raw in enumerate(raw_refs):
        group_id = safe_source_id(raw, f"{field_name}[{index}]")
        alias = unicodedata.normalize("NFC", group_id).casefold()
        if alias in aliases:
            raise ValueError(
                f'weight group references "{aliases[alias]}" and "{group_id}" '
                "are not portable-unique"
            )
        aliases[alias] = group_id
        canonical = available.get(alias)
        if canonical is None:
            raise ValueError(
                f'{field_name}[{index}] references unknown weight group "{group_id}"'
            )
        refs.append(canonical)
    return refs


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
    if parts[1].casefold() == "_shared":
        raise ValueError('Model node id "_shared" is reserved')
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


def resolve_weight_group_root(models_dir: Path, extension_id: str, group_id: str) -> Path:
    safe_extension_id = safe_source_id(extension_id, "extension id")
    if isinstance(group_id, str) and group_id.casefold() == "_shared":
        raise ValueError('Weight group id "_shared" is reserved')
    safe_group_id = safe_source_id(group_id, "weight group id")
    root = models_dir.absolute()
    candidate = root / safe_extension_id / "_shared" / safe_group_id
    if _path_has_symlink(root, candidate):
        raise ValueError("Weight group path resolves through a symlink")
    try:
        candidate.resolve().relative_to(root.resolve())
    except ValueError as exc:
        raise ValueError("Weight group path escapes the models directory") from exc
    return candidate


def resolve_weight_storage_root(models_dir: Path, target_id: str) -> Path:
    if not isinstance(target_id, str):
        raise ValueError("Weight target id must be a string")
    parts = target_id.split("/")
    if len(parts) == 2:
        return resolve_model_root(models_dir, target_id)
    if len(parts) == 3 and parts[1] == "_shared":
        return resolve_weight_group_root(models_dir, parts[0], parts[2])
    raise ValueError(
        "Weight target id must identify one model node or extension weight group"
    )


def resolve_source_destination(models_dir: Path, model_id: str, destination: str) -> Path:
    model_root = resolve_model_root(models_dir, model_id)
    safe_destination = safe_relative_path(destination, "destination", allow_dot=True)
    candidate = model_root if safe_destination == "." else model_root.joinpath(*safe_destination.split("/"))
    if _path_has_symlink(model_root, candidate):
        raise ValueError("Source destination resolves through a symlink")
    return candidate


def resolve_source_destination_at_root(model_root: Path, destination: str) -> Path:
    safe_destination = safe_relative_path(destination, "destination", allow_dot=True)
    candidate = (
        model_root
        if safe_destination == "."
        else model_root.joinpath(*safe_destination.split("/"))
    )
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
        return model_sources_are_downloaded_at_root(model_root, sources)
    except (KeyError, OSError, TypeError, ValueError):
        return False


def model_sources_are_downloaded_at_root(
    model_root: Path, sources: list[dict[str, Any]]
) -> bool:
    try:
        if not model_root.is_dir():
            return False
        for source in sources:
            destination = resolve_source_destination_at_root(
                model_root, source["destination"]
            )
            if not destination.is_dir():
                return False
            for check in source["checks"]:
                candidate = resolve_download_path(destination, check)
                if (
                    not candidate.is_file()
                    or candidate.stat().st_size <= 0
                    or _path_has_symlink(model_root, candidate)
                ):
                    return False
        return bool(sources)
    except (KeyError, OSError, TypeError, ValueError):
        return False


def weight_group_sources_are_downloaded(
    models_dir: Path, extension_id: str, group: dict[str, Any]
) -> bool:
    try:
        return model_sources_are_downloaded_at_root(
            resolve_weight_group_root(models_dir, extension_id, group["id"]),
            group["model_sources"],
        )
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
        source_files = {
            safe_relative_path(filename, f'model source "{source_id}" file')
            for filename in files_by_source[source_id]
        }
        missing_checks = [check for check in source["checks"] if check not in source_files]
        if missing_checks:
            raise ValueError(
                f'Model source "{source_id}" checks files excluded from its download plan: '
                + ", ".join(missing_checks)
            )
        for safe_filename in source_files:
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

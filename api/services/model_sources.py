"""Validation and readiness helpers for manifest-declared Hugging Face sources."""

from __future__ import annotations

import math
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


def _prefixes_overlap(left: list[str], right: list[str]) -> bool:
    return any(
        a.lower().startswith(b.lower()) or b.lower().startswith(a.lower())
        for a in left
        for b in right
    )


def _assert_param_offers_variants(param: str, params_schema: Any, ids: list[str]) -> None:
    """Variant ids must be selectable, so the param they key has to exist and offer them."""
    entry = next(
        (p for p in params_schema if isinstance(p, dict) and p.get("id") == param),
        None,
    ) if isinstance(params_schema, list) else None
    if entry is None:
        raise ValueError(f'weight_variants.param must name a params_schema entry ("{param}")')
    options = entry.get("options")
    if not isinstance(options, list):
        return
    values = {
        str(option.get("value")) if isinstance(option, dict) else str(option)
        for option in options
    }
    missing = [variant_id for variant_id in ids if variant_id not in values]
    if missing:
        raise ValueError(
            f'the "{param}" param must offer every weight variant id '
            f'(missing: {", ".join(missing)})'
        )


def normalize_weight_variants(
    node: dict[str, Any], params_schema: Any = None
) -> dict[str, Any] | None:
    """Validate a node's separately installable weight variants (e.g. quantizations)."""
    if "weight_variants" not in node:
        return None
    if "model_sources" in node:
        raise ValueError("weight_variants cannot be combined with model_sources")
    if "weight_groups" in node:
        raise ValueError("weight_variants cannot be combined with weight_groups")
    if not isinstance(node.get("hf_repo"), str) or not node["hf_repo"]:
        raise ValueError("weight_variants requires hf_repo on the same node")
    raw = node["weight_variants"]
    if not isinstance(raw, dict):
        raise ValueError("weight_variants must be an object")
    param = safe_source_id(raw.get("param"), "weight_variants.param")
    raw_options = raw.get("options")
    if not isinstance(raw_options, list) or not raw_options:
        raise ValueError("weight_variants.options must be a non-empty array")

    aliases: dict[str, str] = {}
    options: list[dict[str, Any]] = []
    for index, raw_option in enumerate(raw_options):
        field = f"weight_variants.options[{index}]"
        if not isinstance(raw_option, dict):
            raise ValueError(f"{field} must be an object")
        variant_id = safe_source_id(raw_option.get("id"), f"{field}.id")
        alias = unicodedata.normalize("NFC", variant_id).casefold()
        if alias in aliases:
            raise ValueError(
                f'weight variant ids "{aliases[alias]}" and "{variant_id}" are not portable-unique'
            )
        aliases[alias] = variant_id
        label = raw_option.get("label", variant_id)
        if not isinstance(label, str) or not label.strip():
            raise ValueError(f"{field}.label must be a non-empty string")
        size_gb = raw_option.get("size_gb")
        if size_gb is not None and (
            isinstance(size_gb, bool)
            or not isinstance(size_gb, (int, float))
            or not math.isfinite(size_gb)
            or size_gb <= 0
        ):
            raise ValueError(f"{field}.size_gb must be a positive number")
        vram_gb = raw_option.get("vram_gb")
        if vram_gb is not None and (
            isinstance(vram_gb, bool)
            or not isinstance(vram_gb, (int, float))
            or not math.isfinite(vram_gb)
            or vram_gb <= 0
        ):
            raise ValueError(f"{field}.vram_gb must be a positive number")
        include = _prefixes(raw_option.get("include_prefixes"), f"{field}.include_prefixes")
        if not include:
            raise ValueError(f"{field}.include_prefixes must be a non-empty array")
        checks = raw_option.get("checks")
        if not isinstance(checks, list) or not checks:
            raise ValueError(f"{field}.checks must be a non-empty array")
        safe_checks: list[str] = []
        for check_index, check in enumerate(checks):
            path = safe_relative_path(check, f"{field}.checks[{check_index}]")
            if not any(path.startswith(prefix) for prefix in include):
                raise ValueError(
                    f"{field}.checks[{check_index}] is not covered by its include_prefixes"
                )
            safe_checks.append(path)
        option: dict[str, Any] = {
            "id": variant_id,
            "label": label,
            "include_prefixes": include,
            "checks": safe_checks,
        }
        if size_gb is not None:
            option["size_gb"] = size_gb
        if vram_gb is not None:
            option["vram_gb"] = vram_gb
        options.append(option)

    for index, option in enumerate(options):
        for other in options[index + 1:]:
            if _prefixes_overlap(option["include_prefixes"], other["include_prefixes"]):
                raise ValueError(
                    f'weight variants "{option["id"]}" and "{other["id"]}" share files'
                )
    download_check = node.get("download_check")
    if isinstance(download_check, str) and any(
        _prefixes_overlap([download_check], option["include_prefixes"]) for option in options
    ):
        raise ValueError("download_check must name a file outside every weight variant")
    default = raw.get("default", options[0]["id"])
    if not any(option["id"] == default for option in options):
        raise ValueError("weight_variants.default must name one of its options")
    _assert_param_offers_variants(
        param,
        node.get("params_schema") if params_schema is None else params_schema,
        [option["id"] for option in options],
    )
    return {"param": param, "default": default, "options": options}


def installed_weight_variants(
    models_dir: Path, model_id: str, variants: dict[str, Any]
) -> list[str]:
    try:
        model_root = resolve_model_root(models_dir, model_id)
    except ValueError:
        return []

    def _present(check: str) -> bool:
        try:
            candidate = resolve_download_path(model_root, check)
            return candidate.is_file() and candidate.stat().st_size > 0
        except (OSError, ValueError):
            return False

    return [
        option["id"]
        for option in variants["options"]
        if all(_present(check) for check in option["checks"])
    ]


def missing_weight_variant(
    models_dir: Path,
    model_id: str,
    variants: dict[str, Any] | None,
    params: dict[str, Any],
) -> dict[str, Any] | None:
    """The variant selected by params when its files are not installed, else None."""
    if not variants:
        return None
    selected = params.get(variants["param"])
    selected_id = variants["default"] if selected is None else str(selected)
    option = next((o for o in variants["options"] if o["id"] == selected_id), None)
    if option is None or option["id"] in installed_weight_variants(models_dir, model_id, variants):
        return None
    return option

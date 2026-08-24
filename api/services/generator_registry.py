"""
GeneratorRegistry — manages the lifecycle of all model adapters.
Dynamically loads extensions from the extensions/ folder.

To add a new model: create a folder in extensions/ with
  - manifest.json  (metadata + hf_repo + pip_requirements...)
  - generator.py   (class extending BaseGenerator)
No other file needs to be modified.
"""
import importlib
import importlib.util
import hmac
import json
import os
import re
import secrets
import stat
import sys
import threading
from contextlib import contextmanager
from functools import wraps
from pathlib import Path
from types import ModuleType
from typing import Dict, Iterator, List, Optional, Set, Tuple

from services.generators.base import BaseGenerator
from services.extension_process import ExtensionProcess, _venv_python

# ------------------------------------------------------------------ #
# Global paths
# ------------------------------------------------------------------ #

_models_dir_raw    = os.environ.get("MODELS_DIR")    or str(Path.home() / ".modly" / "models")
_workspace_dir_raw = os.environ.get("WORKSPACE_DIR") or str(Path.home() / ".modly" / "workspace")
MODELS_DIR    = Path(_models_dir_raw)
WORKSPACE_DIR = Path(_workspace_dir_raw)

MODELS_DIR.mkdir(parents=True, exist_ok=True)
WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)

# extensions/ folder — in userData (passed by Electron via EXTENSIONS_DIR)
_extensions_dir_raw = os.environ.get("EXTENSIONS_DIR", "")
EXTENSIONS_DIR = Path(_extensions_dir_raw) if _extensions_dir_raw else None
_REGISTRATION_PENDING_PREFIX = ".modly-registration-pending-"
_EXTENSION_ID = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
_REGISTRATION_PENDING_NAME = re.compile(
    rf"^{re.escape(_REGISTRATION_PENDING_PREFIX)}"
    r"(?P<extension_id>[a-z0-9][a-z0-9._-]*)-(?P<suffix>\d+)$"
)
_REGISTRATION_CAPABILITY_LOCK = threading.Lock()

# The built-ins are synced to their own folder, next to the user's. They are not
# discovered here (Electron runs process extensions), but their manifests still
# have to be readable: without this, the agent's param validation is skipped for
# every built-in and an invalid value lands in the workflow unchallenged.
_builtin_dir_raw = os.environ.get("BUILTIN_EXTENSIONS_DIR", "")
BUILTIN_EXTENSIONS_DIR = Path(_builtin_dir_raw) if _builtin_dir_raw else None

print(f"[Registry] MODELS_DIR     = {MODELS_DIR}")
print(f"[Registry] WORKSPACE_DIR  = {WORKSPACE_DIR}")
print(f"[Registry] EXTENSIONS_DIR = {EXTENSIONS_DIR or '(not set)'}")
print(f"[Registry] BUILTIN_EXT_DIR = {BUILTIN_EXTENSIONS_DIR or '(not set)'}")


# ------------------------------------------------------------------ #
# Extension loader
# ------------------------------------------------------------------ #

def _path_belongs_to(path: object, root: Path) -> bool:
    if not isinstance(path, (str, os.PathLike)):
        return False
    try:
        Path(path).resolve().relative_to(root)
        return True
    except (OSError, ValueError):
        return False


class _LegacyImportContext:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        self.modules: Dict[str, ModuleType] = {}
        self.local_names: Set[str] = set()
        for child in self.root.iterdir():
            if child.is_file() and child.suffix == ".py" and child.stem != "__init__":
                self.local_names.add(child.stem)
            elif child.is_dir() and (child / "__init__.py").is_file():
                self.local_names.add(child.name)


class _LegacyImportManager:
    """Isolates plain sibling imports used by legacy direct extensions."""

    def __init__(self) -> None:
        self._contexts: Dict[Path, _LegacyImportContext] = {}
        self._lock = threading.RLock()

    def register(self, root: Path) -> _LegacyImportContext:
        resolved = root.resolve()
        context = self._contexts.get(resolved)
        if context is None:
            context = _LegacyImportContext(resolved)
            self._contexts[resolved] = context
        return context

    def _owner(self, module: ModuleType) -> Optional[_LegacyImportContext]:
        module_file = getattr(module, "__file__", None)
        for context in self._contexts.values():
            if _path_belongs_to(module_file, context.root):
                return context
        return None

    def _capture_and_evict_owned_modules(self) -> None:
        for name, module in list(sys.modules.items()):
            if not isinstance(module, ModuleType):
                continue
            owner = self._owner(module)
            if owner is None:
                continue
            owner.modules[name] = module
            sys.modules.pop(name, None)

    @staticmethod
    def _matches_local_name(module_name: str, local_names: Set[str]) -> bool:
        return any(
            module_name == local_name or module_name.startswith(f"{local_name}.")
            for local_name in local_names
        )

    @contextmanager
    def activate(self, context: _LegacyImportContext) -> Iterator[None]:
        # sys.path and sys.modules are process-global. Serializing direct legacy
        # calls prevents concurrent generators from observing each other's
        # same-named sibling modules.
        with self._lock:
            original_path = list(sys.path)
            shadowed: Dict[str, ModuleType] = {}
            self._capture_and_evict_owned_modules()

            for name, module in list(sys.modules.items()):
                if self._matches_local_name(name, context.local_names) and isinstance(module, ModuleType):
                    shadowed[name] = module
                    sys.modules.pop(name, None)

            sys.modules.update(context.modules)
            managed_roots = {str(item.root) for item in self._contexts.values()}
            sys.path[:] = [str(context.root)] + [
                entry for entry in original_path if entry not in managed_roots
            ]
            importlib.invalidate_caches()

            try:
                yield
            finally:
                self._capture_and_evict_owned_modules()
                for name in list(sys.modules):
                    if self._matches_local_name(name, context.local_names):
                        sys.modules.pop(name, None)
                sys.modules.update(shadowed)
                sys.path[:] = original_path
                importlib.invalidate_caches()

    def clear(self) -> None:
        with self._lock:
            self._capture_and_evict_owned_modules()
            for context in self._contexts.values():
                for module in context.modules.values():
                    cached = getattr(module, "__cached__", None)
                    if _path_belongs_to(cached, context.root):
                        try:
                            Path(cached).unlink(missing_ok=True)
                        except OSError:
                            pass
                context.modules.clear()
            self._contexts.clear()
            importlib.invalidate_caches()


class _LegacyGeneratorProxy:
    def __init__(
        self,
        target: BaseGenerator,
        manager: _LegacyImportManager,
        context: _LegacyImportContext,
    ) -> None:
        object.__setattr__(self, "_target", target)
        object.__setattr__(self, "_manager", manager)
        object.__setattr__(self, "_context", context)

    def __getattr__(self, name: str):
        manager = object.__getattribute__(self, "_manager")
        context = object.__getattribute__(self, "_context")
        target = object.__getattribute__(self, "_target")
        with manager.activate(context):
            value = getattr(target, name)
        if not callable(value):
            return value

        @wraps(value)
        def call_in_context(*args, **kwargs):
            with manager.activate(context):
                return value(*args, **kwargs)

        return call_in_context

    def __setattr__(self, name: str, value: object) -> None:
        manager = object.__getattribute__(self, "_manager")
        context = object.__getattribute__(self, "_context")
        target = object.__getattribute__(self, "_target")
        with manager.activate(context):
            setattr(target, name, value)


def _manifest_model_ids(manifest: dict, fallback_id: str) -> List[str]:
    """Returns the registry keys a readable model manifest is expected to add."""
    ext_id = manifest.get("id")
    if not isinstance(ext_id, str) or not ext_id:
        return [fallback_id]

    raw_nodes = manifest.get("nodes", [])
    if not isinstance(raw_nodes, list):
        raw_nodes = []
    nodes = [
        node for node in raw_nodes
        if isinstance(node, dict) and isinstance(node.get("id"), str) and node["id"]
    ]
    return [f"{ext_id}/{node['id']}" for node in nodes] or [ext_id]


def _record_discovery_error(
    errors: Dict[str, str],
    message: str,
    *,
    manifest: Optional[dict] = None,
    fallback_id: str,
) -> None:
    keys = _manifest_model_ids(manifest, fallback_id) if manifest is not None else [fallback_id]
    for key in keys:
        errors[key] = message


def _registration_pending(extension_id: str) -> bool:
    if EXTENSIONS_DIR is None:
        return False
    prefix = f"{_REGISTRATION_PENDING_PREFIX}{extension_id}-"
    try:
        return any(
            child.name.startswith(prefix)
            and child.name[len(prefix):].isdigit()
            for child in EXTENSIONS_DIR.iterdir()
        )
    except OSError:
        return False


RegistrationValidationAuthorization = Tuple[str, Path, Path]


def _consume_registration_validation_capability(
    capability: object,
) -> Optional[RegistrationValidationAuthorization]:
    """Validates and atomically consumes one exact root-sidecar capability."""
    if EXTENSIONS_DIR is None or not isinstance(capability, dict):
        return None

    extension_id = capability.get("extensionId")
    destination_name = capability.get("destinationName")
    state_name = capability.get("stateName")
    token = capability.get("token")
    if not all(isinstance(value, str) and value for value in (
        extension_id,
        destination_name,
        state_name,
        token,
    )):
        return None
    if len(token) < 32:
        return None
    if (
        _EXTENSION_ID.fullmatch(extension_id) is None
        or destination_name != extension_id
    ):
        return None

    name_match = _REGISTRATION_PENDING_NAME.fullmatch(state_name)
    if name_match is None or name_match.group("extension_id") != extension_id:
        return None

    with _REGISTRATION_CAPABILITY_LOCK:
        try:
            root = EXTENSIONS_DIR.resolve()
            state_path = EXTENSIONS_DIR / state_name
            if state_path.parent.resolve() != root:
                return None
            destination_path = Path(os.path.abspath(root / destination_name))
            if destination_path.parent != root:
                return None
            matching_state_names = sorted(
                child.name
                for child in root.iterdir()
                if (
                    (match := _REGISTRATION_PENDING_NAME.fullmatch(child.name))
                    is not None
                    and match.group("extension_id") == extension_id
                )
            )
            if matching_state_names != [state_name]:
                return None
            state_stat = state_path.lstat()
            if (
                stat.S_ISLNK(state_stat.st_mode)
                or not stat.S_ISREG(state_stat.st_mode)
                or state_stat.st_nlink != 1
            ):
                return None
            if (
                os.name != "nt"
                and (
                    stat.S_IMODE(state_stat.st_mode) & 0o077
                    or (
                        hasattr(os, "getuid")
                        and state_stat.st_uid != os.getuid()
                    )
                )
            ):
                return None

            state = json.loads(state_path.read_text(encoding="utf-8"))
            if (
                not isinstance(state, dict)
                or state.get("version") != 1
                or state.get("extensionId") != extension_id
                or state.get("destinationName") != destination_name
                or state.get("consumed") is not False
                or not isinstance(state.get("token"), str)
                or not hmac.compare_digest(state["token"], token)
            ):
                return None

            # Replace the exact sidecar atomically while retaining its pending
            # filename. Normal reloads therefore keep quarantining the
            # extension, while this capability cannot be replayed.
            consumed_state = {
                "version": 1,
                "extensionId": extension_id,
                "destinationName": destination_name,
                "consumed": True,
            }
            temporary_path = root / (
                f".modly-registration-capability-{secrets.token_hex(16)}"
            )
            try:
                flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
                if hasattr(os, "O_NOFOLLOW"):
                    flags |= os.O_NOFOLLOW
                descriptor = os.open(temporary_path, flags, 0o600)
                try:
                    if os.name != "nt":
                        os.fchmod(descriptor, 0o600)
                    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                        descriptor = -1
                        json.dump(consumed_state, stream)
                        stream.flush()
                        os.fsync(stream.fileno())
                finally:
                    if descriptor >= 0:
                        os.close(descriptor)
                os.replace(temporary_path, state_path)
            finally:
                try:
                    temporary_path.unlink()
                except FileNotFoundError:
                    pass
        except (OSError, TypeError, ValueError, json.JSONDecodeError):
            return None

    return extension_id, state_path, destination_path


def _discover_extensions(
    legacy_imports: _LegacyImportManager,
    registration_authorization: Optional[RegistrationValidationAuthorization] = None,
) -> Tuple[
    Dict[str, Tuple[type, dict, Path, Optional[_LegacyImportContext]]],
    Dict[str, str],
]:
    """
    Scans EXTENSIONS_DIR to find valid extensions.
    Each extension must have manifest.json + generator.py.
    Returns ({full_id: (GeneratorClass, node_manifest, ext_dir)}, errors)
    where full_id is "ext_id/node_id".
    """
    result: Dict[str, Tuple[type, dict, Path, Optional[_LegacyImportContext]]] = {}
    errors: Dict[str, str] = {}

    if EXTENSIONS_DIR is None or not EXTENSIONS_DIR.exists():
        print(f"[Registry] WARNING: EXTENSIONS_DIR not set or not found: {EXTENSIONS_DIR}")
        return result, errors

    for ext_dir in sorted(EXTENSIONS_DIR.iterdir()):
        if not ext_dir.is_dir():
            continue
        # Dot-dirs are install machinery (staging/backup), never extensions
        if ext_dir.name.startswith("."):
            continue
        manifest_path  = ext_dir / "manifest.json"
        generator_path = ext_dir / "generator.py"

        if not manifest_path.exists():
            message = f"Extension '{ext_dir.name}' is missing manifest.json."
            print(f"[Registry] ERROR: {message}")
            _record_discovery_error(errors, message, fallback_id=ext_dir.name)
            continue

        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception as exc:
            message = f"Extension '{ext_dir.name}' has an invalid manifest.json: {exc}"
            print(f"[Registry] ERROR: {message}")
            _record_discovery_error(errors, message, fallback_id=ext_dir.name)
            continue
        if not isinstance(manifest, dict):
            message = f"Extension '{ext_dir.name}' has an invalid manifest.json: expected an object."
            print(f"[Registry] ERROR: {message}")
            _record_discovery_error(errors, message, fallback_id=ext_dir.name)
            continue

        try:
            # Process extensions run via Electron's process runner, not this
            # registry — skip them even when their entry file is generator.py.
            if manifest.get("type", "model") != "model":
                print(f"[Registry] Skipping '{ext_dir.name}': type "
                      f"'{manifest.get('type')}' is not handled by this registry")
                continue

            ext_id     = manifest["id"]
            class_name = manifest["generator_class"]

            if ext_id != ext_dir.name:
                message = (
                    f"Extension folder '{ext_dir.name}' declares mismatched "
                    f"manifest id '{ext_id}'. Folder and manifest IDs must match."
                )
                print(f"[Registry] ERROR: {message}")
                _record_discovery_error(
                    errors,
                    message,
                    fallback_id=ext_dir.name,
                )
                continue

            raw_nodes = manifest.get("nodes", [])
            if not isinstance(raw_nodes, list):
                raw_nodes = []
            nodes = [
                node for node in raw_nodes
                if isinstance(node, dict) and node.get("id")
            ]

            # Markers left while setup or runtime registration is unfinished:
            # the folder is not ready to be loaded. The readable manifest lets
            # the UI attach this error to each expected model node even when
            # startup could not immediately restore a locked backup.
            install_interrupted = (
                (ext_dir / ".modly-incomplete").exists()
                or (ext_dir / ".modly-registration-pending").exists()
                or (
                    _registration_pending(ext_id)
                    and not (
                        registration_authorization is not None
                        and registration_authorization[0] == ext_id
                        and registration_authorization[1].exists()
                        and registration_authorization[2]
                        == Path(os.path.abspath(ext_dir))
                    )
                )
            )
            if install_interrupted:
                message = (
                    f"Extension '{ext_id}' has an incomplete installation "
                    "or interrupted runtime registration. "
                    "Restart Modly to recover it, or click 'Repair' on the Models page."
                )
                print(f"[Registry] ERROR: {message}")
                _record_discovery_error(
                    errors,
                    message,
                    manifest=manifest,
                    fallback_id=ext_dir.name,
                )
                continue

            if not generator_path.exists():
                message = f"Extension '{ext_id}' is missing generator.py."
                print(f"[Registry] ERROR: {message}")
                _record_discovery_error(
                    errors,
                    message,
                    manifest=manifest,
                    fallback_id=ext_dir.name,
                )
                continue

            # --- Subprocess mode (new): venv present → use ExtensionProcess ---
            # Also force subprocess mode for extensions that ship a build_vendor.py
            # but whose vendor/ directory hasn't been built yet: this surfaces a
            # loadError in the UI (Repair button) so the user can run setup.py.
            has_venv         = _venv_python(ext_dir).is_file()
            has_setup        = (ext_dir / "setup.py").is_file()
            has_build_vendor = (ext_dir / "build_vendor.py").exists()
            vendor_built     = (ext_dir / "vendor").exists()
            needs_setup      = (has_setup and not has_venv) or (has_build_vendor and not vendor_built)
            subprocess_mode  = has_venv or needs_setup

            cls_or_None = None
            legacy_context = None
            if not subprocess_mode:
                # --- Direct mode (legacy): no venv → load generator.py directly ---
                # Plain sibling imports are exposed only inside the serialized
                # import context. Never leave extension roots on host sys.path.
                legacy_context = legacy_imports.register(ext_dir)
                with legacy_imports.activate(legacy_context):
                    module_name = f"extensions.{ext_id}.generator"
                    spec   = importlib.util.spec_from_file_location(module_name, generator_path)
                    if spec is None or spec.loader is None:
                        raise ImportError(f"Could not create an import spec for {generator_path}")
                    module = importlib.util.module_from_spec(spec)
                    sys.modules[module_name] = module
                    spec.loader.exec_module(module)
                    cls_or_None = getattr(module, class_name)

            if nodes:
                for node in nodes:
                    node_manifest = {
                        **manifest,
                        "id":               f"{ext_id}/{node['id']}",
                        "ext_id":           ext_id,
                        "node_id":          node["id"],
                        "name":             node.get("name", node["id"]),
                        "hf_repo":          node.get("hf_repo", ""),
                        "download_check":   node.get("download_check", ""),
                        "hf_skip_prefixes": node.get("hf_skip_prefixes", []),
                        "hf_include_prefixes": node.get("hf_include_prefixes", []),
                        "params_schema":    node.get("params_schema", manifest.get("params_schema", [])),
                        "input":            node.get("input", "image"),
                        "output":           node.get("output", "mesh"),
                    }
                    full_id = f"{ext_id}/{node['id']}"
                    result[full_id] = (cls_or_None, node_manifest, ext_dir, legacy_context)
                    if subprocess_mode:
                        if has_venv:
                            print(f"[Registry] Loaded subprocess node: {full_id}")
                        else:
                            print(f"[Registry] Node '{full_id}' needs setup (venv missing)")
                    else:
                        print(f"[Registry] Loaded node: {full_id} ({class_name})")
            else:
                # No nodes defined — register by ext_id as fallback
                result[ext_id] = (cls_or_None, manifest, ext_dir, legacy_context)
                if subprocess_mode:
                    if has_venv:
                        print(f"[Registry] Loaded subprocess extension: {ext_id}")
                    else:
                        print(f"[Registry] Extension '{ext_id}' needs setup (venv missing)")
                else:
                    print(f"[Registry] Loaded extension: {ext_id} ({class_name})")

        except Exception as exc:
            message = f"Failed to discover extension '{ext_dir.name}': {exc}"
            print(f"[Registry] ERROR: {message}")
            _record_discovery_error(
                errors,
                message,
                manifest=manifest,
                fallback_id=ext_dir.name,
            )

    return result, errors


# ------------------------------------------------------------------ #
# GeneratorRegistry
# ------------------------------------------------------------------ #

class GeneratorRegistry:
    def __init__(self) -> None:
        self._generators: Dict[str, BaseGenerator] = {}
        self._manifests:  Dict[str, dict]          = {}
        self._errors:     Dict[str, str]           = {}
        self._legacy_imports = _LegacyImportManager()
        self._active_id:  str = os.environ.get("SELECTED_MODEL_ID", "sf3d")

    def initialize(
        self,
        registration_authorization: Optional[RegistrationValidationAuthorization] = None,
    ) -> None:
        """Discovers and instantiates all extensions. Call at startup."""
        extensions, discovery_errors = _discover_extensions(
            self._legacy_imports,
            registration_authorization,
        )
        self._errors.update(discovery_errors)

        for model_id, entry in extensions.items():
            cls, manifest, ext_dir, legacy_context = entry
            try:
                if cls is None:
                    # Subprocess mode: venv must exist
                    if not _venv_python(ext_dir).is_file():
                        raise RuntimeError(
                            "venv not found — extension needs setup. "
                            "Click 'Repair' on the Models page to run setup.py."
                        )
                    # Subprocess mode: wrap in ExtensionProcess
                    gen = ExtensionProcess(ext_dir, manifest)
                    gen.model_dir   = MODELS_DIR / model_id
                    gen.outputs_dir = WORKSPACE_DIR
                else:
                    # Legacy direct mode
                    if legacy_context is None:
                        raise RuntimeError("legacy import context is missing")
                    with self._legacy_imports.activate(legacy_context):
                        direct_gen = cls(MODELS_DIR / model_id, WORKSPACE_DIR)
                    gen = _LegacyGeneratorProxy(
                        direct_gen,
                        self._legacy_imports,
                        legacy_context,
                    )
                    gen.hf_repo          = manifest.get("hf_repo", "")
                    gen.hf_skip_prefixes = manifest.get("hf_skip_prefixes", [])
                    gen.download_check   = manifest.get("download_check", "")
                    gen._params_schema   = manifest.get("params_schema", [])

                self._generators[model_id] = gen
                self._manifests[model_id]  = manifest
                self._errors.pop(model_id, None)
            except Exception as exc:
                msg = f"Failed to instantiate generator '{model_id}': {exc}"
                print(f"[Registry] ERROR: {msg}")
                self._errors[model_id] = msg

        if not self._generators:
            print("[Registry] WARNING: No extensions found.")
            return

        if self._active_id not in self._generators:
            fallback = next(iter(self._generators))
            print(
                f"[Registry] WARNING: SELECTED_MODEL_ID='{self._active_id}' is unknown. "
                f"Falling back to '{fallback}'."
            )
            self._active_id = fallback

        print(f"[Registry] Active model  : {self._active_id}")
        print(f"[Registry] All models    : {list(self._generators.keys())}")

    def reload(self, validation_capability: object = None) -> None:
        """
        Re-scans extensions and updates the registry without restarting FastAPI.
        Unloads all current generators before reloading.
        """
        registration_authorization = _consume_registration_validation_capability(
            validation_capability,
        )
        print("[Registry] Reloading extensions...")
        for gen in self._generators.values():
            if isinstance(gen, ExtensionProcess):
                gen.stop()
                if gen._proc is not None:
                    raise RuntimeError(
                        "Extension subprocess remained attached after stop()"
                    )
            else:
                try:
                    gen.unload()
                except Exception:
                    pass
        self._generators.clear()
        self._manifests.clear()
        self._errors.clear()
        self._remove_legacy_paths()
        self.initialize(registration_authorization)
        print("[Registry] Reload complete.")

    def load_errors(self) -> Dict[str, str]:
        """Returns extension loading errors."""
        return dict(self._errors)

    def _remove_legacy_paths(self) -> None:
        """Clears direct-extension import state owned by this registry."""
        self._legacy_imports.clear()

    # ------------------------------------------------------------------ #
    # Generator access
    # ------------------------------------------------------------------ #

    @staticmethod
    def _assert_not_quarantined(model_id: str) -> None:
        extension_id = model_id.split("/", 1)[0]
        if _registration_pending(extension_id):
            raise ValueError(
                f"Model ID '{model_id}' belongs to an extension with pending "
                "runtime registration. Repair or reload the extension first."
            )

    def get_active(self) -> BaseGenerator:
        """Returns the active generator. Downloads and loads if necessary."""
        self._assert_not_quarantined(self._active_id)
        gen = self._generators[self._active_id]
        if not gen.is_loaded():
            if not gen.is_downloaded():
                if isinstance(gen, ExtensionProcess):
                    # Let the subprocess handle its own download logic during
                    # load() — some extensions (e.g. mv-adapter) need custom
                    # multi-repo downloads that the standard HF endpoint can't do.
                    pass
                else:
                    gen._auto_download()
            gen.load()
        return gen

    def get_generator(self, model_id: str) -> BaseGenerator:
        self._assert_not_quarantined(model_id)
        if model_id not in self._generators:
            raise ValueError(
                f"Unknown model ID: '{model_id}'. "
                f"Available: {list(self._generators.keys())}"
            )
        return self._generators[model_id]

    def get_manifest(self, model_id: str) -> dict:
        """Returns the manifest of an extension."""
        if model_id not in self._manifests:
            raise KeyError(f"No manifest for model ID: '{model_id}'")
        return self._manifests[model_id]

    def switch_model(self, model_id: str) -> None:
        """Switches the active model. Unloads the previous one if different."""
        self._assert_not_quarantined(model_id)
        if model_id not in self._generators:
            raise ValueError(
                f"Unknown model ID: '{model_id}'. "
                f"Available: {list(self._generators.keys())}"
            )
        # 3D generation owns the GPU: evict the chat LLMs before anything is
        # about to allocate on it. The trigger is "the target model is not
        # resident", not "the target model changed" — the common case is the
        # default generator, which is already `_active_id` at boot and still
        # has to load its weights. Gating on the id alone let a full LLM pool
        # (2 slots, ~11.6 GB of 12) sit through an entire generation.
        target = self._generators[model_id]
        if model_id != self._active_id or not target.is_loaded():
            from services.llm_server import llama_pool
            llama_pool.unload_all()

        if model_id != self._active_id:
            if self._active_id in self._generators:
                self._generators[self._active_id].unload()
            self._active_id = model_id

    # ------------------------------------------------------------------ #
    # Status
    # ------------------------------------------------------------------ #

    def active_status(self) -> dict:
        gen      = self._generators[self._active_id]
        manifest = self._manifests[self._active_id]
        return {
            "id":         self._active_id,
            "name":       manifest.get("name", gen.DISPLAY_NAME),
            "downloaded": gen.is_downloaded(),
            "loaded":     gen.is_loaded(),
        }

    def all_status(self) -> list:
        result = []
        for model_id, gen in self._generators.items():
            manifest = self._manifests[model_id]
            result.append({
                "id":          model_id,
                "name":        manifest.get("name", gen.DISPLAY_NAME),
                "description": manifest.get("description", ""),
                "version":     manifest.get("version", ""),
                "vram_gb":     manifest.get("vram_gb", gen.VRAM_GB),
                "hf_repo":     manifest.get("hf_repo", ""),
                "tags":        manifest.get("tags", []),
                "downloaded":  gen.is_downloaded(),
                "loaded":      gen.is_loaded(),
                "active":      model_id == self._active_id,
            })
        return result

    def params_schema(self, model_id: Optional[str] = None) -> list:
        target_id = model_id or self._active_id
        if target_id not in self._generators:
            raise KeyError(target_id)
        return self._generators[target_id].params_schema()

    # ------------------------------------------------------------------ #
    # Paths update & shutdown
    # ------------------------------------------------------------------ #

    def update_paths(self, models_dir: Optional[Path], workspace_dir: Optional[Path]) -> None:
        global MODELS_DIR, WORKSPACE_DIR
        import services.generator_registry as _self_module

        if models_dir is not None:
            self.unload_all()
            models_dir.mkdir(parents=True, exist_ok=True)
            _self_module.MODELS_DIR = models_dir
            for model_id, gen in self._generators.items():
                gen.model_dir = models_dir / model_id

        if workspace_dir is not None:
            workspace_dir.mkdir(parents=True, exist_ok=True)
            _self_module.WORKSPACE_DIR = workspace_dir
            for gen in self._generators.values():
                gen.outputs_dir = workspace_dir

    def unload_all(self) -> None:
        for gen in self._generators.values():
            if isinstance(gen, ExtensionProcess):
                gen.stop()
            else:
                gen.unload()


# Singleton
generator_registry = GeneratorRegistry()

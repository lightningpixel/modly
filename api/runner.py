"""
Modly Extension Runner — generic subprocess entry point.

Runs inside the extension's own venv. Loaded by ExtensionProcess via:
    {venv_python} {runner_path}

Environment variables (set by ExtensionProcess):
    EXTENSION_DIR   — absolute path to the extension directory
    MODELS_DIR      — where model weights are stored
    WORKSPACE_DIR   — where generated files are saved
    MODLY_API_DIR   — path to Modly's api/ dir (so generator.py can import
                      from services.generators.base)

Protocol: newline-delimited JSON on stdin/stdout.
Stderr is captured separately by ExtensionProcess for logging.
"""
import sys
import json
import os
import traceback
import base64
import threading
import importlib.util
from pathlib import Path

# ------------------------------------------------------------------ #
# Env
# ------------------------------------------------------------------ #

EXT_DIR       = Path(os.environ["EXTENSION_DIR"])
MODELS_DIR    = Path(os.environ.get("MODELS_DIR",    Path.home() / ".modly" / "models"))
WORKSPACE_DIR = Path(os.environ.get("WORKSPACE_DIR", Path.home() / ".modly" / "workspace"))
MODLY_API_DIR = os.environ.get("MODLY_API_DIR", "")
# MODEL_DIR is set by ExtensionProcess to match its own model_dir (composite node id path).
# Falls back to MODELS_DIR/manifest_id for standalone/legacy use.
_MODEL_DIR_OVERRIDE = os.environ.get("MODEL_DIR", "")

# Inject Modly's api/ so generator.py can do:
#   from services.generators.base import BaseGenerator, ...
if MODLY_API_DIR and MODLY_API_DIR not in sys.path:
    sys.path.insert(0, MODLY_API_DIR)

# Inject ext dir so generator.py can import local vendor modules
if str(EXT_DIR) not in sys.path:
    sys.path.insert(0, str(EXT_DIR))


# ------------------------------------------------------------------ #
# Protocol helpers
# ------------------------------------------------------------------ #

def send(msg: dict) -> None:
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def recv():
    """Yields parsed JSON messages from stdin, one per line."""
    for raw in sys.stdin:
        raw = raw.strip()
        if raw:
            try:
                yield json.loads(raw)
            except json.JSONDecodeError as exc:
                send({"type": "log", "level": "error",
                      "message": f"Runner: invalid JSON on stdin: {exc}"})


# ------------------------------------------------------------------ #
# Generator loader
# ------------------------------------------------------------------ #

def load_generator(manifest: dict):
    """Dynamically load the generator class from generator.py."""
    spec = importlib.util.spec_from_file_location(
        "generator", EXT_DIR / "generator.py"
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules["generator"] = mod
    spec.loader.exec_module(mod)
    return getattr(mod, manifest["generator_class"])


def _select_node(manifest: dict, model_dir_override: str) -> dict:
    nodes = manifest.get("nodes") or []
    if nodes and model_dir_override:
        node_id = Path(model_dir_override).name
        return next((n for n in nodes if n.get("id") == node_id), nodes[0])
    if nodes:
        return nodes[0]
    return {}


def _resolve_ready_schema(GenClass, node: dict, manifest: dict) -> list:
    try:
        return GenClass.params_schema()
    except Exception:
        return node.get("params_schema") or manifest.get("params_schema", [])


def _apply_manifest_metadata(gen, manifest: dict, node: dict) -> None:
    gen.hf_repo = node.get("hf_repo") or manifest.get("hf_repo", "")
    gen.hf_skip_prefixes = node.get("hf_skip_prefixes") or manifest.get("hf_skip_prefixes", [])
    gen.download_check = node.get("download_check") or manifest.get("download_check", "")
    gen._params_schema = node.get("params_schema") or manifest.get("params_schema", [])


# ------------------------------------------------------------------ #
# Main loop
# ------------------------------------------------------------------ #

def main() -> None:
    manifest = json.loads((EXT_DIR / "manifest.json").read_text(encoding="utf-8"))
    model_id = manifest["id"]

    try:
        GenClass = load_generator(manifest)
    except Exception:
        send({"type": "error", "id": None,
              "message": "Failed to load generator class",
              "traceback": traceback.format_exc()})
        return

    # Support both flat manifest (legacy) and nodes[] format.
    # Use MODEL_DIR to find the correct node for multi-node extensions:
    # MODEL_DIR is set by ExtensionProcess to MODELS_DIR/ext_id/node_id,
    # so its last component matches the node id.
    node = _select_node(manifest, _MODEL_DIR_OVERRIDE)

    # Announce readiness and send params_schema so ExtensionProcess
    # can serve it without needing to query the subprocess later.
    # We try to get it from the generator class (may be a classmethod),
    # falling back to the selected node, then to the top-level manifest.
    send({"type": "ready", "params_schema": _resolve_ready_schema(GenClass, node, manifest)})

    # Use MODEL_DIR env var (set by ExtensionProcess) when available so the
    # generator uses the exact same path that is_downloaded() checks against.
    # Falls back to MODELS_DIR/manifest_id for legacy / standalone use.
    model_dir = Path(_MODEL_DIR_OVERRIDE) if _MODEL_DIR_OVERRIDE else MODELS_DIR / model_id
    gen = GenClass(model_dir, WORKSPACE_DIR)
    _apply_manifest_metadata(gen, manifest, node)

    # Active cancel events keyed by request id
    _cancel: dict[str, threading.Event] = {}

    for msg in recv():
        action = msg.get("action")
        rid    = msg.get("id")

        try:
            # ---- load ------------------------------------------------
            if action == "load":
                gen.load()
                send({"type": "loaded"})

            # ---- generate --------------------------------------------
            elif action == "generate":
                cancel_evt = threading.Event()
                _cancel[rid] = cancel_evt
                image_bytes  = base64.b64decode(msg["image_b64"])
                params       = msg.get("params", {})
                if msg.get("outputs_dir"):
                    gen.outputs_dir = Path(msg["outputs_dir"])
                    gen.outputs_dir.mkdir(parents=True, exist_ok=True)

                def progress_cb(pct: int, step: str = "") -> None:
                    send({"type": "progress", "id": rid, "pct": pct, "step": step})

                try:
                    output_path = gen.generate(image_bytes, params, progress_cb, cancel_evt)
                    send({"type": "done", "id": rid, "output_path": str(output_path)})
                except Exception as exc:
                    # Detect GenerationCancelled by name to avoid import issues
                    if type(exc).__name__ == "GenerationCancelled":
                        send({"type": "cancelled", "id": rid})
                    else:
                        send({"type": "error", "id": rid,
                              "message": str(exc),
                              "traceback": traceback.format_exc()})
                finally:
                    _cancel.pop(rid, None)

            # ---- cancel ----------------------------------------------
            elif action == "cancel":
                evt = _cancel.get(rid)
                if evt:
                    evt.set()

            # ---- unload ----------------------------------------------
            elif action == "unload":
                gen.unload()
                send({"type": "unloaded"})

            # ---- shutdown --------------------------------------------
            elif action == "shutdown":
                gen.unload()
                break

        except Exception:
            send({"type": "error", "id": rid,
                  "message": "Unexpected runner error",
                  "traceback": traceback.format_exc()})


if __name__ == "__main__":
    main()

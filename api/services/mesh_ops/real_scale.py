"""Real-world scale: whether a GLB's numbers really are metres.

glTF's unit is the metre, but generators emit meshes at an arbitrary size, so
a GLB's numbers only mean metres once someone has said how big the object is
(set_real_scale, normalize_scale, the prepare_for_* presets). That declaration
is stored in the file itself, in the default scene's extras:

    scenes[scene].extras.modly.real_scale = {"unit": "m"}

so it travels with the asset (library, export, re-import) and the viewer reads
it from the loaded scene's userData. Ops that rebuild the mesh drop the extras;
the registry carries the marker over to their output (see carry_real_scale).
"""

import json
import struct
from pathlib import Path
from typing import Any, Mapping, Optional

from .glb_patch import GlbPatchError, _build_glb, _parse_glb


EXTRAS_KEY = "modly"
REAL_SCALE_KEY = "real_scale"
CALIBRATED = {"unit": "m"}
# STL carries no unit and every slicer reads it as millimetres.
MM_PER_M = 1000.0

_GLB_MAGIC = 0x46546C67      # "glTF"
_CHUNK_JSON = 0x4E4F534A     # "JSON"


def _default_scene(gltf: dict) -> Optional[dict]:
    scenes = gltf.get("scenes")
    if not isinstance(scenes, list) or not scenes:
        return None
    index = gltf.get("scene", 0)
    if not isinstance(index, int) or not 0 <= index < len(scenes):
        return None
    scene = scenes[index]
    return scene if isinstance(scene, dict) else None


def _read_gltf_json(path: Path) -> Optional[dict]:
    """The JSON chunk of a GLB, reading only the header and that chunk."""
    with open(path, "rb") as handle:
        header = handle.read(20)
        if len(header) < 20:
            return None
        magic, version, _length, json_length, chunk_type = struct.unpack("<IIIII", header)
        if magic != _GLB_MAGIC or version != 2 or chunk_type != _CHUNK_JSON:
            return None
        chunk = handle.read(json_length)
    if len(chunk) != json_length:
        return None
    gltf = json.loads(chunk.decode("utf-8"))
    return gltf if isinstance(gltf, dict) else None


def read_real_scale(path: Path) -> Optional[dict[str, Any]]:
    """The asset's real-scale declaration, or None when it is not calibrated."""
    path = Path(path)
    if path.suffix.lower() != ".glb" or not path.is_file():
        return None
    try:
        gltf = _read_gltf_json(path)
    except (OSError, UnicodeDecodeError, ValueError):
        return None
    scene = _default_scene(gltf) if gltf else None
    extras = scene.get("extras") if scene else None
    modly = extras.get(EXTRAS_KEY) if isinstance(extras, dict) else None
    declaration = modly.get(REAL_SCALE_KEY) if isinstance(modly, dict) else None
    if isinstance(declaration, dict) and declaration.get("unit") == "m":
        return dict(declaration)
    return None


def is_calibrated(path: Path) -> bool:
    return read_real_scale(path) is not None


def write_real_scale(path: Path, declaration: Mapping[str, Any] = CALIBRATED) -> None:
    """Stamp the declaration into a GLB in place, leaving everything else intact."""
    path = Path(path)
    gltf, binary = _parse_glb(path.read_bytes())
    scene = _default_scene(gltf)
    if scene is None:
        raise GlbPatchError("GLB has no default scene to hold the real-scale declaration")
    extras = scene.get("extras")
    if not isinstance(extras, dict):
        extras = scene["extras"] = {}
    modly = extras.get(EXTRAS_KEY)
    if not isinstance(modly, dict):
        modly = extras[EXTRAS_KEY] = {}
    modly[REAL_SCALE_KEY] = dict(declaration)
    path.write_bytes(_build_glb(gltf, binary or b""))


def carry_real_scale(input_path: Path, output_path: Optional[Path]) -> None:
    """Keep a calibrated input's declaration on an op's output GLB.

    Every op keeps the coordinates in metres, so a calibrated input yields a
    calibrated output, even when the op rebuilt the file and lost its extras.
    """
    if output_path is None or Path(output_path).suffix.lower() != ".glb":
        return
    # The input first: most meshes are not calibrated, and then the output
    # is never read.
    declaration = read_real_scale(input_path)
    if declaration is None or is_calibrated(output_path):
        return
    try:
        write_real_scale(output_path, declaration)
    except (GlbPatchError, OSError):
        pass


# Formats with no unit of their own: by convention they hold millimetres
# (slicers, CAD), the same convention imports read them with.
MM_FORMATS = {"stl", "obj", "ply"}


def export_scale(path: Path, fmt: str) -> float:
    """Factor from the GLB's units to an export format's units.

    A calibrated asset is written in millimetres to STL, OBJ and PLY, like the
    slicer hand-off; GLB keeps metres, and an uncalibrated asset its own units.
    """
    return MM_PER_M if fmt.lower() in MM_FORMATS and is_calibrated(path) else 1.0

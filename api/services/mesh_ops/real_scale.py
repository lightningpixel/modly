"""Real-world scale: declare how big an asset really is, and remember it.

glTF's unit is the metre, but generators emit meshes at an arbitrary size, so
a GLB's numbers only mean metres once someone has said how big the object is.
That declaration is stored in the file itself, in the default scene's extras:

    scenes[scene].extras.modly.real_scale = {"unit": "m"}

so it travels with the asset (library, export, re-import) and the viewer reads
it from the loaded scene's userData. Ops that rebuild the mesh drop the extras;
the registry carries the marker over to their output (see carry_real_scale).
"""

from pathlib import Path
from typing import Any, Mapping, Optional

from .glb_patch import GlbPatchError, _build_glb, _parse_glb
from .operations import _output_path
from .presets import DIMENSION_NAMES
from .transforms import apply_transforms
from .types import MeshOpContext, MeshOpResult


EXTRAS_KEY = "modly"
REAL_SCALE_KEY = "real_scale"
CALIBRATED = {"unit": "m"}
# STL carries no unit and every slicer reads it as millimetres.
MM_PER_M = 1000.0


def _default_scene(gltf: dict) -> Optional[dict]:
    scenes = gltf.get("scenes")
    if not isinstance(scenes, list) or not scenes:
        return None
    index = gltf.get("scene", 0)
    if not isinstance(index, int) or not 0 <= index < len(scenes):
        return None
    scene = scenes[index]
    return scene if isinstance(scene, dict) else None


def read_real_scale(path: Path) -> Optional[dict[str, Any]]:
    """The asset's real-scale declaration, or None when it is not calibrated."""
    path = Path(path)
    if path.suffix.lower() != ".glb" or not path.is_file():
        return None
    try:
        gltf, _ = _parse_glb(path.read_bytes())
    except (GlbPatchError, OSError):
        return None
    scene = _default_scene(gltf)
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
    declaration = read_real_scale(input_path)
    if declaration is None or is_calibrated(output_path):
        return
    try:
        write_real_scale(output_path, declaration)
    except (GlbPatchError, OSError):
        pass


def export_scale(path: Path, fmt: str) -> float:
    """Factor from the GLB's units to an export format's units.

    A calibrated asset's STL is written in millimetres; everything else keeps
    the file's own units (metres for a calibrated GLB, arbitrary otherwise).
    """
    return MM_PER_M if fmt.lower() == "stl" and is_calibrated(path) else 1.0


def set_real_scale(
    input_path: Path,
    params: Mapping[str, Any],
    context: MeshOpContext,
) -> MeshOpResult:
    """"This object is 30 cm": rescale the mesh to that size and mark it calibrated."""
    output_path = _output_path(context, "set-real-scale")
    # normalize_scale already turns "size in a unit along a dimension" into
    # metres; the declaration is what makes the result trustworthy downstream.
    result = apply_transforms(input_path, [("normalize_scale", params)], output_path, context)
    write_real_scale(output_path)
    dimensions = [float(value) for value in result.details["dimensions"]]
    side = DIMENSION_NAMES[params["dimension"]]
    summary = f"Declared the {side} as {params['size']:g} {params['unit']}: the mesh is now at real size."
    return MeshOpResult(
        file_path=output_path,
        details={
            "steps": [{"op": "set_real_scale", **params, "summary": summary}],
            "real_scale": dict(CALIBRATED),
            "dimensions": dimensions,
            "dimensions_mm": [value * MM_PER_M for value in dimensions],
        },
    )

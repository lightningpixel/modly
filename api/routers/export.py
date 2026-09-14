import base64
import binascii
import io
import math

import trimesh
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response, FileResponse

from services.generator_registry import WORKSPACE_DIR

router = APIRouter(tags=["export"])

SUPPORTED = {"glb", "stl", "obj", "ply"}

# Formats OrcaSlicer's importer accepts (see the orcaslicer://open contract).
# GLB is deliberately excluded — OrcaSlicer cannot import glTF/GLB, so a .glb
# deeplink downloads but silently fails to slice.
SLICER_FORMATS = {"stl", "obj"}
SLICER_MEDIA_TYPES = {"stl": "model/stl", "obj": "text/plain"}

# Image-to-3D output has no inherent physical scale (a single photo carries no
# real-world size), and AI generators emit roughly unit-sized meshes — which
# import into a slicer as an invisible ~1 mm speck. Normalise the longest
# bounding-box edge to a sane, obviously-printable default; the user rescales
# in OrcaSlicer as needed.
DEFAULT_PRINT_LONGEST_MM = 50.0


def _to_single_mesh(loaded: object) -> "trimesh.Trimesh":
    """Flatten a loaded GLB into one Trimesh, baking scene-graph node transforms.

    ``trimesh.util.concatenate(scene.geometry.values())`` would DROP the node
    transforms and misassemble a multi-node scene, so flatten at the scene level
    where the graph transforms are applied.
    """
    if isinstance(loaded, trimesh.Trimesh):
        return loaded
    if isinstance(loaded, trimesh.Scene):
        if len(loaded.geometry) == 0:
            raise HTTPException(422, "Mesh contains no geometry")
        # Bake the scene-graph node transforms into a single mesh. The spelling
        # varies across trimesh versions — to_mesh()/to_geometry() are the modern
        # APIs (4.6+); dump(concatenate=True) is the pre-removal fallback for 4.5.
        for flatten in (lambda s: s.to_mesh(), lambda s: s.to_geometry(), lambda s: s.dump(concatenate=True)):
            try:
                result = flatten(loaded)
            except (AttributeError, TypeError):
                continue
            if isinstance(result, trimesh.Trimesh):
                return result
            if isinstance(result, (list, tuple)) and result:
                return trimesh.util.concatenate(result)
        # Fallback: concatenate the geometry as-is (may ignore node transforms).
        return trimesh.util.concatenate(list(loaded.geometry.values()))
    raise HTTPException(422, "Unsupported mesh contents")


def _scale_to_print_size(mesh: "trimesh.Trimesh", longest_mm: float = DEFAULT_PRINT_LONGEST_MM) -> None:
    """Uniformly scale ``mesh`` in place so its longest bbox edge is ``longest_mm``."""
    extents = mesh.extents
    longest = float(max(extents)) if extents is not None and len(extents) else 0.0
    if longest > 1e-9 and math.isfinite(longest):
        mesh.apply_scale(longest_mm / longest)


@router.get("/slicer/{fmt}/{token}/{filename}")
def export_for_slicer(fmt: str, token: str, filename: str):
    """Serve a generated GLB converted to a slicer-importable mesh, at a URL
    shaped for OrcaSlicer's ``orcaslicer://open?file=<url>`` deeplink.

    The URL is intentionally path-only and ends in the real filename+extension
    (e.g. ``/export/slicer/stl/<b64url-workspace-path>/model.stl``). OrcaSlicer
    downloads the URL and derives the import filename — and therefore the mesh
    format — from the URL's FINAL path segment, so a query string (``?path=...``)
    would corrupt the parsed extension and the model would silently fail to
    import. ``token`` is the url-safe-base64 of the workspace-relative source
    path; ``filename`` (e.g. ``model.stl``) is what OrcaSlicer names the download.
    """
    fmt = fmt.lower()
    if fmt not in SLICER_FORMATS:
        raise HTTPException(400, f"Unsupported slicer format: {fmt}. Supported: {', '.join(sorted(SLICER_FORMATS))}")
    if not filename.lower().endswith(f".{fmt}"):
        raise HTTPException(400, "Filename must end with the requested format extension")

    try:
        padded = token + "=" * (-len(token) % 4)
        rel_path = base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError, ValueError):
        raise HTTPException(400, "Malformed source token")

    # Containment check via ancestry, not string prefix: `startswith` would let a
    # sibling like `<workspace>-other/...` slip through, and `..` escapes resolve
    # outside the workspace and fail this check.
    workspace = WORKSPACE_DIR.resolve()
    full_path = (workspace / rel_path).resolve()
    if full_path != workspace and workspace not in full_path.parents:
        raise HTTPException(400, "Invalid path")
    if not full_path.is_file():
        raise HTTPException(404, f"File not found: {rel_path}")

    mesh = _to_single_mesh(trimesh.load(str(full_path)))
    # glTF/GLB is Y-up; OrcaSlicer's world is Z-up. Rotate +90° about X so the
    # model imports standing upright instead of on its side. (Modly's own viewer
    # rests generated meshes on the Y=0 plane, confirming Y is the up axis.)
    mesh.apply_transform(trimesh.transformations.rotation_matrix(math.pi / 2, [1, 0, 0]))
    _scale_to_print_size(mesh)

    data = mesh.export(file_type=fmt)
    if isinstance(data, str):
        data = data.encode("utf-8")
    return Response(
        content=data,
        media_type=SLICER_MEDIA_TYPES.get(fmt, "application/octet-stream"),
        # Fixed name (not the client-supplied segment) — keeps arbitrary input out
        # of the response header. OrcaSlicer names the file from the URL anyway.
        headers={"Content-Disposition": f'attachment; filename="model.{fmt}"'},
    )


@router.get("/{fmt}")
def export_mesh(fmt: str, path: str):
    if fmt not in SUPPORTED:
        raise HTTPException(400, f"Unsupported format: {fmt}. Supported: {', '.join(SUPPORTED)}")

    full_path = (WORKSPACE_DIR / path).resolve()
    if not str(full_path).startswith(str(WORKSPACE_DIR.resolve())):
        raise HTTPException(400, "Invalid path")
    if not full_path.exists():
        raise HTTPException(404, f"File not found: {path}")

    # GLB — serve directly, no conversion needed
    if fmt == "glb":
        return FileResponse(str(full_path), media_type="model/gltf-binary")

    # Load and flatten scene to a single mesh
    loaded = trimesh.load(str(full_path))
    if isinstance(loaded, trimesh.Scene):
        geoms = list(loaded.geometry.values())
        mesh = trimesh.util.concatenate(geoms) if len(geoms) > 1 else geoms[0]
    else:
        mesh = loaded

    buf = io.BytesIO()
    if fmt == "stl":
        mesh.export(buf, file_type="stl")
        media_type = "model/stl"
    elif fmt == "ply":
        mesh.export(buf, file_type="ply")
        media_type = "application/octet-stream"
    else:  # obj
        mesh.export(buf, file_type="obj")
        media_type = "text/plain"

    buf.seek(0)
    return Response(content=buf.read(), media_type=media_type)

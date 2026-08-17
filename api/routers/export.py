import io

import trimesh
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response, FileResponse

from services.generator_registry import WORKSPACE_DIR
from services.local_paths import resolve_workspace_file

router = APIRouter(tags=["export"])

SUPPORTED = {"glb", "stl", "obj", "ply"}


@router.get("/{fmt}")
def export_mesh(fmt: str, path: str):
    if fmt not in SUPPORTED:
        raise HTTPException(400, f"Unsupported format: {fmt}. Supported: {', '.join(SUPPORTED)}")

    try:
        full_path = resolve_workspace_file(WORKSPACE_DIR, path)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
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

import os
import re
import shutil
import tempfile
import uuid

try:
    import pymeshlab as _pymeshlab
    _PYMESHLAB_AVAILABLE = True
except ImportError:
    _pymeshlab = None
    _PYMESHLAB_AVAILABLE = False

import trimesh
import trimesh.visual
from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import FileResponse, Response
from pathlib import Path
from urllib.parse import quote
from pydantic import BaseModel

from services.generator_registry import WORKSPACE_DIR

router = APIRouter(tags=["optimize"])


class OptimizeRequest(BaseModel):
    path: str        # format: "{collection}/{filename}"
    target_faces: int


class SmoothRequest(BaseModel):
    path: str        # format: "{collection}/{filename}"
    iterations: int


def _require_pymeshlab():
    if not _PYMESHLAB_AVAILABLE:
        raise HTTPException(503, "pymeshlab is unavailable on this system (DLL blocked by Windows Application Control policy)")


@router.post("/mesh")
def optimize_mesh(body: OptimizeRequest):
    _require_pymeshlab()
    target_faces = max(100, min(500_000, body.target_faces))

    # Security: prevent path traversal
    input_path = (WORKSPACE_DIR / body.path).resolve()
    if not str(input_path).startswith(str(WORKSPACE_DIR.resolve())):
        raise HTTPException(400, "Invalid path")
    if not input_path.exists():
        raise HTTPException(404, f"File not found: {body.path}")

    tmp_dir = tempfile.mkdtemp()
    try:
        result = _decimate(str(input_path), target_faces, tmp_dir)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    stem = input_path.stem
    output_name = f"{stem}_opt{target_faces}.glb"
    output_path = input_path.parent / output_name
    result.export(str(output_path))

    # Reconstruct the collection name from the path
    collection_name = body.path.split("/")[0]
    face_count = len(result.faces)
    return {"url": f"/workspace/{collection_name}/{output_name}", "face_count": face_count}


def _has_texture(geom: trimesh.Trimesh) -> bool:
    return (
        isinstance(geom.visual, trimesh.visual.TextureVisuals)
        and geom.visual.material is not None
        and getattr(geom.visual.material, "image", None) is not None
    )


def _decimate(input_path: str, target_faces: int, tmp_dir: str) -> trimesh.Trimesh:
    loaded = trimesh.load(input_path)
    if isinstance(loaded, trimesh.Scene):
        geoms = list(loaded.geometry.values())
        geom = trimesh.util.concatenate(geoms) if len(geoms) > 1 else geoms[0]
    else:
        geom = loaded

    ms = _pymeshlab.MeshSet()

    if _has_texture(geom):
        # ── Textured path: OBJ intermediate to preserve UV coordinates ──────
        obj_in  = os.path.join(tmp_dir, "input.obj")
        mtl_in  = os.path.join(tmp_dir, "input.mtl")
        tex_in  = os.path.join(tmp_dir, "texture.png")
        obj_out = os.path.join(tmp_dir, "output.obj")

        # Save texture image under a known filename
        geom.visual.material.image.save(tex_in)

        # Export OBJ (trimesh writes UV coords + MTL)
        geom.export(obj_in)

        # Patch MTL so any map_Kd points to our known texture filename
        if os.path.exists(mtl_in):
            mtl = open(mtl_in).read()
            mtl = re.sub(r"map_Kd\s+\S+", "map_Kd texture.png", mtl)
            open(mtl_in, "w").write(mtl)

        ms.load_new_mesh(obj_in)
        ms.meshing_decimation_quadric_edge_collapse(
            targetfacenum=target_faces,
            preservetexcoord=True,   # ← keeps UV coordinates intact
            preservenormal=True,
            preservetopology=True,
            autoclean=True,
        )
        ms.save_current_mesh(obj_out)

        # Patch output MTL too, so trimesh can find the texture on load
        mtl_out = obj_out.replace(".obj", ".mtl")
        if os.path.exists(mtl_out):
            mtl = open(mtl_out).read()
            mtl = re.sub(r"map_Kd\s+\S+", "map_Kd texture.png", mtl)
            open(mtl_out, "w").write(mtl)

        return trimesh.load(obj_out)

    else:
        # ── Geometry-only path: PLY (fast, no texture to worry about) ────────
        ply_in  = os.path.join(tmp_dir, "input.ply")
        ply_out = os.path.join(tmp_dir, "output.ply")

        geom.export(ply_in)
        ms.load_new_mesh(ply_in)
        ms.meshing_decimation_quadric_edge_collapse(
            targetfacenum=target_faces,
            preservenormal=True,
            preservetopology=True,
            autoclean=True,
        )
        ms.save_current_mesh(ply_out)
        return trimesh.load(ply_out, force="mesh")


@router.post("/smooth")
def smooth_mesh(body: SmoothRequest):
    _require_pymeshlab()
    iterations = max(1, min(20, body.iterations))

    input_path = (WORKSPACE_DIR / body.path).resolve()
    if not str(input_path).startswith(str(WORKSPACE_DIR.resolve())):
        raise HTTPException(400, "Invalid path")
    if not input_path.exists():
        raise HTTPException(404, f"File not found: {body.path}")

    tmp_dir = tempfile.mkdtemp()
    try:
        result = _smooth(str(input_path), iterations, tmp_dir)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    stem = input_path.stem
    output_name = f"{stem}_smooth{iterations}.glb"
    output_path = input_path.parent / output_name
    result.export(str(output_path))

    collection_name = body.path.split("/")[0]
    return {"url": f"/workspace/{collection_name}/{output_name}"}


def _smooth(input_path: str, iterations: int, tmp_dir: str) -> trimesh.Trimesh:
    loaded = trimesh.load(input_path)
    if isinstance(loaded, trimesh.Scene):
        geoms = list(loaded.geometry.values())
        geom = trimesh.util.concatenate(geoms) if len(geoms) > 1 else geoms[0]
    else:
        geom = loaded

    ms = _pymeshlab.MeshSet()

    if _has_texture(geom):
        obj_in  = os.path.join(tmp_dir, "input.obj")
        mtl_in  = os.path.join(tmp_dir, "input.mtl")
        tex_in  = os.path.join(tmp_dir, "texture.png")
        obj_out = os.path.join(tmp_dir, "output.obj")

        geom.visual.material.image.save(tex_in)
        geom.export(obj_in)

        if os.path.exists(mtl_in):
            mtl = open(mtl_in).read()
            mtl = re.sub(r"map_Kd\s+\S+", "map_Kd texture.png", mtl)
            open(mtl_in, "w").write(mtl)

        ms.load_new_mesh(obj_in)
        ms.apply_coord_laplacian_smoothing(stepsmoothnum=iterations)
        ms.save_current_mesh(obj_out)

        mtl_out = obj_out.replace(".obj", ".mtl")
        if os.path.exists(mtl_out):
            mtl = open(mtl_out).read()
            mtl = re.sub(r"map_Kd\s+\S+", "map_Kd texture.png", mtl)
            open(mtl_out, "w").write(mtl)

        return trimesh.load(obj_out)

    else:
        ply_in  = os.path.join(tmp_dir, "input.ply")
        ply_out = os.path.join(tmp_dir, "output.ply")

        geom.export(ply_in)
        ms.load_new_mesh(ply_in)
        ms.apply_coord_laplacian_smoothing(stepsmoothnum=iterations)
        ms.save_current_mesh(ply_out)
        return trimesh.load(ply_out, force="mesh")


class ImportByPathRequest(BaseModel):
    path: str   # absolute path on disk


@router.post("/import-by-path")
async def import_mesh_by_path(body: ImportByPathRequest):
    file_path = Path(body.path)
    if not file_path.is_file():
        raise HTTPException(400, "File not found")

    ext = file_path.suffix.lstrip(".").lower()
    if ext not in ("glb", "obj", "stl", "ply"):
        raise HTTPException(400, f"Unsupported format: {ext}")

    if ext == "glb":
        # Serve the original file directly — no copy
        return {"url": f"/optimize/serve-file?path={quote(str(file_path))}"}

    # Non-GLB: convert to GLB in a temp directory (not the workspace)
    tmp_dir = tempfile.mkdtemp(prefix="modly_import_")
    output_path = os.path.join(tmp_dir, "mesh.glb")
    loaded = trimesh.load(str(file_path))
    loaded.export(output_path)
    return {"url": f"/optimize/serve-file?path={quote(output_path)}"}


@router.get("/serve-file")
def serve_file(path: str):
    file_path = Path(path)
    if not file_path.is_file():
        raise HTTPException(404, "File not found")
    if file_path.suffix.lower() != ".glb":
        raise HTTPException(400, "Only GLB files can be served")
    return FileResponse(str(file_path), media_type="model/gltf-binary")


@router.get("/export")
def export_mesh(path: str, format: str):
    if format not in ("obj", "stl", "ply"):
        raise HTTPException(400, "Supported formats: obj, stl, ply")

    input_path = (WORKSPACE_DIR / path).resolve()
    if not str(input_path).startswith(str(WORKSPACE_DIR.resolve())):
        raise HTTPException(400, "Invalid path")
    if not input_path.exists():
        raise HTTPException(404, f"File not found: {path}")

    loaded = trimesh.load(str(input_path))
    if isinstance(loaded, trimesh.Scene):
        geoms = list(loaded.geometry.values())
        mesh = trimesh.util.concatenate(geoms) if len(geoms) > 1 else geoms[0]
    else:
        mesh = loaded

    data = mesh.export(file_type=format)
    stem = input_path.stem
    mime = "text/plain" if format == "obj" else "application/octet-stream"
    # trimesh exports ply as bytes even in text mode — octet-stream is fine for all binary formats
    return Response(
        content=data,
        media_type=mime,
        headers={"Content-Disposition": f'attachment; filename="{stem}.{format}"'},
    )

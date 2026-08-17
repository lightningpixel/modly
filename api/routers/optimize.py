import hashlib
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

import numpy as np
import trimesh
import trimesh.visual
from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import FileResponse, Response
from pathlib import Path
from urllib.parse import quote
from pydantic import BaseModel

from services.generator_registry import WORKSPACE_DIR
from services.local_paths import resolve_readable_mesh_path, resolve_workspace_file

router = APIRouter(tags=["optimize"])


class OptimizeRequest(BaseModel):
    path: str        # format: "{collection}/{filename}"
    target_faces: int


class SmoothRequest(BaseModel):
    path: str        # format: "{collection}/{filename}"
    iterations: int


class TransformRequest(BaseModel):
    path: str                    # format: "{collection}/{filename}"
    matrix: list[list[float]]    # row-major 4x4 world transform


def _require_pymeshlab():
    if not _PYMESHLAB_AVAILABLE:
        raise HTTPException(503, "pymeshlab is unavailable on this system (DLL blocked by Windows Application Control policy)")


def _resolve_input_path(raw_path: str) -> Path:
    try:
        resolved = resolve_readable_mesh_path(WORKSPACE_DIR, raw_path)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not resolved.exists():
        raise HTTPException(404, f"File not found: {raw_path}")
    return resolved


@router.post("/mesh")
def optimize_mesh(body: OptimizeRequest):
    _require_pymeshlab()
    target_faces = max(100, min(500_000, body.target_faces))

    input_path = _resolve_input_path(body.path)

    tmp_dir = tempfile.mkdtemp()
    try:
        result = _decimate(str(input_path), target_faces, tmp_dir)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    stem = input_path.stem
    output_name = f"{stem}_opt{target_faces}.glb"
    output_dir = input_path.parent if str(input_path).startswith(str(WORKSPACE_DIR.resolve())) else WORKSPACE_DIR / "Workflows"
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / output_name
    result.export(str(output_path))

    face_count = len(result.faces)
    rel = output_path.relative_to(WORKSPACE_DIR).as_posix()
    return {"url": f"/workspace/{rel}", "face_count": face_count}


def _has_texture(geom: trimesh.Trimesh) -> bool:
    if not isinstance(geom.visual, trimesh.visual.TextureVisuals):
        return False
    mat = geom.visual.material
    if mat is None:
        return False
    # Simple material (SimpleMaterial / Material)
    if getattr(mat, "image", None) is not None:
        return True
    # PBR material (from Trellis2 SLaT texturing and GLB imports)
    if getattr(mat, "baseColorTexture", None) is not None:
        return True
    return False


def _get_texture_image(geom: trimesh.Trimesh):
    """Return the base color texture image regardless of material type."""
    mat = geom.visual.material
    img = getattr(mat, "image", None)
    if img is not None:
        return img
    return getattr(mat, "baseColorTexture", None)


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

        # Save texture image under a known filename (handles PBR and simple materials)
        _get_texture_image(geom).save(tex_in)

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

    input_path = _resolve_input_path(body.path)

    tmp_dir = tempfile.mkdtemp()
    try:
        result = _smooth(str(input_path), iterations, tmp_dir)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    stem = input_path.stem
    output_name = f"{stem}_smooth{iterations}.glb"
    output_dir = input_path.parent if str(input_path).startswith(str(WORKSPACE_DIR.resolve())) else WORKSPACE_DIR / "Workflows"
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / output_name
    result.export(str(output_path))

    rel = output_path.relative_to(WORKSPACE_DIR).as_posix()
    return {"url": f"/workspace/{rel}"}


@router.post("/transform")
def transform_mesh(body: TransformRequest):
    # Bake an interactive-gizmo transform into the GLB at scene level so it
    # persists to export. Pure trimesh — no pymeshlab needed.
    input_path = _resolve_input_path(body.path)

    matrix = np.asarray(body.matrix, dtype=float)
    if matrix.shape != (4, 4):
        raise HTTPException(400, "matrix must be a 4x4 array")
    if not np.all(np.isfinite(matrix)):
        raise HTTPException(400, "matrix contains non-finite values")

    # Keep the loaded result as-is (Scene when textured/multi-geometry) so
    # apply_transform preserves materials and UVs.
    loaded = trimesh.load(str(input_path))
    loaded.apply_transform(matrix)

    stem = input_path.stem
    output_name = f"{stem}_xf_{uuid.uuid4().hex[:8]}.glb"
    output_dir = input_path.parent if str(input_path).startswith(str(WORKSPACE_DIR.resolve())) else WORKSPACE_DIR / "Workflows"
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / output_name
    loaded.export(str(output_path))

    rel = output_path.relative_to(WORKSPACE_DIR).as_posix()
    return {"url": f"/workspace/{rel}"}


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

        _get_texture_image(geom).save(tex_in)
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


# ---------------------------------------------------------------------------
# Gaussian Splatting support
#
# A 3DGS .ply is a point cloud whose colour lives in SH coefficients
# (f_dc_*), not in a texture or vertex colours — trimesh strips all of it and
# yields a blank blob. Detect those files by their header and convert them to
# the standard binary .splat format (rowLength = 32) read by the splat viewer:
#   pos   3 × float32  (offset  0)
#   scale 3 × float32  (offset 12)  = exp(scale_i)
#   rgba  4 × uint8    (offset 24)  = 0.5 + C0·f_dc, sigmoid(opacity)
#   rot   4 × uint8    (offset 28)  = normalised quaternion (w,x,y,z)
# ---------------------------------------------------------------------------

_SH_C0 = 0.28209479177387814

# Bump when _convert_gaussian_ply_to_splat changes, to invalidate cached .splats
# whose source .ply mtime is unchanged.
_SPLAT_CONV_VERSION = 2

_PLY_TYPE_MAP = {
    "char": "i1", "uchar": "u1", "int8": "i1", "uint8": "u1",
    "short": "i2", "ushort": "u2", "int16": "i2", "uint16": "u2",
    "int": "i4", "uint": "u4", "int32": "i4", "uint32": "u4",
    "float": "f4", "float32": "f4", "double": "f8", "float64": "f8",
}


def _is_gaussian_ply(file_path: Path) -> bool:
    try:
        with open(file_path, "rb") as f:
            head = f.read(2048)
    except OSError:
        return False
    if not head.startswith(b"ply"):
        return False
    text = head.split(b"end_header")[0].decode("ascii", "ignore")
    return all(marker in text for marker in ("f_dc_0", "scale_0", "rot_0"))


def _convert_gaussian_ply_to_splat(ply_path: Path, out_path: str) -> None:
    import numpy as np

    with open(ply_path, "rb") as f:
        if f.readline().strip() != b"ply":
            raise ValueError("not a ply file")
        fmt = None
        count = 0
        element = None
        props: list[tuple[str, str]] = []
        while True:
            line = f.readline()
            if not line:
                raise ValueError("unexpected EOF in ply header")
            parts = line.split()
            if not parts:
                continue
            kw = parts[0]
            if kw == b"format":
                fmt = parts[1]
            elif kw == b"element":
                element = parts[1]
                if element == b"vertex":
                    count = int(parts[2])
            elif kw == b"property" and element == b"vertex":
                # GS plys use only scalar float properties (no lists)
                props.append((parts[2].decode(), parts[1].decode()))
            elif kw == b"end_header":
                break
        if fmt != b"binary_little_endian":
            raise ValueError(f"unsupported ply format: {fmt!r}")

        dtype = np.dtype([(n, "<" + _PLY_TYPE_MAP[t]) for n, t in props])
        data = np.frombuffer(f.read(count * dtype.itemsize), dtype=dtype, count=count)

    def col(*names):
        return np.stack([data[n].astype(np.float32) for n in names], axis=1)

    xyz = col("x", "y", "z")
    scale = np.exp(col("scale_0", "scale_1", "scale_2"))

    # Normalise into the viewer's space: a 3DGS lives in an arbitrary world
    # frame (offset origin, any scale) and often has a few far-away "floater"
    # splats. Centre x/z on the robust 1–99 percentile box and scale to fit so
    # the model always lands in front of the camera (meshes get this for free
    # via Box3 centring; splats don't). The gaussian sizes scale with it.
    lo = np.percentile(xyz, 1, axis=0)
    hi = np.percentile(xyz, 99, axis=0)
    center = (lo + hi) / 2.0
    extent = float(np.max(hi - lo))
    factor = (2.0 / extent) if extent > 1e-6 else 1.0
    xyz = (xyz - center) * factor
    scale = scale * factor

    # Stand the model on the grid (y = 0), matching the mesh viewer. The client
    # flips the splat 180° about Z (3DGS is Y-down), negating Y so the robust
    # *top* (99th pct) of this space becomes the floor; shift it to 0 → feet on the grid.
    xyz[:, 1] -= float(np.percentile(xyz[:, 1], 99))
    rgb = np.clip((0.5 + _SH_C0 * col("f_dc_0", "f_dc_1", "f_dc_2")) * 255.0, 0, 255)
    alpha = np.clip(1.0 / (1.0 + np.exp(-data["opacity"].astype(np.float32))) * 255.0, 0, 255)
    rot = col("rot_0", "rot_1", "rot_2", "rot_3")
    rot /= np.linalg.norm(rot, axis=1, keepdims=True)
    rot_u8 = np.clip(rot * 128.0 + 128.0, 0, 255)

    out = np.zeros(count, dtype=[
        ("pos", "<f4", 3), ("scale", "<f4", 3), ("rgba", "u1", 4), ("rot", "u1", 4),
    ])
    out["pos"] = xyz
    out["scale"] = scale
    out["rgba"][:, :3] = rgb.astype(np.uint8)
    out["rgba"][:, 3] = alpha.astype(np.uint8)
    out["rot"] = rot_u8.astype(np.uint8)
    with open(out_path, "wb") as f:
        f.write(out.tobytes())


@router.post("/import-by-path")
async def import_mesh_by_path(body: ImportByPathRequest):
    file_path = Path(body.path)
    if not file_path.is_file():
        raise HTTPException(400, "File not found")

    ext = file_path.suffix.lstrip(".").lower()
    if ext not in ("glb", "obj", "stl", "ply", "splat"):
        raise HTTPException(400, f"Unsupported format: {ext}")

    def _imported(src: Path, dest_name: str) -> str:
        tmp_dir = tempfile.mkdtemp(prefix="modly_import_")
        dest = Path(tmp_dir) / dest_name
        shutil.copy2(src, dest)
        return f"/optimize/serve-file?path={quote(str(dest))}"

    # Gaussian Splat: copy into a Modly temp dir so serve-file stays jailed.
    if ext == "splat":
        return {"url": _imported(file_path, "splat.splat")}

    if ext == "ply" and _is_gaussian_ply(file_path):
        tmp_dir = tempfile.mkdtemp(prefix="modly_import_")
        output_path = os.path.join(tmp_dir, "splat.splat")
        try:
            _convert_gaussian_ply_to_splat(file_path, output_path)
        except Exception as err:  # noqa: BLE001 — surface a clean error, never 500-crash
            raise HTTPException(400, f"Unrecognised Gaussian .ply: {err}")
        return {"url": f"/optimize/serve-file?path={quote(output_path)}"}

    if ext == "glb":
        return {"url": _imported(file_path, "mesh.glb")}

    # Mesh ply / obj / stl: convert to GLB in a temp directory (not the workspace)
    tmp_dir = tempfile.mkdtemp(prefix="modly_import_")
    output_path = os.path.join(tmp_dir, "mesh.glb")
    loaded = trimesh.load(str(file_path))
    loaded.export(output_path)
    return {"url": f"/optimize/serve-file?path={quote(output_path)}"}


_SERVE_MEDIA_TYPES = {
    ".glb": "model/gltf-binary",
    ".splat": "application/octet-stream",
}


@router.get("/serve-file")
def serve_file(path: str):
    try:
        file_path = resolve_readable_mesh_path(WORKSPACE_DIR, path)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not file_path.is_file():
        raise HTTPException(404, "File not found")
    media_type = _SERVE_MEDIA_TYPES.get(file_path.suffix.lower())
    if media_type is None:
        raise HTTPException(400, "Only GLB and SPLAT files can be served")
    return FileResponse(str(file_path), media_type=media_type)


@router.get("/ply-to-splat")
def ply_to_splat(path: str):
    """Serve a Gaussian-Splat source as binary .splat for the splat viewer.

    `path` is workspace-relative (e.g. "Workflows/foo.ply"). A .splat is served
    as-is; a GS .ply is normalised + converted (cached by mtime + conv version).
    """
    import services.generator_registry as reg  # dynamic: workspace dir may change at runtime
    workspace = reg.WORKSPACE_DIR
    try:
        src = resolve_workspace_file(workspace, path)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not src.is_file():
        raise HTTPException(404, "File not found")

    if src.suffix.lower() == ".splat":
        return FileResponse(str(src), media_type="application/octet-stream")
    if src.suffix.lower() != ".ply" or not _is_gaussian_ply(src):
        raise HTTPException(400, "Not a Gaussian .ply")

    key = hashlib.md5(f"{src}:{int(src.stat().st_mtime)}:{_SPLAT_CONV_VERSION}".encode()).hexdigest()
    out = Path(tempfile.gettempdir()) / f"modly_splat_{key}.splat"
    if not out.is_file():
        try:
            _convert_gaussian_ply_to_splat(src, str(out))
        except Exception as err:  # noqa: BLE001
            raise HTTPException(400, f"Unrecognised Gaussian .ply: {err}")
    return FileResponse(str(out), media_type="application/octet-stream")


@router.get("/export")
def export_mesh(path: str, format: str):
    if format not in ("obj", "stl", "ply"):
        raise HTTPException(400, "Supported formats: obj, stl, ply")

    try:
        input_path = resolve_workspace_file(WORKSPACE_DIR, path)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
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
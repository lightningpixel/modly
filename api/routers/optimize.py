import hashlib
import os
import tempfile
import uuid

import numpy as np
import trimesh
from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import FileResponse, Response
from pathlib import Path
from urllib.parse import quote
from pydantic import BaseModel, Field

from services.generator_registry import WORKSPACE_DIR
from services.mesh_ops import (
    MeshOpContext,
    MeshOpNotFoundError,
    MeshOpResult,
    MeshOpUnavailableError,
    mesh_ops_registry,
)

router = APIRouter(tags=["optimize"])


class OptimizeRequest(BaseModel):
    path: str        # format: "{collection}/{filename}"
    target_faces: int


class SmoothRequest(BaseModel):
    path: str        # format: "{collection}/{filename}"
    iterations: int


class MeshOpRequest(BaseModel):
    path: str
    params: dict[str, object] = Field(default_factory=dict)


class TransformRequest(BaseModel):
    path: str                    # format: "{collection}/{filename}"
    matrix: list[list[float]]    # row-major 4x4 world transform


def _resolve_input_path(raw_path: str) -> Path:
    candidate = Path(raw_path)
    if candidate.is_absolute():
        resolved = candidate.resolve()
        if not resolved.exists():
            raise HTTPException(404, f"File not found: {raw_path}")
        return resolved

    resolved = (WORKSPACE_DIR / raw_path).resolve()
    if not str(resolved).startswith(str(WORKSPACE_DIR.resolve())):
        raise HTTPException(400, "Invalid path")
    if not resolved.exists():
        raise HTTPException(404, f"File not found: {raw_path}")
    return resolved


def _operation_output_path(input_path: Path, output_name: str) -> Path:
    workspace = WORKSPACE_DIR.resolve()
    resolved_input = input_path.resolve()
    output_dir = (
        input_path.parent
        if resolved_input == workspace or workspace in resolved_input.parents
        else WORKSPACE_DIR / "Workflows"
    )
    output_dir.mkdir(parents=True, exist_ok=True)
    return output_dir / output_name


def _run_operation(
    operation_id: str,
    input_path: Path,
    params: dict[str, object],
    output_path: Path | None = None,
    preserve_visuals: bool = False,
) -> MeshOpResult:
    context = MeshOpContext(
        workspace_dir=WORKSPACE_DIR,
        temp_dir=Path(tempfile.gettempdir()),
        output_path=output_path,
        preserve_visuals=preserve_visuals,
    )
    try:
        return mesh_ops_registry.run(operation_id, input_path, params, context)
    except MeshOpNotFoundError as exc:
        raise HTTPException(404, f"Unknown mesh operation: {operation_id}") from exc
    except MeshOpUnavailableError as exc:
        raise HTTPException(503, str(exc)) from exc
    except (TypeError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc


def _operation_response(result: MeshOpResult) -> dict[str, object]:
    output_path = result.file_path.resolve()
    try:
        relative_path = output_path.relative_to(WORKSPACE_DIR.resolve()).as_posix()
    except ValueError:
        payload: dict[str, object] = {"path": str(output_path)}
    else:
        payload = {
            "path": relative_path,
            "url": f"/workspace/{relative_path}",
        }
    payload.update(result.details)
    return payload


@router.get("/ops")
def list_mesh_operations():
    return mesh_ops_registry.describe()


@router.post("/op/{op_name}")
def run_mesh_operation(op_name: str, body: MeshOpRequest):
    input_path = _resolve_input_path(body.path)
    return _operation_response(
        _run_operation(op_name, input_path, body.params)
    )


@router.post("/mesh")
def optimize_mesh(body: OptimizeRequest):
    target_faces = max(100, min(500_000, body.target_faces))
    input_path = _resolve_input_path(body.path)
    output_path = _operation_output_path(
        input_path,
        f"{input_path.stem}_opt{target_faces}.glb",
    )
    response = _operation_response(
        _run_operation(
            "decimate",
            input_path,
            {"target_faces": target_faces},
            output_path,
        )
    )
    return {
        "url": response.get("url"),
        "face_count": response.get("face_count", 0),
    }


@router.post("/smooth")
def smooth_mesh(body: SmoothRequest):
    iterations = max(1, min(20, body.iterations))
    input_path = _resolve_input_path(body.path)
    output_path = _operation_output_path(
        input_path,
        f"{input_path.stem}_smooth{iterations}.glb",
    )
    response = _operation_response(
        _run_operation(
            "smooth",
            input_path,
            {"iterations": iterations, "lambda_": 0.5, "mode": "laplacian"},
            output_path,
            preserve_visuals=True,
        )
    )
    return {"url": response.get("url")}


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

    # Gaussian Splat: serve a .splat as-is, convert a GS .ply to .splat.
    # The viewer detects splats by the .splat/.ply extension in the served URL.
    if ext == "splat":
        return {"url": f"/optimize/serve-file?path={quote(str(file_path))}"}

    if ext == "ply" and _is_gaussian_ply(file_path):
        tmp_dir = tempfile.mkdtemp(prefix="modly_import_")
        output_path = os.path.join(tmp_dir, "splat.splat")
        try:
            _convert_gaussian_ply_to_splat(file_path, output_path)
        except Exception as err:  # noqa: BLE001 — surface a clean error, never 500-crash
            raise HTTPException(400, f"Unrecognised Gaussian .ply: {err}")
        return {"url": f"/optimize/serve-file?path={quote(output_path)}"}

    if ext == "glb":
        # Serve the original file directly — no copy
        return {"url": f"/optimize/serve-file?path={quote(str(file_path))}"}

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
    file_path = Path(path)
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
    workspace = reg.WORKSPACE_DIR.resolve()
    src = (workspace / path).resolve()
    if not str(src).startswith(str(workspace)):
        raise HTTPException(400, "Invalid path")
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

"""Canonical implementations for Modly's built-in mesh operations."""

import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any, Mapping

from .types import (
    MeshOpContext,
    MeshOpExecutionError,
    MeshOpResult,
    MeshOpUnavailableError,
)


def _output_path(context: MeshOpContext, prefix: str) -> Path:
    if context.output_path is not None:
        output = Path(context.output_path)
    else:
        output = (
            context.workspace_dir
            / "Workflows"
            / f"{prefix}-{int(time.time() * 1000)}.glb"
        )
    output.parent.mkdir(parents=True, exist_ok=True)
    return output


def _load_single_mesh(input_path: Path, trimesh_module):
    loaded = trimesh_module.load(str(input_path))
    if isinstance(loaded, trimesh_module.Scene):
        geometries = list(loaded.geometry.values())
        return (
            trimesh_module.util.concatenate(geometries)
            if len(geometries) > 1
            else geometries[0]
        )
    return loaded


def _raw_geometry(mesh, trimesh_module):
    loaded = trimesh_module.load(mesh, process=False)
    if isinstance(loaded, trimesh_module.Scene):
        geometries = list(loaded.geometry.values())
        loaded = (
            geometries[0]
            if len(geometries) == 1
            else trimesh_module.util.concatenate(geometries)
        )
    return trimesh_module.Trimesh(
        vertices=loaded.vertices,
        faces=loaded.faces,
        process=False,
    )


def _face_count(mesh, trimesh_module) -> int:
    if isinstance(mesh, trimesh_module.Scene):
        return sum(len(geometry.faces) for geometry in mesh.geometry.values())
    return int(len(mesh.faces))


def _has_texture(geometry, trimesh_module) -> bool:
    if not isinstance(geometry.visual, trimesh_module.visual.TextureVisuals):
        return False
    material = geometry.visual.material
    if material is None:
        return False
    return (
        getattr(material, "image", None) is not None
        or getattr(material, "baseColorTexture", None) is not None
    )


def _texture_image(geometry):
    material = geometry.visual.material
    image = getattr(material, "image", None)
    return image if image is not None else getattr(material, "baseColorTexture", None)


def _point_mtl_at_texture(mtl_path: str) -> None:
    path = Path(mtl_path)
    if not path.exists():
        return
    contents = path.read_text(encoding="utf-8")
    path.write_text(
        re.sub(r"map_Kd\s+\S+", "map_Kd texture.png", contents),
        encoding="utf-8",
    )


def _mesh_libraries(operation_name: str):
    try:
        import pymeshlab
    except ImportError as exc:
        raise MeshOpUnavailableError(
            f"{operation_name}: pymeshlab is not available on this system"
        ) from exc

    try:
        import trimesh
    except ImportError as exc:
        raise MeshOpUnavailableError(
            f"{operation_name}: trimesh is not available on this system"
        ) from exc

    return pymeshlab, trimesh


def repair_mesh(
    input_path: Path,
    params: Mapping[str, Any],
    context: MeshOpContext,
) -> MeshOpResult:
    """Run the exact repair pipeline previously owned by mesh-repair."""
    pymeshlab, trimesh = _mesh_libraries("mesh-repair")

    remove_duplicates = bool(params.get("remove_duplicates", True))
    fix_non_manifold = bool(params.get("fix_non_manifold", True))
    remove_degenerate = bool(params.get("remove_degenerate", True))
    fill_holes = bool(params.get("fill_holes", True))
    max_hole_size = int(params.get("max_hole_size", 2000))
    output_path = _output_path(context, "mesh-repair")

    context.progress(10, "Loading mesh…")
    geometry = _load_single_mesh(input_path, trimesh)

    temporary_dir = tempfile.mkdtemp()
    try:
        ply_input = os.path.join(temporary_dir, "input.ply")
        ply_output = os.path.join(temporary_dir, "output.ply")
        geometry.export(ply_input)

        mesh_set = pymeshlab.MeshSet()
        mesh_set.load_new_mesh(ply_input)

        current = mesh_set.current_mesh()
        context.log(
            f"Input: {current.vertex_number()} verts, "
            f"{current.face_number()} faces"
        )

        if remove_duplicates:
            context.progress(20, "Removing duplicates…")
            mesh_set.meshing_remove_duplicate_vertices()
            mesh_set.meshing_remove_duplicate_faces()

        if remove_degenerate:
            context.progress(40, "Removing degenerate faces…")
            mesh_set.meshing_remove_null_faces()
            mesh_set.meshing_remove_folded_faces()

        if fix_non_manifold:
            context.progress(60, "Fixing non-manifold edges…")
            try:
                mesh_set.meshing_repair_non_manifold_edges(method=0)
            except Exception as exc:
                context.log(f"Non-manifold edge repair skipped: {exc}")
            try:
                mesh_set.meshing_repair_non_manifold_vertices()
            except Exception as exc:
                context.log(f"Non-manifold vertex repair skipped: {exc}")

        if fill_holes:
            context.progress(75, "Filling holes…")
            try:
                mesh_set.meshing_close_holes(
                    maxholesize=max_hole_size,
                    newfaceselected=False,
                    selfintersection=False,
                )
            except Exception as exc:
                context.log(
                    "Hole fill skipped (mesh may still be non-manifold): "
                    f"{exc}"
                )

        current = mesh_set.current_mesh()
        context.log(
            f"Output: {current.vertex_number()} verts, "
            f"{current.face_number()} faces"
        )

        context.progress(85, "Exporting…")
        mesh_set.save_current_mesh(ply_output)
        result = _raw_geometry(ply_output, trimesh)
    finally:
        shutil.rmtree(temporary_dir, ignore_errors=True)

    result.export(str(output_path))
    context.progress(100, "Done")
    return MeshOpResult(
        file_path=output_path,
        details={"face_count": int(len(result.faces))},
    )


def smooth_mesh(
    input_path: Path,
    params: Mapping[str, Any],
    context: MeshOpContext,
) -> MeshOpResult:
    """Run the exact Taubin/Laplacian pipeline previously owned by mesh-smoother."""
    pymeshlab, trimesh = _mesh_libraries("mesh-smoother")

    iterations = int(params.get("iterations", 5))
    strength = float(params.get("lambda_", 0.5))
    mode = str(params.get("mode", "taubin"))
    output_path = _output_path(context, "mesh-smoother")

    context.log(
        f"Mode: {mode}, iterations: {iterations}, strength: {strength}"
    )
    context.progress(10, "Loading mesh…")
    geometry = _load_single_mesh(input_path, trimesh)

    temporary_dir = tempfile.mkdtemp()
    try:
        mesh_set = pymeshlab.MeshSet()
        if context.preserve_visuals:
            context.progress(30, "Smoothing (laplacian)…")
            if _has_texture(geometry, trimesh):
                obj_input = os.path.join(temporary_dir, "input.obj")
                texture_input = os.path.join(temporary_dir, "texture.png")
                obj_output = os.path.join(temporary_dir, "output.obj")

                _texture_image(geometry).save(texture_input)
                geometry.export(obj_input)
                _point_mtl_at_texture(os.path.join(temporary_dir, "input.mtl"))

                mesh_set.load_new_mesh(obj_input)
                mesh_set.apply_coord_laplacian_smoothing(
                    stepsmoothnum=iterations,
                )
                context.progress(80, "Exporting…")
                mesh_set.save_current_mesh(obj_output)
                _point_mtl_at_texture(obj_output.replace(".obj", ".mtl"))
                result = trimesh.load(obj_output)
            else:
                ply_input = os.path.join(temporary_dir, "input.ply")
                ply_output = os.path.join(temporary_dir, "output.ply")
                geometry.export(ply_input)
                mesh_set.load_new_mesh(ply_input)
                mesh_set.apply_coord_laplacian_smoothing(
                    stepsmoothnum=iterations,
                )
                context.progress(80, "Exporting…")
                mesh_set.save_current_mesh(ply_output)
                result = trimesh.load(ply_output, force="mesh")
        else:
            ply_input = os.path.join(temporary_dir, "input.ply")
            ply_output = os.path.join(temporary_dir, "output.ply")
            geometry.export(ply_input)

            mesh_set.load_new_mesh(ply_input)
            context.progress(30, f"Smoothing ({mode})…")

            if mode == "taubin":
                mesh_set.apply_coord_taubin_smoothing(
                    lambda_=strength,
                    mu=-strength - 0.01,
                    stepsmoothnum=iterations,
                )
            else:
                mesh_set.apply_coord_laplacian_smoothing(
                    stepsmoothnum=iterations,
                    cotangentweight=False,
                )

            context.progress(80, "Exporting…")
            mesh_set.save_current_mesh(ply_output)
            result = _raw_geometry(ply_output, trimesh)
    finally:
        shutil.rmtree(temporary_dir, ignore_errors=True)

    result.export(str(output_path))
    face_count = _face_count(result, trimesh)
    context.log(f"Output: {output_path} ({face_count} faces)")
    context.progress(100, "Done")
    return MeshOpResult(
        file_path=output_path,
        details={"face_count": face_count},
    )


def _node_executable() -> tuple[str, bool]:
    configured = os.environ.get("MODLY_NODE_EXECUTABLE")
    if configured:
        executable = Path(configured)
        if not executable.is_file():
            raise MeshOpUnavailableError(
                f"Configured Node runtime does not exist: {configured}"
            )
        return str(executable), True

    executable = shutil.which("node") or shutil.which("nodejs")
    if executable is None:
        raise MeshOpUnavailableError(
            "mesh-optimizer requires Node.js (or Modly's Electron runtime)"
        )
    return executable, False


def _meshopt_dependency_dir() -> Path:
    candidates: list[Path] = []
    extension_dir = os.environ.get("EXTENSION_DIR")
    if extension_dir:
        candidates.append(Path(extension_dir))

    app_root = Path(__file__).resolve().parents[3]
    candidates.extend(
        [
            app_root / "builtin-extensions" / "mesh-optimizer",
            app_root / "out" / "builtin-extensions" / "mesh-optimizer",
            app_root / "src" / "areas" / "workflows" / "nodes" / "mesh-optimizer",
        ]
    )

    for candidate in candidates:
        if (candidate / "node_modules" / "meshoptimizer").exists():
            return candidate

    raise MeshOpUnavailableError(
        "mesh-optimizer dependencies are unavailable; run `npm run build` "
        "before starting Modly from source"
    )


def decimate_mesh(
    input_path: Path,
    params: Mapping[str, Any],
    context: MeshOpContext,
) -> MeshOpResult:
    """Run the existing glTF Transform + meshoptimizer implementation."""
    executable, electron_runtime = _node_executable()
    dependency_dir = _meshopt_dependency_dir()
    runner_path = Path(__file__).with_name("meshopt_runner.cjs")

    environment = os.environ.copy()
    if electron_runtime:
        environment["ELECTRON_RUN_AS_NODE"] = "1"

    payload = {
        "inputPath": str(input_path),
        "params": dict(params),
        "workspaceDir": str(context.workspace_dir),
        "dependencyDir": str(dependency_dir),
        "outputPath": (
            str(context.output_path) if context.output_path is not None else None
        ),
    }

    process = subprocess.Popen(
        [executable, str(runner_path)],
        cwd=str(dependency_dir),
        env=environment,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )
    if process.stdin is None or process.stdout is None or process.stderr is None:
        process.kill()
        raise MeshOpExecutionError("mesh-optimizer failed to open its I/O pipes")

    process.stdin.write(json.dumps(payload) + "\n")
    process.stdin.close()

    result_payload: dict[str, Any] | None = None
    backend_error: str | None = None
    for raw_line in process.stdout:
        line = raw_line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            context.log(line)
            continue

        message_type = message.get("type")
        if message_type == "progress":
            context.progress(
                int(message.get("percent", 0)),
                str(message.get("label", "")),
            )
        elif message_type == "log":
            context.log(str(message.get("message", "")))
        elif message_type == "done":
            result_payload = message.get("result") or {}
        elif message_type == "error":
            backend_error = str(message.get("message", "Unknown error"))

    stderr = process.stderr.read().strip()
    return_code = process.wait()
    if backend_error is not None:
        raise MeshOpExecutionError(backend_error)
    if return_code != 0:
        raise MeshOpExecutionError(
            stderr or f"mesh-optimizer exited with code {return_code}"
        )
    if result_payload is None or not result_payload.get("filePath"):
        raise MeshOpExecutionError("mesh-optimizer returned no output file")

    details: dict[str, Any] = {}
    if result_payload.get("faceCount") is not None:
        details["face_count"] = int(result_payload["faceCount"])
    return MeshOpResult(
        file_path=Path(result_payload["filePath"]),
        details=details,
    )

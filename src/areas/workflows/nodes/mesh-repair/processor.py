"""
Mesh Repair — built-in process extension.

Fixes common topology issues in AI-generated meshes:
  - Duplicate vertices and faces
  - Non-manifold edges
  - Degenerate (zero-area) faces
  - Simple boundary holes

Note: structural holes from FlexiCubes/TRELLIS voxel extraction cannot be
reliably closed in post-processing. Increase the generator's remesh resolution
to reduce them at the source.

Protocol: reads one JSON line from stdin, writes JSON lines to stdout.
  stdin : { input, params, workspaceDir, tempDir }
  stdout: { type: "progress"|"log"|"done"|"error", ... }
"""
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path


def emit(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


def progress(pct: int, label: str) -> None:
    emit({"type": "progress", "percent": pct, "label": label})


def log(msg: str) -> None:
    emit({"type": "log", "message": msg})


def done(file_path: str) -> None:
    emit({"type": "done", "result": {"filePath": file_path}})


def error(msg: str) -> None:
    emit({"type": "error", "message": msg})


def main() -> None:
    raw  = sys.stdin.readline()
    data = json.loads(raw)

    input_data    = data.get("input", {})
    params        = data.get("params", {})
    workspace_dir = data.get("workspaceDir", "")

    input_path = input_data.get("filePath")
    if not input_path or not Path(input_path).is_file():
        error(f"mesh-repair: input file not found: {input_path}")
        return

    do_remove_dupes     = bool(params.get("remove_duplicates", True))
    do_fix_non_manifold = bool(params.get("fix_non_manifold", True))
    do_remove_degen     = bool(params.get("remove_degenerate", True))
    do_fill_holes       = bool(params.get("fill_holes", True))
    max_hole_size       = int(params.get("max_hole_size", 2000))

    out_dir = Path(workspace_dir) / "Workflows"
    out_dir.mkdir(parents=True, exist_ok=True)
    from time import time
    out_path = str(out_dir / f"mesh-repair-{int(time() * 1000)}.glb")

    try:
        import pymeshlab
    except ImportError:
        error("mesh-repair: pymeshlab is not available on this system")
        return

    import trimesh

    progress(10, "Loading mesh…")
    loaded = trimesh.load(input_path)
    if isinstance(loaded, trimesh.Scene):
        geoms = list(loaded.geometry.values())
        geom  = trimesh.util.concatenate(geoms) if len(geoms) > 1 else geoms[0]
    else:
        geom = loaded

    tmp_dir = tempfile.mkdtemp()
    try:
        ply_in  = os.path.join(tmp_dir, "input.ply")
        ply_out = os.path.join(tmp_dir, "output.ply")
        geom.export(ply_in)

        ms = pymeshlab.MeshSet()
        ms.load_new_mesh(ply_in)

        log(f"Input: {ms.current_mesh().vertex_number()} verts, {ms.current_mesh().face_number()} faces")

        if do_remove_dupes:
            progress(20, "Removing duplicates…")
            ms.meshing_remove_duplicate_vertices()
            ms.meshing_remove_duplicate_faces()

        if do_remove_degen:
            progress(40, "Removing degenerate faces…")
            ms.meshing_remove_null_faces()
            ms.meshing_remove_folded_faces()

        if do_fix_non_manifold:
            progress(60, "Fixing non-manifold edges…")
            # method=0 removes offending faces (low memory); method=1 detaches (OOMs on dense meshes)
            try:
                ms.meshing_repair_non_manifold_edges(method=0)
            except Exception as e:
                log(f"Non-manifold edge repair skipped: {e}")
            try:
                ms.meshing_repair_non_manifold_vertices()
            except Exception as e:
                log(f"Non-manifold vertex repair skipped: {e}")

        if do_fill_holes:
            progress(75, "Filling holes…")
            try:
                ms.meshing_close_holes(
                    maxholesize=max_hole_size,
                    newfaceselected=False,
                    selfintersection=False,
                )
            except Exception as e:
                log(f"Hole fill skipped (mesh may still be non-manifold): {e}")

        after = ms.current_mesh().face_number()
        log(f"Output: {ms.current_mesh().vertex_number()} verts, {after} faces")

        progress(85, "Exporting…")
        ms.save_current_mesh(ply_out)
        _loaded = trimesh.load(ply_out, process=False)
        if isinstance(_loaded, trimesh.Scene):
            _geoms = list(_loaded.geometry.values())
            _loaded = _geoms[0] if len(_geoms) == 1 else trimesh.util.concatenate(_geoms)
        result = trimesh.Trimesh(vertices=_loaded.vertices, faces=_loaded.faces, process=False)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    result.export(out_path)
    progress(100, "Done")
    done(out_path)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        import traceback
        error(f"{exc}\n{traceback.format_exc()}")

"""
Mesh Smoother — built-in process extension.

Reduces sharp artifacts (zipper triangles, sawtooth edges) produced by
AI mesh generators via Taubin or Laplacian smoothing.

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
        error(f"mesh-smoother: input file not found: {input_path}")
        return

    iterations = int(params.get("iterations", 5))
    lambda_    = float(params.get("lambda_", 0.5))
    mode       = str(params.get("mode", "taubin"))

    out_dir = Path(workspace_dir) / "Workflows"
    out_dir.mkdir(parents=True, exist_ok=True)
    from time import time
    out_path = str(out_dir / f"mesh-smoother-{int(time() * 1000)}.glb")

    log(f"Mode: {mode}, iterations: {iterations}, strength: {lambda_}")

    try:
        import pymeshlab
    except ImportError:
        error("mesh-smoother: pymeshlab is not available on this system")
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

        progress(30, f"Smoothing ({mode})…")

        if mode == "taubin":
            ms.apply_coord_taubin_smoothing(
                lambda_=lambda_,
                mu=-lambda_ - 0.01,
                stepsmoothnum=iterations,
            )
        else:
            ms.apply_coord_laplacian_smoothing(
                stepsmoothnum=iterations,
                cotangentweight=False,
            )

        progress(80, "Exporting…")
        ms.save_current_mesh(ply_out)
        # Load raw geometry only — avoids scipy dependency triggered by face→vertex color conversion
        _loaded = trimesh.load(ply_out, process=False)
        if isinstance(_loaded, trimesh.Scene):
            _geoms = list(_loaded.geometry.values())
            _loaded = _geoms[0] if len(_geoms) == 1 else trimesh.util.concatenate(_geoms)
        result = trimesh.Trimesh(vertices=_loaded.vertices, faces=_loaded.faces, process=False)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    result.export(out_path)
    log(f"Output: {out_path} ({len(result.faces)} faces)")
    progress(100, "Done")
    done(out_path)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        import traceback
        error(f"{exc}\n{traceback.format_exc()}")

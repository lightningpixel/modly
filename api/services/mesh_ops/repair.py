"""Composite, diagnostic-driven repair: loop until the mesh is closed and manifold."""

from pathlib import Path
from typing import Any, Mapping

from .geometry import merged_geometry, scene_meshes
from .inspection import _has_uvs, topology_issues, topology_summary
from .operations import _mesh_libraries, _output_path
from .types import MeshOpContext, MeshOpExecutionError, MeshOpResult


# Filling a hole can leave a non-manifold edge behind, and fixing that edge can
# open a new hole, so a single pass is not enough; three settle every case seen
# in practice, and the loop also stops as soon as a pass makes no progress.
MAX_PASSES = 3


def _is_sound(summary: Mapping[str, Any], fill_holes: bool) -> bool:
    # Inside-out is left to the final flip: it needs a closed, coherent mesh.
    return (
        (summary["is_watertight"] or not fill_holes)
        and summary["is_manifold"]
        and summary["is_winding_consistent"]
    )


def _progress_key(summary: Mapping[str, Any]) -> tuple:
    return (
        summary["hole_count"],
        summary["boundary_edge_count"],
        summary["non_manifold_edge_count"],
        summary["is_winding_consistent"],
        summary["degenerate_face_count"],
    )


def _merged(vertices, faces, trimesh_module):
    # Merged by position exactly as inspect_mesh does, so each pass is judged
    # by the same diagnostic the user will see afterwards.
    return trimesh_module.Trimesh(vertices=vertices, faces=faces, process=True)


def _run_pass(
    mesh,
    summary: Mapping[str, Any],
    fill_holes: bool,
    context: MeshOpContext,
    pymeshlab_module,
    trimesh_module,
) -> tuple[Any, list[str]]:
    """Run the repair steps the diagnostic calls for; return the mesh and steps.

    Removing degenerate or non-manifold faces opens holes, so those steps only
    run when the holes may be filled; otherwise the repair would leave the mesh
    more open than it found it.
    """
    steps = []
    if fill_holes and summary["degenerate_face_count"]:
        # The holes this opens are closed by the fill below.
        mesh.update_faces(mesh.nondegenerate_faces())
        mesh.remove_unreferenced_vertices()
        steps.append("remove_degenerate")

    mesh_set = pymeshlab_module.MeshSet()
    mesh_set.add_mesh(
        pymeshlab_module.Mesh(vertex_matrix=mesh.vertices, face_matrix=mesh.faces)
    )
    mesh_set.meshing_remove_duplicate_faces()
    if fill_holes and not summary["is_manifold"]:
        mesh_set.meshing_repair_non_manifold_edges(method=0)
        mesh_set.meshing_repair_non_manifold_vertices()
        mesh_set.meshing_remove_unreferenced_vertices()
        steps.append("fix_non_manifold")

    if fill_holes and (summary["hole_count"] or steps):
        # No size limit: a hole's boundary can't have more edges than the mesh.
        max_hole_size = 3 * mesh_set.current_mesh().face_number() + 3
        try:
            mesh_set.meshing_close_holes(
                maxholesize=max_hole_size,
                newfaceselected=False,
                selfintersection=False,
            )
            steps.append("fill_holes")
        except Exception as exc:
            context.log(f"Hole fill skipped this pass: {exc}")

    current = mesh_set.current_mesh()
    mesh = _merged(current.vertex_matrix(), current.face_matrix(), trimesh_module)
    if not mesh.is_winding_consistent:
        # pymeshlab rather than trimesh.repair.fix_winding, which needs
        # networkx: not one of Modly's dependencies.
        mesh_set = pymeshlab_module.MeshSet()
        mesh_set.add_mesh(
            pymeshlab_module.Mesh(vertex_matrix=mesh.vertices, face_matrix=mesh.faces)
        )
        try:
            mesh_set.meshing_re_orient_faces_coherently()
        except Exception as exc:
            # Orientation needs a manifold mesh; the next pass fixes that first.
            context.log(f"Face re-orientation skipped this pass: {exc}")
        else:
            current = mesh_set.current_mesh()
            mesh = _merged(current.vertex_matrix(), current.face_matrix(), trimesh_module)
            steps.append("reorient_faces")
    return mesh, steps


def _unchanged(before: Mapping[str, Any], mesh, context: MeshOpContext) -> MeshOpResult:
    """Report a mesh the repair leaves as it is, without writing a file."""
    remaining = topology_issues(before)
    context.log(
        "Nothing repaired" + (f": {'; '.join(remaining)}" if remaining else "")
    )
    context.progress(100, "Done")
    return MeshOpResult(
        details={
            "repaired": False,
            "passes": 0,
            "steps": [],
            "before": before,
            "after": before,
            "remaining_issues": remaining,
            "face_count": int(len(mesh.faces)),
            "textures_dropped": False,
        }
    )


def auto_repair_mesh(
    input_path: Path,
    params: Mapping[str, Any],
    context: MeshOpContext,
) -> MeshOpResult:
    """Repair what the diagnostic finds, re-checking after every pass.

    The output is geometry only: hole filling and face removal change the
    topology, so the original UVs and textures cannot be carried over.
    """
    pymeshlab, trimesh = _mesh_libraries("repair_mesh")
    fill_holes = bool(params.get("fill_holes", True))

    context.progress(10, "Diagnosing…")
    loaded = trimesh.load(str(input_path), process=False)
    parts = scene_meshes(loaded, trimesh)
    if not parts:
        raise MeshOpExecutionError(
            f"repair_mesh: {input_path.name} contains no triangle mesh"
        )
    # Merged by position, so UV seams are not mistaken for holes.
    mesh = merged_geometry(parts, trimesh)
    before = topology_summary(mesh, trimesh)
    has_textures = any(_has_uvs(geometry, trimesh) for geometry, _ in parts)

    if (
        _is_sound(before, fill_holes)
        and not before["is_inside_out"]
        and not before["degenerate_face_count"]
    ):
        return _unchanged(before, mesh, context)

    summary = before
    steps: list[str] = []
    passes = 0
    for passes in range(1, MAX_PASSES + 1):
        context.progress(20 + 20 * (passes - 1), f"Repair pass {passes}…")
        previous = summary
        mesh, pass_steps = _run_pass(
            mesh, summary, fill_holes, context, pymeshlab, trimesh
        )
        steps.extend(pass_steps)
        summary = topology_summary(mesh, trimesh)
        context.log(
            f"Pass {passes}: "
            + ("; ".join(topology_issues(summary)) or "closed and manifold")
        )
        if _is_sound(summary, fill_holes) or _progress_key(summary) == _progress_key(previous):
            break

    if summary["is_inside_out"]:
        mesh.invert()
        steps.append("flip_normals")
        summary = topology_summary(mesh, trimesh)

    if not steps:
        # Only reachable with fill_holes off: every remaining issue needs a fill.
        return _unchanged(before, mesh, context)
    if not len(mesh.faces):
        raise MeshOpExecutionError("repair_mesh: the repair left no faces")

    context.progress(90, "Exporting…")
    output_path = _output_path(context, "repair-mesh")
    mesh.export(str(output_path))
    remaining = topology_issues(summary)
    context.log(
        f"Repaired in {passes} pass(es): "
        + ("; ".join(remaining) if remaining else "closed and manifold")
    )
    context.progress(100, "Done")
    return MeshOpResult(
        file_path=output_path,
        details={
            "repaired": True,
            "passes": passes,
            # In first-applied order, without repeats across passes.
            "steps": list(dict.fromkeys(steps)),
            "before": before,
            "after": summary,
            "remaining_issues": remaining,
            "face_count": int(len(mesh.faces)),
            "textures_dropped": has_textures,
        },
    )

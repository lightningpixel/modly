"""Semantic transforms: derive a 4x4 matrix from the mesh itself, then bake it."""

from pathlib import Path
from typing import Any, Mapping, Sequence

from .geometry import merged_geometry, scene_meshes
from .operations import _output_path
from .types import (
    MeshOpContext,
    MeshOpExecutionError,
    MeshOpResult,
    MeshOpUnavailableError,
)


# glTF's unit is the metre.
UNIT_SCALE = {"m": 1.0, "cm": 0.01, "mm": 0.001}
DIMENSION_AXES = {"x": 0, "y": 1, "z": 2}
# Steps always run in this order, whatever order they were requested in:
# orienting or scaling after grounding would lift the mesh off the ground again.
CANONICAL_ORDER = ("auto_orient", "normalize_scale", "recenter", "drop_to_ground")
# auto_orient only acts when the thinnest PCA extent is clearly thinner than
# the next one; a cube or a sphere has no flat side to lay down on.
FLATNESS_RATIO = 0.8


def _trimesh():
    try:
        import trimesh
    except ImportError as exc:
        raise MeshOpUnavailableError(
            "mesh transforms: trimesh is not available on this system"
        ) from exc
    return trimesh


def _about(pivot, matrix, trimesh_module):
    """Conjugate a matrix so it acts around pivot instead of the origin."""
    translate = trimesh_module.transformations.translation_matrix
    return translate(pivot) @ matrix @ translate(-pivot)


def _recenter(mesh, params, trimesh_module):
    return trimesh_module.transformations.translation_matrix(-mesh.centroid)


def _drop_to_ground(mesh, params, trimesh_module):
    return trimesh_module.transformations.translation_matrix(
        [0.0, -mesh.bounds[0][1], 0.0]
    )


def _auto_orient(mesh, params, trimesh_module):
    """Smallest rotation that turns the mesh's thinnest axis (PCA) vertical."""
    import numpy as np

    weights = mesh.area_faces
    if weights.sum() <= 0:
        return np.eye(4)
    centers = mesh.triangles_center
    offsets = centers - np.average(centers, axis=0, weights=weights)
    covariance = (offsets * weights[:, None]).T @ offsets / weights.sum()
    # eigh returns ascending eigenvalues: column 0 is the thinnest direction.
    variances, axes = np.linalg.eigh(covariance)
    spreads = np.sqrt(np.clip(variances, 0.0, None))
    if spreads[1] <= 0 or spreads[0] >= FLATNESS_RATIO * spreads[1]:
        return np.eye(4)

    thin_axis = axes[:, 0]
    # Of the two directions along the axis, take the one already pointing up so
    # the rotation stays under 90° and the mesh is not flipped over.
    if thin_axis[1] < 0:
        thin_axis = -thin_axis
    rotation = trimesh_module.geometry.align_vectors(thin_axis, [0.0, 1.0, 0.0])
    return _about(mesh.centroid, rotation, trimesh_module)


def _normalize_scale(mesh, params, trimesh_module):
    target = float(params["size"]) * UNIT_SCALE[params["unit"]]
    extents = mesh.extents
    dimension = params["dimension"]
    current = (
        float(max(extents))
        if dimension == "longest"
        else float(extents[DIMENSION_AXES[dimension]])
    )
    if current <= 0:
        raise MeshOpExecutionError(
            f"normalize_scale: the mesh has no extent along {dimension}"
        )
    # Scaling around the origin keeps a recentered or grounded mesh so.
    return trimesh_module.transformations.scale_matrix(target / current)


STEP_MATRICES = {
    "recenter": _recenter,
    "drop_to_ground": _drop_to_ground,
    "auto_orient": _auto_orient,
    "normalize_scale": _normalize_scale,
}


def _world_mesh(loaded, trimesh_module):
    parts = scene_meshes(loaded, trimesh_module)
    if not parts:
        raise MeshOpExecutionError("mesh transforms: the file contains no triangle mesh")
    # Measurements only: no need to pay for a vertex merge.
    return merged_geometry(parts, trimesh_module, process=False)


def transform_file(input_path: Path, matrix, output_path: Path) -> Path:
    """Bake a 4x4 world transform into a mesh file, keeping materials and UVs."""
    trimesh = _trimesh()
    # Keep the loaded result as-is (Scene when textured/multi-geometry) so
    # apply_transform preserves materials and UVs.
    loaded = trimesh.load(str(input_path))
    loaded.apply_transform(matrix)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    loaded.export(str(output_path))
    return output_path


def apply_transforms(
    input_path: Path,
    steps: Sequence[tuple[str, Mapping[str, Any]]],
    output_path: Path,
    context: MeshOpContext,
) -> MeshOpResult:
    """Apply semantic steps in canonical order and write a single output file.

    Each step measures the mesh as the previous steps left it, so "lay it flat,
    centre it and put it on the ground" yields one consistent result.
    """
    trimesh = _trimesh()
    unknown = [step_id for step_id, _ in steps if step_id not in STEP_MATRICES]
    if unknown:
        raise ValueError(f"Unknown transform step(s): {', '.join(unknown)}")
    if not steps:
        raise ValueError("At least one transform step is required")
    requested = dict(steps)
    ordered = [step_id for step_id in CANONICAL_ORDER if step_id in requested]

    context.progress(10, "Loading mesh…")
    loaded = trimesh.load(str(input_path))

    for index, step_id in enumerate(ordered):
        context.progress(20 + 60 * index // len(ordered), f"Applying {step_id}…")
        matrix = STEP_MATRICES[step_id](
            _world_mesh(loaded, trimesh),
            requested[step_id],
            trimesh,
        )
        loaded.apply_transform(matrix)

    context.progress(85, "Exporting…")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    loaded.export(str(output_path))

    result = _world_mesh(loaded, trimesh)
    context.log(f"Applied {', '.join(ordered)} → {output_path}")
    context.progress(100, "Done")
    return MeshOpResult(
        file_path=output_path,
        details={
            "applied": ordered,
            "dimensions": [float(value) for value in result.extents],
            "bounds": {
                "min": [float(value) for value in result.bounds[0]],
                "max": [float(value) for value in result.bounds[1]],
            },
        },
    )


def _single_step_op(step_id: str):
    def run(
        input_path: Path,
        params: Mapping[str, Any],
        context: MeshOpContext,
    ) -> MeshOpResult:
        return apply_transforms(
            input_path,
            [(step_id, params)],
            _output_path(context, step_id.replace("_", "-")),
            context,
        )

    run.__name__ = step_id
    return run


recenter = _single_step_op("recenter")
drop_to_ground = _single_step_op("drop_to_ground")
auto_orient = _single_step_op("auto_orient")
normalize_scale = _single_step_op("normalize_scale")

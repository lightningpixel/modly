"""World-space geometry helpers shared by the analysis and transform ops."""


def scene_meshes(loaded, trimesh_module) -> list[tuple]:
    """Return (geometry, world transform or None) for every non-empty triangle mesh."""
    if not isinstance(loaded, trimesh_module.Scene):
        candidates = [(loaded, None)]
    else:
        candidates = []
        for node in loaded.graph.nodes_geometry:
            transform, geometry_name = loaded.graph[node]
            candidates.append((loaded.geometry.get(geometry_name), transform))
    return [
        (geometry, transform)
        for geometry, transform in candidates
        if isinstance(geometry, trimesh_module.Trimesh) and len(geometry.faces)
    ]


def merged_geometry(parts, trimesh_module, process: bool = True):
    """Concatenate the parts into one world-space mesh, without visuals.

    With process (the default), vertices are merged by position: UV seams split
    vertices, and without the merge every textured mesh would look open along
    its seams. Pure measurements (bounds, centroid) can skip it.
    """
    import numpy as np

    vertices = []
    faces = []
    offset = 0
    for geometry, transform in parts:
        points = np.asarray(geometry.vertices, dtype=float)
        if transform is not None:
            points = trimesh_module.transformations.transform_points(points, transform)
        vertices.append(points)
        faces.append(np.asarray(geometry.faces, dtype=np.int64) + offset)
        offset += len(points)

    return trimesh_module.Trimesh(
        vertices=np.vstack(vertices),
        faces=np.vstack(faces),
        process=process,
    )

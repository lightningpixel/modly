"""World-space geometry helpers shared by the analysis and transform ops."""

from copy import deepcopy


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


def baked_parts(loaded, trimesh_module) -> list:
    """A copy of every triangle mesh with its world transform baked into the vertices."""
    parts = []
    for geometry, transform in scene_meshes(loaded, trimesh_module):
        part = geometry.copy()
        if transform is not None:
            part.apply_transform(transform)
        parts.append(part)
    return parts


def single_mesh(loaded, trimesh_module):
    """One mesh in world space, keeping visuals: what the node transforms place.

    Concatenating scene.geometry directly would drop the node transforms, and a
    mesh scaled or moved at node level would come out at its stored size.
    """
    parts = baked_parts(loaded, trimesh_module)
    if not parts:
        raise ValueError("The file contains no triangle mesh")
    return trimesh_module.util.concatenate(parts) if len(parts) > 1 else parts[0]


def bake_transforms(loaded, trimesh_module):
    """The same scene with every node transform applied to its geometry.

    trimesh's Scene.apply_transform only moves the base frame, so the vertices
    keep their old coordinates. Baking makes the stored geometry what the scene
    shows, for readers that ignore nodes (STL/OBJ writers, the mesh exporter).
    """
    if not isinstance(loaded, trimesh_module.Scene):
        return loaded
    baked = trimesh_module.Scene()
    baked.metadata.update(deepcopy(loaded.metadata))
    for node in loaded.graph.nodes_geometry:
        transform, geometry_name = loaded.graph[node]
        geometry = loaded.geometry.get(geometry_name)
        if geometry is None:
            continue
        part = geometry.copy()
        part.apply_transform(transform)
        baked.add_geometry(part, node_name=node, geom_name=node)
    return baked


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

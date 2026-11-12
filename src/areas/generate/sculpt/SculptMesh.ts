// Sculpt core: brushes applied in place on a geometry's position/normal arrays.
// CONTRACT STUB — the public surface below is fixed; the implementation is
// filled in separately (see tasks/todo.md, #432/#433).

import type {
  BrushSettings,
  DirtyRegion,
  SculptMeshOptions,
  StrokeRecord,
  Vec3,
} from './types'

export class SculptMesh {
  /** The array passed to the constructor, mutated in place. */
  readonly positions: Float32Array
  /** The normals passed in, or a newly allocated array when there were none. Mutated in place. */
  readonly normals: Float32Array
  readonly vertexCount: number
  /** Bounding-box centre at construction: the symmetry planes pass through it. */
  readonly symmetryCenter: Vec3

  /**
   * Builds the weld map (UV-seam duplicates), vertex adjacency and a spatial
   * index. Must stay fast on ~1M-triangle meshes (target < 1.5 s).
   * `normals` null → normals are computed from the faces.
   */
  constructor(
    positions: Float32Array,
    normals: Float32Array | null,
    index: Uint32Array | Uint16Array | null,
    options?: SculptMeshOptions,
  ) {
    void positions; void normals; void index; void options
    throw new Error('SculptMesh: not implemented')
  }

  /**
   * Starts a stroke at a surface point. For grab, the vertices inside the
   * radius and their weights are captured here and stay fixed for the stroke.
   */
  beginStroke(settings: BrushSettings, point: Vec3, normal: Vec3): DirtyRegion {
    void settings; void point; void normal
    throw new Error('SculptMesh: not implemented')
  }

  /**
   * Continues the stroke to a new point.
   * - grab: `point` is the cursor projected on the camera-facing plane through
   *   the stroke's start point (computed by the viewer); the captured vertices
   *   follow point − previous point, scaled by their weight.
   * - other brushes: dabs are spaced along the path (every ~radius/4) from the
   *   previous point; `point`/`normal` are the latest surface hit.
   * Positions, normals of the affected region, and weld duplicates are updated.
   */
  strokeTo(point: Vec3, normal: Vec3): DirtyRegion {
    void point; void normal
    throw new Error('SculptMesh: not implemented')
  }

  /** Ends the stroke. Returns its undo record, or null if nothing moved. */
  endStroke(): StrokeRecord | null {
    throw new Error('SculptMesh: not implemented')
  }

  /**
   * Swaps the vertices of `record` with their current state and returns the
   * record of what was overwritten, so undo and redo are the same call.
   */
  restore(record: StrokeRecord): { region: DirtyRegion; inverse: StrokeRecord } {
    void record
    throw new Error('SculptMesh: not implemented')
  }

  /** True once any stroke or restore changed the mesh since construction. */
  get changed(): boolean {
    throw new Error('SculptMesh: not implemented')
  }
}

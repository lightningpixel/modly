// Contract between the sculpt core (pure geometry, ./SculptMesh.ts) and the
// viewer integration (Viewer3D / EditPanel). No three.js imports here: the core
// works on raw typed arrays so it can be unit-tested with node --test.
//
// Coordinates are always in the LOCAL space of one THREE.Mesh geometry (the
// same space as geometry.attributes.position). The viewer converts world-space
// hits and radii into that space before calling the core.

export type Vec3 = [number, number, number]

export type BrushKind = 'grab' | 'smooth' | 'inflate' | 'flatten'

export type SymmetryAxis = 'x' | 'y' | 'z'

export interface BrushSettings {
  kind: BrushKind
  /** Brush radius, in local units. */
  radius: number
  /** 0..1. */
  strength: number
  /** Inflate → deflate, flatten → pull outwards (Ctrl held). Ignored by grab and smooth. */
  invert: boolean
  /** Mirror every dab across these planes through SculptMesh.symmetryCenter. */
  symmetry: SymmetryAxis[]
}

/** Buffer vertices touched by one call, so the viewer can upload only that range. */
export interface DirtyRegion {
  /**
   * Every buffer vertex index whose position or normal changed, including the
   * duplicates welded to a moved vertex (UV seams). Empty when nothing moved.
   */
  vertices: Uint32Array
  /** Smallest and largest touched buffer index (for BufferAttribute.addUpdateRange). */
  minIndex: number
  maxIndex: number
}

/** Undo record of one stroke: swap it back with SculptMesh.restore(). */
export interface StrokeRecord {
  vertices: Uint32Array
  positions: Float32Array
  normals: Float32Array
}

export interface SculptMeshOptions {
  /** Distance under which two buffer vertices count as one (UV-seam duplicates). Default: 1e-6 × bbox diagonal. */
  weldEpsilon?: number
}

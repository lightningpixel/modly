// Sculpt core: brushes applied in place on a geometry's position/normal arrays.
//
// Everything works on "welded" vertices: buffer vertices closer than the weld
// epsilon (UV-seam duplicates, triangle-soup corners) form one logical vertex,
// and every write goes to all its duplicates so the surface never tears.
// Pure typed-array code, no three.js, so it runs under node --test.

import type {
  BrushSettings,
  DirtyRegion,
  SculptMeshOptions,
  StrokeRecord,
  Vec3,
} from './types'
import { SpatialGrid } from './SpatialGrid'
import { type Csr, vertexFaces, vertexNeighbours, weldedTriangles } from './topology'
import { buildWeldMap } from './weld'

/** Inflate displacement per dab at the brush centre, as a fraction of the radius (× strength). */
export const INFLATE_RATE = 0.05
/** Dab spacing along a stroke, as a fraction of the radius. */
export const DAB_SPACING = 0.25
/** Upper bound on dabs placed by one strokeTo call (the spacing grows past it). */
const MAX_DABS_PER_CALL = 256

/** Brush falloff from a squared distance: 1 at the centre, smoothly 0 at the radius. */
export function falloff(dist2: number, radius2: number): number {
  if (!(dist2 < radius2)) return 0
  const t = 1 - dist2 / radius2
  return t * t
}

/**
 * Sign triples (±1 per axis) of every mirror combination for the given axes,
 * identity first: [] → 1 copy, ['x'] → 2, ['x','y','z'] → 8 (like Blender).
 */
export function mirrorSigns(axes: readonly string[]): Float64Array {
  const flags = [axes.includes('x'), axes.includes('y'), axes.includes('z')]
  const used = [0, 1, 2].filter((a) => flags[a])
  const total = 1 << used.length
  const out = new Float64Array(total * 3).fill(1)
  for (let m = 0; m < total; m++) {
    used.forEach((axis, bit) => {
      if (m & (1 << bit)) out[m * 3 + axis] = -1
    })
  }
  return out
}

function emptyRegion(): DirtyRegion {
  return { vertices: new Uint32Array(0), minIndex: 0, maxIndex: -1 }
}

export class SculptMesh {
  /** The array passed to the constructor, mutated in place. */
  readonly positions: Float32Array
  /** The normals passed in, or a newly allocated array when there were none. Mutated in place. */
  readonly normals: Float32Array
  readonly vertexCount: number
  /** Bounding-box centre at construction: the symmetry planes pass through it. */
  readonly symmetryCenter: Vec3
  /** Number of logical (welded) vertices the brushes act on. */
  readonly weldedVertexCount: number

  // Topology (welded space).
  private readonly weldOf: Uint32Array
  private readonly dupStart: Uint32Array
  private readonly dupList: Uint32Array
  private readonly tri: Uint32Array
  private readonly faces: Csr
  private readonly adj: Csr
  /** Welded positions, kept in sync with the buffer (the representative's value). */
  private readonly wpos: Float32Array
  private readonly grid: SpatialGrid

  // Per-dab accumulation over the mirrored copies of a dab.
  private readonly accW: Float64Array
  private readonly accMax: Float64Array
  private readonly accD: Float64Array
  private readonly groupMark: Uint32Array
  private readonly groupList: Int32Array
  private groupId = 0
  private readonly movedList: Int32Array
  private readonly ringMark: Uint32Array
  private readonly ringList: Int32Array
  private ringId = 0

  // Dirty welded vertices of the current public call.
  private readonly callMark: Uint32Array
  private readonly callList: Int32Array
  private callId = 0
  private callCount = 0

  // Undo record of the current stroke (first touch of each buffer vertex).
  private readonly strokeMark: Uint32Array
  private strokeId = 0
  private recVerts = new Uint32Array(0)
  private recPos = new Float32Array(0)
  private recNrm = new Float32Array(0)
  private recCount = 0

  // Current stroke.
  private settings: BrushSettings | null = null
  private mirrors: Float64Array = new Float64Array([1, 1, 1])
  private lastX = 0
  private lastY = 0
  private lastZ = 0
  private grabIds = new Int32Array(0)
  private grabG = new Float32Array(0)

  private isChanged = false

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
    const n = Math.floor(positions.length / 3)
    if (normals && normals.length < n * 3) throw new RangeError('SculptMesh: normals shorter than positions')
    this.positions = positions
    this.vertexCount = n

    const min = [Infinity, Infinity, Infinity]
    const max = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < n * 3; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = positions[i + k]
        if (v < min[k]) min[k] = v
        if (v > max[k]) max[k] = v
      }
    }
    if (n === 0) { min.fill(0); max.fill(0) }
    this.symmetryCenter = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
    const diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2])

    const weld = buildWeldMap(positions, n, options?.weldEpsilon ?? diag * 1e-6, [min[0], min[1], min[2]])
    const W = weld.count
    this.weldedVertexCount = W
    this.weldOf = weld.weldOf
    this.dupStart = weld.dupStart
    this.dupList = weld.dupList

    this.wpos = new Float32Array(W * 3)
    for (let w = 0; w < W; w++) {
      const r = this.dupList[this.dupStart[w]] * 3
      this.wpos[w * 3] = positions[r]
      this.wpos[w * 3 + 1] = positions[r + 1]
      this.wpos[w * 3 + 2] = positions[r + 2]
    }

    this.tri = weldedTriangles(index, n, this.weldOf)
    this.faces = vertexFaces(this.tri, W)
    this.adj = vertexNeighbours(this.tri, this.faces, W)

    this.normals = normals ?? new Float32Array(n * 3)
    if (!normals) this.computeAllNormals()

    this.grid = new SpatialGrid(this.wpos, W, min, max, diag / 64)

    this.accW = new Float64Array(W)
    this.accMax = new Float64Array(W)
    this.accD = new Float64Array(W * 3)
    this.groupMark = new Uint32Array(W)
    this.groupList = new Int32Array(W)
    this.movedList = new Int32Array(W)
    this.ringMark = new Uint32Array(W)
    this.ringList = new Int32Array(W)
    this.callMark = new Uint32Array(W)
    this.callList = new Int32Array(W)
    this.strokeMark = new Uint32Array(W)
  }

  /**
   * Starts a stroke at a surface point. For grab, the vertices inside the
   * radius and their weights are captured here and stay fixed for the stroke.
   */
  beginStroke(settings: BrushSettings, point: Vec3, normal: Vec3): DirtyRegion {
    this.settings = { ...settings, symmetry: [...settings.symmetry] }
    this.mirrors = mirrorSigns(settings.symmetry)
    this.strokeId++
    this.recCount = 0
    this.beginCall()
    this.lastX = point[0]
    this.lastY = point[1]
    this.lastZ = point[2]
    if (settings.kind === 'grab') {
      this.captureGrab(point)
      return emptyRegion()
    }
    this.dab(point[0], point[1], point[2], normal)
    return this.takeRegion()
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
    const s = this.settings
    if (!s) return emptyRegion()
    this.beginCall()
    const dx = point[0] - this.lastX
    const dy = point[1] - this.lastY
    const dz = point[2] - this.lastZ
    if (s.kind === 'grab') {
      this.lastX = point[0]
      this.lastY = point[1]
      this.lastZ = point[2]
      this.moveGrab(dx * s.strength, dy * s.strength, dz * s.strength)
      return this.takeRegion()
    }
    const length = Math.hypot(dx, dy, dz)
    let spacing = Math.max(s.radius * DAB_SPACING, 1e-12)
    if (!(length >= spacing)) return emptyRegion()
    let steps = Math.floor(length / spacing)
    if (steps > MAX_DABS_PER_CALL) {
      steps = MAX_DABS_PER_CALL
      spacing = length / steps
    }
    const ux = dx / length
    const uy = dy / length
    const uz = dz / length
    const x0 = this.lastX
    const y0 = this.lastY
    const z0 = this.lastZ
    for (let i = 1; i <= steps; i++) {
      const t = i * spacing
      this.dab(x0 + ux * t, y0 + uy * t, z0 + uz * t, normal)
    }
    this.lastX = x0 + ux * steps * spacing
    this.lastY = y0 + uy * steps * spacing
    this.lastZ = z0 + uz * steps * spacing
    return this.takeRegion()
  }

  /** Ends the stroke. Returns its undo record, or null if nothing moved. */
  endStroke(): StrokeRecord | null {
    this.settings = null
    this.grabIds = new Int32Array(0)
    this.grabG = new Float32Array(0)
    const count = this.recCount
    this.recCount = 0
    // Invalidate the first-touch marks so a later touch records again.
    this.strokeId++
    if (count === 0) return null
    return {
      vertices: this.recVerts.slice(0, count),
      positions: this.recPos.slice(0, count * 3),
      normals: this.recNrm.slice(0, count * 3),
    }
  }

  /**
   * Swaps the vertices of `record` with their current state and returns the
   * record of what was overwritten, so undo and redo are the same call.
   */
  restore(record: StrokeRecord): { region: DirtyRegion; inverse: StrokeRecord } {
    this.beginCall()
    const { positions, normals, weldOf } = this
    const m = record.vertices.length
    const inverse: StrokeRecord = {
      vertices: record.vertices.slice(),
      positions: new Float32Array(m * 3),
      normals: new Float32Array(m * 3),
    }
    let minIndex = Infinity
    let maxIndex = -1
    for (let i = 0; i < m; i++) {
      const b = record.vertices[i]
      if (b < minIndex) minIndex = b
      if (b > maxIndex) maxIndex = b
      for (let k = 0; k < 3; k++) {
        inverse.positions[i * 3 + k] = positions[b * 3 + k]
        positions[b * 3 + k] = record.positions[i * 3 + k]
        inverse.normals[i * 3 + k] = normals[b * 3 + k]
        normals[b * 3 + k] = record.normals[i * 3 + k]
      }
      this.markDirty(weldOf[b])
    }
    for (let i = 0; i < this.callCount; i++) {
      const w = this.callList[i]
      const r = this.dupList[this.dupStart[w]] * 3
      this.wpos[w * 3] = positions[r]
      this.wpos[w * 3 + 1] = positions[r + 1]
      this.wpos[w * 3 + 2] = positions[r + 2]
      this.grid.update(w)
    }
    if (m > 0) this.isChanged = true
    const region: DirtyRegion = m > 0
      ? { vertices: record.vertices.slice(), minIndex, maxIndex }
      : emptyRegion()
    return { region, inverse }
  }

  /** True once any stroke or restore changed the mesh since construction. */
  get changed(): boolean {
    return this.isChanged
  }

  // ── Brushes ────────────────────────────────────────────────────────────

  /** Grab: captures the vertices under the (mirrored) brush and their per-axis follow factors. */
  private captureGrab(point: Vec3): void {
    const s = this.settings!
    const gid = this.nextGroup()
    let count = 0
    const { accW, accMax, accD, groupMark, groupList } = this
    const r2 = s.radius * s.radius
    const mirrors = this.mirrors
    for (let m = 0; m < mirrors.length; m += 3) {
      const sx = mirrors[m], sy = mirrors[m + 1], sz = mirrors[m + 2]
      const hits = this.grid.query(this.mirrorX(point[0], sx), this.mirrorY(point[1], sy), this.mirrorZ(point[2], sz), s.radius)
      const ids = this.grid.resultIds
      const dist = this.grid.resultDist2
      for (let i = 0; i < hits; i++) {
        const wt = falloff(dist[i], r2)
        if (wt <= 0) continue
        const w = ids[i]
        if (groupMark[w] !== gid) {
          groupMark[w] = gid
          groupList[count++] = w
          accW[w] = 0
          accMax[w] = 0
          accD[w * 3] = accD[w * 3 + 1] = accD[w * 3 + 2] = 0
        }
        accW[w] += wt
        if (wt > accMax[w]) accMax[w] = wt
        accD[w * 3] += wt * sx
        accD[w * 3 + 1] += wt * sy
        accD[w * 3 + 2] += wt * sz
      }
    }
    // Overlapping mirrored copies are blended (weighted mean scaled by the
    // strongest weight), so a vertex near the plane is never pulled twice.
    this.grabIds = groupList.slice(0, count)
    this.grabG = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      const w = groupList[i]
      const f = accMax[w] / accW[w]
      this.grabG[i * 3] = accD[w * 3] * f
      this.grabG[i * 3 + 1] = accD[w * 3 + 1] * f
      this.grabG[i * 3 + 2] = accD[w * 3 + 2] * f
    }
  }

  private moveGrab(dx: number, dy: number, dz: number): void {
    if (dx === 0 && dy === 0 && dz === 0) return
    const { grabIds, grabG } = this
    let moved = 0
    for (let i = 0; i < grabIds.length; i++) {
      if (this.moveVertex(grabIds[i], grabG[i * 3] * dx, grabG[i * 3 + 1] * dy, grabG[i * 3 + 2] * dz)) {
        this.movedList[moved++] = grabIds[i]
      }
    }
    this.finishMove(moved)
  }

  /**
   * One dab of smooth / inflate / flatten at (cx, cy, cz) and its mirrored
   * copies. Displacements are computed from the pre-dab state, then applied.
   */
  private dab(cx: number, cy: number, cz: number, hitNormal: Vec3): void {
    const s = this.settings!
    const r = s.radius
    if (!(r > 0) || !(s.strength > 0)) return
    const r2 = r * r
    const kind = s.kind
    const strength = s.strength
    const sign = s.invert ? -1 : 1
    const inflateStep = strength * r * INFLATE_RATE * sign
    const { accW, accMax, accD, groupMark, groupList, wpos, normals, dupList, dupStart } = this
    const adjStart = this.adj.start
    const adjList = this.adj.list
    const gid = this.nextGroup()
    let count = 0
    const mirrors = this.mirrors

    for (let m = 0; m < mirrors.length; m += 3) {
      const sx = mirrors[m], sy = mirrors[m + 1], sz = mirrors[m + 2]
      const hits = this.grid.query(this.mirrorX(cx, sx), this.mirrorY(cy, sy), this.mirrorZ(cz, sz), r)
      const ids = this.grid.resultIds
      const dist = this.grid.resultDist2

      // Flatten: plane through the weighted mean point, along the weighted mean normal.
      let px = 0, py = 0, pz = 0, nx = 0, ny = 0, nz = 0
      if (kind === 'flatten') {
        let sum = 0
        for (let i = 0; i < hits; i++) {
          const wt = falloff(dist[i], r2)
          if (wt <= 0) continue
          const w = ids[i]
          const b = dupList[dupStart[w]] * 3
          sum += wt
          px += wt * wpos[w * 3]
          py += wt * wpos[w * 3 + 1]
          pz += wt * wpos[w * 3 + 2]
          nx += wt * normals[b]
          ny += wt * normals[b + 1]
          nz += wt * normals[b + 2]
        }
        if (sum <= 0) continue
        px /= sum
        py /= sum
        pz /= sum
        let len = Math.hypot(nx, ny, nz)
        if (!(len > 1e-12)) {
          nx = hitNormal[0] * sx
          ny = hitNormal[1] * sy
          nz = hitNormal[2] * sz
          len = Math.hypot(nx, ny, nz)
          if (!(len > 1e-12)) continue
        }
        nx /= len
        ny /= len
        nz /= len
      }

      for (let i = 0; i < hits; i++) {
        const wt = falloff(dist[i], r2)
        if (wt <= 0) continue
        const w = ids[i]
        const o = w * 3
        let dx = 0, dy = 0, dz = 0
        if (kind === 'smooth') {
          const a = adjStart[w]
          const e = adjStart[w + 1]
          if (e > a) {
            let ax = 0, ay = 0, az = 0
            for (let k = a; k < e; k++) {
              const u = adjList[k] * 3
              ax += wpos[u]
              ay += wpos[u + 1]
              az += wpos[u + 2]
            }
            const inv = 1 / (e - a)
            dx = (ax * inv - wpos[o]) * strength
            dy = (ay * inv - wpos[o + 1]) * strength
            dz = (az * inv - wpos[o + 2]) * strength
          }
        } else if (kind === 'inflate') {
          const b = dupList[dupStart[w]] * 3
          dx = normals[b] * inflateStep
          dy = normals[b + 1] * inflateStep
          dz = normals[b + 2] * inflateStep
        } else {
          const d = ((wpos[o] - px) * nx + (wpos[o + 1] - py) * ny + (wpos[o + 2] - pz) * nz) * strength * sign
          dx = -d * nx
          dy = -d * ny
          dz = -d * nz
        }
        if (groupMark[w] !== gid) {
          groupMark[w] = gid
          groupList[count++] = w
          accW[w] = 0
          accMax[w] = 0
          accD[o] = accD[o + 1] = accD[o + 2] = 0
        }
        accW[w] += wt
        if (wt > accMax[w]) accMax[w] = wt
        accD[o] += wt * dx
        accD[o + 1] += wt * dy
        accD[o + 2] += wt * dz
      }
    }

    // Blend the mirrored copies: weighted mean of their displacements, scaled
    // by the strongest weight. Away from the planes only one copy reaches a
    // vertex (plain weight × displacement); on a plane the copies average out
    // instead of adding up.
    let moved = 0
    for (let i = 0; i < count; i++) {
      const w = groupList[i]
      const f = accMax[w] / accW[w]
      if (this.moveVertex(w, accD[w * 3] * f, accD[w * 3 + 1] * f, accD[w * 3 + 2] * f)) this.movedList[moved++] = w
    }
    this.finishMove(moved)
  }

  private mirrorX(v: number, s: number): number {
    return s > 0 ? v : 2 * this.symmetryCenter[0] - v
  }

  private mirrorY(v: number, s: number): number {
    return s > 0 ? v : 2 * this.symmetryCenter[1] - v
  }

  private mirrorZ(v: number, s: number): number {
    return s > 0 ? v : 2 * this.symmetryCenter[2] - v
  }

  // ── Vertex updates ─────────────────────────────────────────────────────

  /** Moves welded vertex `w` by d (all duplicates). Returns false when the float32 position does not change. */
  private moveVertex(w: number, dx: number, dy: number, dz: number): boolean {
    const o = w * 3
    const { wpos } = this
    const x = Math.fround(wpos[o] + dx)
    const y = Math.fround(wpos[o + 1] + dy)
    const z = Math.fround(wpos[o + 2] + dz)
    if (x === wpos[o] && y === wpos[o + 1] && z === wpos[o + 2]) return false
    this.touch(w)
    wpos[o] = x
    wpos[o + 1] = y
    wpos[o + 2] = z
    const { positions, dupList } = this
    for (let k = this.dupStart[w]; k < this.dupStart[w + 1]; k++) {
      const b = dupList[k] * 3
      positions[b] = x
      positions[b + 1] = y
      positions[b + 2] = z
    }
    this.grid.update(w)
    this.markDirty(w)
    return true
  }

  /** After `moved` vertices (movedList) moved: recompute normals of them and their 1-ring. */
  private finishMove(moved: number): void {
    if (moved === 0) return
    this.isChanged = true
    const rid = ++this.ringId
    const { ringMark, ringList, movedList } = this
    const adjStart = this.adj.start
    const adjList = this.adj.list
    let count = 0
    for (let i = 0; i < moved; i++) {
      const w = movedList[i]
      if (ringMark[w] !== rid) { ringMark[w] = rid; ringList[count++] = w }
      for (let k = adjStart[w]; k < adjStart[w + 1]; k++) {
        const u = adjList[k]
        if (ringMark[u] !== rid) { ringMark[u] = rid; ringList[count++] = u }
      }
    }
    for (let i = 0; i < count; i++) this.updateNormal(ringList[i])
  }

  /** Area-weighted smooth normal of welded vertex `w`, written to all its duplicates. */
  private updateNormal(w: number): void {
    const { tri, wpos } = this
    const fStart = this.faces.start
    const fList = this.faces.list
    let sx = 0, sy = 0, sz = 0
    for (let k = fStart[w]; k < fStart[w + 1]; k++) {
      const f = fList[k] * 3
      const a = tri[f] * 3
      const b = tri[f + 1] * 3
      const c = tri[f + 2] * 3
      const ux = wpos[b] - wpos[a], uy = wpos[b + 1] - wpos[a + 1], uz = wpos[b + 2] - wpos[a + 2]
      const vx = wpos[c] - wpos[a], vy = wpos[c + 1] - wpos[a + 1], vz = wpos[c + 2] - wpos[a + 2]
      sx += uy * vz - uz * vy
      sy += uz * vx - ux * vz
      sz += ux * vy - uy * vx
    }
    const len = Math.hypot(sx, sy, sz)
    if (!(len > 0)) return
    this.touch(w)
    const nx = sx / len, ny = sy / len, nz = sz / len
    const { normals, dupList } = this
    for (let k = this.dupStart[w]; k < this.dupStart[w + 1]; k++) {
      const b = dupList[k] * 3
      normals[b] = nx
      normals[b + 1] = ny
      normals[b + 2] = nz
    }
    this.markDirty(w)
  }

  private computeAllNormals(): void {
    const { tri, wpos, normals, dupList, dupStart } = this
    const W = this.weldedVertexCount
    const acc = new Float64Array(W * 3)
    for (let f = 0; f < tri.length; f += 3) {
      const a = tri[f] * 3
      const b = tri[f + 1] * 3
      const c = tri[f + 2] * 3
      const ux = wpos[b] - wpos[a], uy = wpos[b + 1] - wpos[a + 1], uz = wpos[b + 2] - wpos[a + 2]
      const vx = wpos[c] - wpos[a], vy = wpos[c + 1] - wpos[a + 1], vz = wpos[c + 2] - wpos[a + 2]
      const nx = uy * vz - uz * vy
      const ny = uz * vx - ux * vz
      const nz = ux * vy - uy * vx
      acc[a] += nx; acc[a + 1] += ny; acc[a + 2] += nz
      acc[b] += nx; acc[b + 1] += ny; acc[b + 2] += nz
      acc[c] += nx; acc[c + 1] += ny; acc[c + 2] += nz
    }
    for (let w = 0; w < W; w++) {
      const o = w * 3
      const len = Math.hypot(acc[o], acc[o + 1], acc[o + 2])
      const inv = len > 0 ? 1 / len : 0
      for (let k = dupStart[w]; k < dupStart[w + 1]; k++) {
        const b = dupList[k] * 3
        normals[b] = acc[o] * inv
        normals[b + 1] = acc[o + 1] * inv
        normals[b + 2] = acc[o + 2] * inv
      }
    }
  }

  // ── Bookkeeping ────────────────────────────────────────────────────────

  private nextGroup(): number {
    return ++this.groupId
  }

  private beginCall(): void {
    this.callId++
    this.callCount = 0
  }

  private markDirty(w: number): void {
    if (this.callMark[w] === this.callId) return
    this.callMark[w] = this.callId
    this.callList[this.callCount++] = w
  }

  /** Records the original state of all duplicates of `w`, the first time the stroke touches it. */
  private touch(w: number): void {
    if (this.strokeMark[w] === this.strokeId) return
    this.strokeMark[w] = this.strokeId
    const start = this.dupStart[w]
    const end = this.dupStart[w + 1]
    const needed = this.recCount + (end - start)
    if (needed > this.recVerts.length) this.growRecord(needed)
    const { positions, normals, recVerts, recPos, recNrm, dupList } = this
    let c = this.recCount
    for (let k = start; k < end; k++) {
      const b = dupList[k]
      recVerts[c] = b
      recPos[c * 3] = positions[b * 3]
      recPos[c * 3 + 1] = positions[b * 3 + 1]
      recPos[c * 3 + 2] = positions[b * 3 + 2]
      recNrm[c * 3] = normals[b * 3]
      recNrm[c * 3 + 1] = normals[b * 3 + 1]
      recNrm[c * 3 + 2] = normals[b * 3 + 2]
      c++
    }
    this.recCount = c
  }

  private growRecord(needed: number): void {
    const size = Math.max(needed, this.recVerts.length * 2, 1024)
    const verts = new Uint32Array(size)
    verts.set(this.recVerts.subarray(0, this.recCount))
    const pos = new Float32Array(size * 3)
    pos.set(this.recPos.subarray(0, this.recCount * 3))
    const nrm = new Float32Array(size * 3)
    nrm.set(this.recNrm.subarray(0, this.recCount * 3))
    this.recVerts = verts
    this.recPos = pos
    this.recNrm = nrm
  }

  /** Expands the welded vertices dirtied by the current call to buffer indices. */
  private takeRegion(): DirtyRegion {
    const { callList, dupStart, dupList } = this
    let total = 0
    for (let i = 0; i < this.callCount; i++) {
      const w = callList[i]
      total += dupStart[w + 1] - dupStart[w]
    }
    if (total === 0) return emptyRegion()
    const vertices = new Uint32Array(total)
    let minIndex = Infinity
    let maxIndex = -1
    let c = 0
    for (let i = 0; i < this.callCount; i++) {
      const w = callList[i]
      for (let k = dupStart[w]; k < dupStart[w + 1]; k++) {
        const b = dupList[k]
        vertices[c++] = b
        if (b < minIndex) minIndex = b
        if (b > maxIndex) maxIndex = b
      }
    }
    return { vertices, minIndex, maxIndex }
  }
}

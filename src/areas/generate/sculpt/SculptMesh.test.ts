import assert from 'node:assert/strict'
import test from 'node:test'

import { SculptMesh } from './SculptMesh.ts'
import type { BrushKind, BrushSettings, DirtyRegion, SymmetryAxis, Vec3 } from './types.ts'
import { grid, gridMirror, seamSphere, splitCube, unindex } from './testMeshes.ts'

function brush(kind: BrushKind, radius: number, extra: Partial<BrushSettings> = {}): BrushSettings {
  return { kind, radius, strength: 1, invert: false, symmetry: [], ...extra }
}

function vec(arr: Float32Array, v: number): Vec3 {
  return [arr[v * 3], arr[v * 3 + 1], arr[v * 3 + 2]]
}

function nearestVertex(positions: Float32Array, p: Vec3): number {
  let best = -1
  let bestD = Infinity
  for (let v = 0; v < positions.length / 3; v++) {
    const d = (positions[v * 3] - p[0]) ** 2 + (positions[v * 3 + 1] - p[1]) ** 2 + (positions[v * 3 + 2] - p[2]) ** 2
    if (d < bestD) { bestD = d; best = v }
  }
  return best
}

function bitsEqual(a: Float32Array, b: Float32Array): boolean {
  const ua = new Uint32Array(a.buffer, a.byteOffset, a.length)
  const ub = new Uint32Array(b.buffer, b.byteOffset, b.length)
  if (ua.length !== ub.length) return false
  for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false
  return true
}

/** Asserts that every buffer vertex whose position or normal differs is listed in `region`. */
function assertRegionCovers(region: DirtyRegion, before: { p: Float32Array; n: Float32Array }, mesh: SculptMesh): void {
  const listed = new Set(region.vertices)
  let changed = 0
  for (let v = 0; v < mesh.vertexCount; v++) {
    let diff = false
    for (let k = 0; k < 3; k++) {
      if (!Object.is(before.p[v * 3 + k], mesh.positions[v * 3 + k])) diff = true
      if (!Object.is(before.n[v * 3 + k], mesh.normals[v * 3 + k])) diff = true
    }
    if (diff) {
      changed++
      assert.ok(listed.has(v), `changed vertex ${v} missing from the dirty region`)
    }
  }
  assert.ok(changed > 0, 'the stroke should change something')
  let min = Infinity
  let max = -Infinity
  for (const v of region.vertices) { min = Math.min(min, v); max = Math.max(max, v) }
  assert.equal(region.minIndex, min)
  assert.equal(region.maxIndex, max)
}

function snapshot(mesh: SculptMesh): { p: Float32Array; n: Float32Array } {
  return { p: mesh.positions.slice(), n: mesh.normals.slice() }
}

/** All buffer vertices sharing a welded position must hold identical positions and normals. */
function assertNoTear(mesh: SculptMesh, original: Float32Array): void {
  const groups = new Map<string, number[]>()
  for (let v = 0; v < mesh.vertexCount; v++) {
    const key = `${original[v * 3]},${original[v * 3 + 1]},${original[v * 3 + 2]}`
    const list = groups.get(key)
    if (list) list.push(v)
    else groups.set(key, [v])
  }
  for (const list of groups.values()) {
    for (const v of list.slice(1)) {
      assert.deepEqual(vec(mesh.positions, v), vec(mesh.positions, list[0]), `position of duplicate ${v} tore away`)
      assert.deepEqual(vec(mesh.normals, v), vec(mesh.normals, list[0]), `normal of duplicate ${v} differs`)
    }
  }
}

test('weld map merges the split vertices of a cube', () => {
  const cube = splitCube()
  const mesh = new SculptMesh(cube.positions, null, cube.index)
  assert.equal(mesh.vertexCount, 24)
  assert.equal(mesh.weldedVertexCount, 8)
  const soup = unindex(splitCube())
  assert.equal(new SculptMesh(soup.positions, null, null).weldedVertexCount, 8)
})

test('computed normals are smooth across the split faces of a corner and point outwards', () => {
  const cube = splitCube()
  const original = cube.positions.slice()
  const mesh = new SculptMesh(cube.positions, null, cube.index)
  for (let v = 0; v < 24; v++) {
    const p = vec(mesh.positions, v)
    const n = vec(mesh.normals, v)
    assert.ok(Math.abs(Math.hypot(...n) - 1) < 1e-6)
    assert.ok((n[0] * p[0] + n[1] * p[1] + n[2] * p[2]) / Math.sqrt(3) > 0.9, `normal of ${v} is not outward`)
  }
  assertNoTear(mesh, original)
  const s = seamSphere(16, 32, 4)
  const sphere = new SculptMesh(s.positions, null, s.index)
  for (let v = 0; v < sphere.vertexCount; v++) {
    const p = vec(sphere.positions, v)
    const n = vec(sphere.normals, v)
    assert.ok(n[0] * p[0] + n[1] * p[1] + n[2] * p[2] > 0.98, `sphere normal ${v} not radial`)
  }
})

test('grab on a cube corner moves its three duplicates identically', () => {
  const cube = splitCube()
  const original = cube.positions.slice()
  const mesh = new SculptMesh(cube.positions, null, cube.index)
  mesh.beginStroke(brush('grab', 0.5), [1, 1, 1], [1, 1, 1])
  mesh.strokeTo([1.5, 1.25, 1], [1, 1, 1])
  const record = mesh.endStroke()
  assert.ok(record)
  let moved = 0
  for (let v = 0; v < 24; v++) {
    if (original[v * 3] === 1 && original[v * 3 + 1] === 1 && original[v * 3 + 2] === 1) {
      assert.deepEqual(vec(mesh.positions, v), [1.5, 1.25, 1])
      moved++
    } else {
      assert.deepEqual(vec(mesh.positions, v), vec(original, v))
    }
  }
  assert.equal(moved, 3)
  assertNoTear(mesh, original)
  assert.equal(mesh.changed, true)
})

test('grab moves the centre by the delta and leaves vertices outside the radius untouched', () => {
  const g = grid(40)
  const original = g.positions.slice()
  const mesh = new SculptMesh(g.positions, null, g.index)
  assert.equal(mesh.changed, false)
  const centre = nearestVertex(original, [0, 0, 0])
  const region = mesh.beginStroke(brush('grab', 0.3), [0, 0, 0], [0, 0, 1])
  assert.equal(region.vertices.length, 0)
  mesh.strokeTo([0, 0, 0.1], [0, 0, 1])
  mesh.strokeTo([0, 0, 0.2], [0, 0, 1])
  mesh.endStroke()
  assert.ok(Math.abs(mesh.positions[centre * 3 + 2] - 0.2) < 1e-6)
  for (let v = 0; v < mesh.vertexCount; v++) {
    const d = Math.hypot(original[v * 3], original[v * 3 + 1])
    if (d >= 0.3) assert.deepEqual(vec(mesh.positions, v), vec(original, v))
    else if (d > 0) {
      const z = mesh.positions[v * 3 + 2]
      assert.ok(z > 0 && z < 0.2, `vertex at distance ${d} should move partially, z=${z}`)
    }
  }
})

test('grab at half strength moves the centre half the delta', () => {
  const g = grid(20)
  const mesh = new SculptMesh(g.positions, null, g.index)
  const centre = nearestVertex(g.positions, [0, 0, 0])
  mesh.beginStroke(brush('grab', 0.3, { strength: 0.5 }), [0, 0, 0], [0, 0, 1])
  mesh.strokeTo([0, 0, 0.2], [0, 0, 1])
  assert.ok(Math.abs(mesh.positions[centre * 3 + 2] - 0.1) < 1e-6)
})

test('smooth reduces a spike', () => {
  const g = grid(40)
  const centre = nearestVertex(g.positions, [0, 0, 0])
  g.positions[centre * 3 + 2] = 0.5
  const mesh = new SculptMesh(g.positions, null, g.index)
  mesh.beginStroke(brush('smooth', 0.3), [0, 0, 0.5], [0, 0, 1])
  mesh.strokeTo([0.02, 0, 0], [0, 0, 1])
  mesh.endStroke()
  assert.ok(mesh.positions[centre * 3 + 2] < 0.25, `spike still ${mesh.positions[centre * 3 + 2]}`)
})

test('inflate pushes a sphere outwards and invert pulls it in, without tearing seams', () => {
  for (const invert of [false, true]) {
    const s = seamSphere(32, 64, 4)
    const original = s.positions.slice()
    const mesh = new SculptMesh(s.positions, null, s.index)
    const v = nearestVertex(original, [1, 0, 0])
    mesh.beginStroke(brush('inflate', 0.4, { invert }), [1, 0, 0], [1, 0, 0])
    mesh.strokeTo([1, 0.1, 0], [1, 0, 0])
    mesh.endStroke()
    const r = Math.hypot(...vec(mesh.positions, v))
    if (invert) assert.ok(r < 0.99, `deflate should shrink, r=${r}`)
    else assert.ok(r > 1.01, `inflate should grow, r=${r}`)
    assertNoTear(mesh, original)
  }
})

test('flatten reduces the spread of distances to the plane, invert increases it', () => {
  const height = (x: number, y: number) => 0.05 * Math.sin(12 * x) * Math.cos(12 * y)
  const spread = (positions: Float32Array) => {
    let sum = 0
    let sq = 0
    let count = 0
    for (let v = 0; v < positions.length / 3; v++) {
      if (Math.hypot(positions[v * 3], positions[v * 3 + 1]) > 0.2) continue
      const z = positions[v * 3 + 2]
      sum += z
      sq += z * z
      count++
    }
    return sq / count - (sum / count) ** 2
  }
  for (const invert of [false, true]) {
    const g = grid(60, height)
    const before = spread(g.positions)
    const mesh = new SculptMesh(g.positions, null, g.index)
    mesh.beginStroke(brush('flatten', 0.4, { invert, strength: 0.5 }), [0, 0, 0], [0, 0, 1])
    mesh.strokeTo([0.05, 0, 0], [0, 0, 1])
    mesh.endStroke()
    const after = spread(mesh.positions)
    if (invert) assert.ok(after > before * 1.1, `invert flatten should roughen: ${before} → ${after}`)
    else assert.ok(after < before * 0.5, `flatten should flatten: ${before} → ${after}`)
  }
})

test('symmetry across x gives a mirror-symmetric result for every brush', () => {
  const n = 40
  const height = (x: number, y: number) => 0.3 * x * x * y + 0.08 * Math.sin(7 * y) + 0.05 * Math.cos(9 * x * x)
  const kinds: BrushKind[] = ['grab', 'smooth', 'inflate', 'flatten']
  for (const kind of kinds) {
    const g = grid(n, height)
    const mesh = new SculptMesh(g.positions, null, g.index)
    assert.ok(Math.abs(mesh.symmetryCenter[0]) < 1e-7)
    const settings = brush(kind, 0.45, { symmetry: ['x'] as SymmetryAxis[], strength: 0.8 })
    // Starts near the plane so the mirrored dabs overlap.
    mesh.beginStroke(settings, [0.12, 0.05, height(0.12, 0.05)], [0, 0, 1])
    if (kind === 'grab') {
      mesh.strokeTo([0.3, 0.1, 0.2], [0, 0, 1])
    } else {
      mesh.strokeTo([0.35, 0.3, height(0.35, 0.3)], [0, 0, 1])
    }
    mesh.endStroke()
    for (let v = 0; v < mesh.vertexCount; v++) {
      const m = gridMirror(n, v)
      const p = vec(mesh.positions, v)
      const q = vec(mesh.positions, m)
      assert.ok(Math.abs(p[0] + q[0]) < 1e-5 && Math.abs(p[1] - q[1]) < 1e-5 && Math.abs(p[2] - q[2]) < 1e-5,
        `${kind}: vertex ${v} ${p} is not the mirror of ${m} ${q}`)
      const nv = vec(mesh.normals, v)
      const nm = vec(mesh.normals, m)
      assert.ok(Math.abs(nv[0] + nm[0]) < 1e-4 && Math.abs(nv[1] - nm[1]) < 1e-4 && Math.abs(nv[2] - nm[2]) < 1e-4,
        `${kind}: normal of ${v} is not mirrored`)
    }
    assert.ok(mesh.changed, `${kind} should change the mesh`)
  }
})

test('a dab on the symmetry plane is not applied twice', () => {
  const height = (x: number, y: number) => 0.1 * Math.sin(5 * y) + 0.1 * x * x
  for (const kind of ['inflate', 'smooth', 'flatten'] as BrushKind[]) {
    const a = grid(30, height)
    const b = grid(30, height)
    const plain = new SculptMesh(a.positions, null, a.index)
    const mirrored = new SculptMesh(b.positions, null, b.index)
    plain.beginStroke(brush(kind, 0.4), [0, 0.1, height(0, 0.1)], [0, 0, 1])
    mirrored.beginStroke(brush(kind, 0.4, { symmetry: ['x'] }), [0, 0.1, height(0, 0.1)], [0, 0, 1])
    for (let v = 0; v < plain.positions.length; v++) {
      assert.ok(Math.abs(plain.positions[v] - mirrored.positions[v]) < 1e-6, `${kind}: component ${v} differs`)
    }
  }
  // Grab on the plane: a delta along the plane is followed once, not twice.
  const g = grid(30)
  const mesh = new SculptMesh(g.positions, null, g.index)
  const centre = nearestVertex(g.positions, [0, 0, 0])
  mesh.beginStroke(brush('grab', 0.3, { symmetry: ['x'] }), [0, 0, 0], [0, 0, 1])
  mesh.strokeTo([0.2, 0.1, 0.2], [0, 0, 1])
  assert.deepEqual(vec(mesh.positions, centre).map((c) => Math.round(c * 1e6) / 1e6), [0, 0.1, 0.2])
})

test('symmetry on several axes mirrors every combination', () => {
  const s = seamSphere(24, 48, 2)
  const mesh = new SculptMesh(s.positions, null, s.index)
  const p: Vec3 = [Math.SQRT1_2, 0.5, 0.5]
  const before = s.positions.slice()
  mesh.beginStroke(brush('inflate', 0.3, { symmetry: ['x', 'y', 'z'] }), p, p)
  for (const sx of [1, -1]) for (const sy of [1, -1]) for (const sz of [1, -1]) {
    const v = nearestVertex(before, [p[0] * sx, p[1] * sy, p[2] * sz])
    assert.ok(Math.hypot(...vec(mesh.positions, v)) > 1.005, `octant ${sx},${sy},${sz} not inflated`)
  }
})

test('undo restores positions and normals bit-exactly and the inverse redoes', () => {
  const s = seamSphere(32, 64, 4)
  const mesh = new SculptMesh(s.positions, null, s.index)
  const before = snapshot(mesh)
  mesh.beginStroke(brush('inflate', 0.5, { symmetry: ['x'] }), [1, 0, 0], [1, 0, 0])
  mesh.strokeTo([0.9, 0.43, 0], [1, 0, 0])
  mesh.strokeTo([0.7, 0.7, 0], [1, 0, 0])
  const record = mesh.endStroke()
  assert.ok(record)
  const after = snapshot(mesh)
  assert.ok(!bitsEqual(before.p, after.p))

  const undo = mesh.restore(record)
  assert.ok(bitsEqual(mesh.positions, before.p), 'positions not restored')
  assert.ok(bitsEqual(mesh.normals, before.n), 'normals not restored')
  assert.ok(undo.region.vertices.length > 0)

  const redo = mesh.restore(undo.inverse)
  assert.ok(bitsEqual(mesh.positions, after.p), 'positions not redone')
  assert.ok(bitsEqual(mesh.normals, after.n), 'normals not redone')

  mesh.restore(redo.inverse)
  assert.ok(bitsEqual(mesh.positions, before.p))

  // The spatial index follows restore: a grab right after undo still finds the vertices.
  const v = nearestVertex(before.p, [1, 0, 0])
  mesh.beginStroke(brush('grab', 0.2), [1, 0, 0], [1, 0, 0])
  mesh.strokeTo([1.2, 0, 0], [1, 0, 0])
  assert.ok(Math.abs(mesh.positions[v * 3] - 1.2) < 1e-6)
})

test('grab undo after a far move restores everything', () => {
  const g = grid(30)
  const mesh = new SculptMesh(g.positions, null, g.index)
  const before = snapshot(mesh)
  mesh.beginStroke(brush('grab', 0.3), [0, 0, 0], [0, 0, 1])
  mesh.strokeTo([5, 5, 5], [0, 0, 1])
  const record = mesh.endStroke()
  assert.ok(record)
  mesh.restore(record)
  assert.ok(bitsEqual(mesh.positions, before.p))
  assert.ok(bitsEqual(mesh.normals, before.n))
})

test('the spatial index follows vertices moved far by grab', () => {
  const g = grid(30)
  const mesh = new SculptMesh(g.positions, null, g.index)
  const centre = nearestVertex(g.positions, [0, 0, 0])
  mesh.beginStroke(brush('grab', 0.3), [0, 0, 0], [0, 0, 1])
  mesh.strokeTo([0, 0, 3], [0, 0, 1])
  mesh.endStroke()
  // Grab again at the new location: the moved centre must be found there.
  mesh.beginStroke(brush('grab', 0.1), [0, 0, 3], [0, 0, 1])
  mesh.strokeTo([0, 0, 4], [0, 0, 1])
  mesh.endStroke()
  assert.ok(Math.abs(mesh.positions[centre * 3 + 2] - 4) < 1e-5)
})

test('the dirty region lists every changed buffer vertex', () => {
  const kinds: BrushKind[] = ['grab', 'smooth', 'inflate', 'flatten']
  for (const kind of kinds) {
    const s = seamSphere(32, 64, 4)
    const mesh = new SculptMesh(s.positions, null, s.index)
    let before = snapshot(mesh)
    const settings = brush(kind, 0.35, { symmetry: ['z'] })
    const start = mesh.beginStroke(settings, [1, 0, 0], [1, 0, 0])
    if (kind !== 'grab') assertRegionCovers(start, before, mesh)
    before = snapshot(mesh)
    const region = mesh.strokeTo(kind === 'grab' ? [1.2, 0.1, 0.05] : [0.8, 0.6, 0], [1, 0, 0])
    assertRegionCovers(region, before, mesh)
    const record = mesh.endStroke()
    assert.ok(record)
    before = snapshot(mesh)
    const { region: undoRegion } = mesh.restore(record)
    assertRegionCovers(undoRegion, before, mesh)
  }
})

test('a stroke that touches nothing returns no record', () => {
  const g = grid(10)
  const mesh = new SculptMesh(g.positions, null, g.index)
  const region = mesh.beginStroke(brush('inflate', 0.1), [10, 10, 10], [0, 0, 1])
  assert.equal(region.vertices.length, 0)
  mesh.strokeTo([10, 10.5, 10], [0, 0, 1])
  assert.equal(mesh.endStroke(), null)
  assert.equal(mesh.changed, false)
})

test('provided normals are kept until a stroke recomputes them, and are written to', () => {
  const g = grid(10)
  const normals = new Float32Array(g.positions.length)
  for (let v = 0; v < normals.length / 3; v++) normals[v * 3 + 2] = 1
  const mesh = new SculptMesh(g.positions, normals, g.index)
  assert.equal(mesh.normals, normals)
  assert.equal(mesh.positions, g.positions)
  mesh.beginStroke(brush('grab', 0.5), [0, 0, 0], [0, 0, 1])
  mesh.strokeTo([0, 0, 0.3], [0, 0, 1])
  const v = nearestVertex(g.positions, [0.2, 0, 0.2])
  assert.ok(normals[v * 3] > 0.05, 'normal on the slope of the bump should tilt')
})

test('Uint16 indices and dab spacing along a long stroke', () => {
  const g = grid(30)
  const index = Uint16Array.from(g.index!)
  const mesh = new SculptMesh(g.positions, null, index)
  const before = g.positions.slice()
  mesh.beginStroke(brush('inflate', 0.1), [-0.8, 0, 0], [0, 0, 1])
  mesh.strokeTo([0.8, 0, 0], [0, 0, 1])
  // Dabs are spaced along the segment: every vertex on the path rose.
  for (const x of [-0.5, -0.2, 0, 0.3, 0.6]) {
    const v = nearestVertex(before, [x, 0, 0])
    assert.ok(mesh.positions[v * 3 + 2] > 0.001, `no dab near x=${x}`)
  }
})

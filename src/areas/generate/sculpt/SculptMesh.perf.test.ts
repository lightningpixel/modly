import assert from 'node:assert/strict'
import test from 'node:test'

import { DAB_SPACING, SculptMesh } from './SculptMesh.ts'
import type { BrushKind, BrushSettings, Vec3 } from './types.ts'
import { seamSphere } from './testMeshes.ts'

// Targets: constructor < 1.5 s, one dab over ~2k vertices < 4 ms, a grab
// strokeTo over ~10k vertices < 8 ms. Asserted with a 3× margin so slow CI
// machines do not flake; the measured timings are printed.

function countWithin(positions: Float32Array, p: Vec3, r: number): number {
  let c = 0
  for (let v = 0; v < positions.length / 3; v++) {
    const d = (positions[v * 3] - p[0]) ** 2 + (positions[v * 3 + 1] - p[1]) ** 2 + (positions[v * 3 + 2] - p[2]) ** 2
    if (d < r * r) c++
  }
  return c
}

function brush(kind: BrushKind, radius: number): BrushSettings {
  return { kind, radius, strength: 0.5, invert: false, symmetry: [] }
}

test('performance on a ~1M-triangle mesh with seam duplicates', () => {
  // Warm the JIT on a small mesh first.
  const small = seamSphere(40, 80, 8)
  const warm = new SculptMesh(small.positions, null, small.index)
  for (const kind of ['inflate', 'smooth', 'flatten', 'grab'] as BrushKind[]) {
    warm.beginStroke(brush(kind, 0.3), [1, 0, 0], [1, 0, 0])
    for (let i = 1; i <= 20; i++) warm.strokeTo([1, 0.01 * i, 0], [1, 0, 0])
    warm.endStroke()
  }

  const big = seamSphere(500, 1000, 8)
  const triangles = big.index!.length / 3
  const t0 = performance.now()
  const mesh = new SculptMesh(big.positions, null, big.index)
  const buildMs = performance.now() - t0
  console.log(`[sculpt perf] ${triangles} triangles, ${mesh.vertexCount} buffer / ${mesh.weldedVertexCount} welded vertices: constructor ${buildMs.toFixed(0)} ms`)
  assert.ok(triangles >= 1_000_000)
  assert.ok(mesh.weldedVertexCount < mesh.vertexCount)
  assert.ok(buildMs < 4500, `constructor took ${buildMs.toFixed(0)} ms`)

  const a = 0.3
  const centre: Vec3 = [Math.cos(a), 0, Math.sin(a)]
  const dabRadius = 0.18
  const dabVerts = countWithin(big.positions, centre, dabRadius)
  for (const kind of ['inflate', 'smooth', 'flatten'] as BrushKind[]) {
    const settings = brush(kind, dabRadius)
    const step = dabRadius * DAB_SPACING
    mesh.beginStroke(settings, centre, centre)
    // Each strokeTo moves along the equator by a chord just over one spacing,
    // so it places exactly one dab.
    const dTheta = 2 * Math.asin((step * 1.001) / 2)
    const times: number[] = []
    let touched = 0
    for (let i = 1; i <= 30; i++) {
      const p: Vec3 = [Math.cos(a + dTheta * i), 0, Math.sin(a + dTheta * i)]
      const t = performance.now()
      const region = mesh.strokeTo(p, p)
      times.push(performance.now() - t)
      touched = Math.min(touched || Infinity, region.vertices.length)
    }
    assert.ok(touched > 2000, `every dab should touch ~2k+ vertices (min ${touched})`)
    mesh.endStroke()
    times.sort((x, y) => x - y)
    const median = times[times.length >> 1]
    console.log(`[sculpt perf] ${kind} dab over ~${dabVerts} vertices: median ${median.toFixed(2)} ms, max ${times[times.length - 1].toFixed(2)} ms`)
    assert.ok(median < 12, `${kind} dab took ${median.toFixed(2)} ms`)
  }

  const grabRadius = 0.4
  const grabVerts = countWithin(big.positions, centre, grabRadius)
  mesh.beginStroke({ ...brush('grab', grabRadius), strength: 1 }, centre, centre)
  const times: number[] = []
  for (let i = 1; i <= 20; i++) {
    const t = performance.now()
    mesh.strokeTo([centre[0] + 0.01 * i, centre[1], centre[2]], centre)
    times.push(performance.now() - t)
  }
  const record = mesh.endStroke()
  times.sort((x, y) => x - y)
  const median = times[times.length >> 1]
  console.log(`[sculpt perf] grab strokeTo over ~${grabVerts} vertices: median ${median.toFixed(2)} ms, max ${times[times.length - 1].toFixed(2)} ms`)
  assert.ok(grabVerts > 10_000)
  assert.ok(median < 24, `grab strokeTo took ${median.toFixed(2)} ms`)

  const t1 = performance.now()
  mesh.restore(record!)
  console.log(`[sculpt perf] restore of the grab stroke: ${(performance.now() - t1).toFixed(2)} ms`)
})

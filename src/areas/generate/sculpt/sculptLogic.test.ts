import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RADIUS_MAX,
  RADIUS_MIN,
  SCULPT_MAX_TRIANGLES,
  attributeUpdateRange,
  buildVertexPatch,
  bytesToBase64,
  clampRadius,
  emptyHistory,
  float32ToBase64,
  isHistoryDirty,
  mergeRange,
  pushStroke,
  redoStroke,
  sculptBlock,
  sculptKeyAction,
  sessionEndOutcome,
  stepRadius,
  toLocalRadius,
  undoStroke,
  worldRadius,
  type KeyLike,
} from './sculptLogic.ts'

// ─── Availability ────────────────────────────────────────────────────────────

test('sculptBlock allows a loaded GLB under the triangle limit', () => {
  assert.equal(sculptBlock({ meshUrl: '/workspace/a/mesh.glb', generating: false, triangles: 10_000 }), null)
  assert.equal(sculptBlock({ meshUrl: '/workspace/a/mesh.glb', generating: false, triangles: SCULPT_MAX_TRIANGLES }), null)
})

test('sculptBlock rejects missing models, generation, OBJ and splats', () => {
  assert.match(sculptBlock({ meshUrl: undefined, generating: false, triangles: null })!.reason, /Generate, import or open/)
  assert.match(sculptBlock({ meshUrl: '/workspace/a/mesh.glb', generating: true, triangles: 10 })!.reason, /Generating/)
  assert.match(sculptBlock({ meshUrl: '/workspace/a/mesh.OBJ', generating: false, triangles: 10 })!.reason, /OBJ/)
  assert.match(sculptBlock({ meshUrl: '/workspace/a/s.ply', generating: false, triangles: 10 })!.reason, /splat/)
})

test('sculptBlock names the triangle count of a mesh that is too big', () => {
  const block = sculptBlock({ meshUrl: '/workspace/a/mesh.glb', generating: false, triangles: 3_500_000 })
  assert.equal(block?.transient, false)
  assert.equal(
    block?.reason,
    'This mesh has too many triangles to sculpt (3,500,000). Decimate it or use Prepare for Game first.',
  )
})

test('sculptBlock treats a loading mesh as transient', () => {
  const block = sculptBlock({ meshUrl: '/workspace/a/mesh.glb', generating: false, triangles: null })
  assert.equal(block?.transient, true)
})

// ─── Radius ──────────────────────────────────────────────────────────────────

test('radius is clamped and stepped geometrically', () => {
  assert.equal(clampRadius(0), RADIUS_MIN)
  assert.equal(clampRadius(10), RADIUS_MAX)
  assert.equal(clampRadius(Number.NaN), 0.05)
  assert.equal(stepRadius(0.05, 1), 0.0625)
  assert.equal(stepRadius(0.05, -1), 0.04)
  assert.equal(stepRadius(RADIUS_MAX, 1), RADIUS_MAX)
  assert.equal(stepRadius(RADIUS_MIN, -1), RADIUS_MIN)
})

test('world radius scales with the model and local radius undoes the world scale', () => {
  assert.equal(worldRadius(0.1, 2), 0.2)
  assert.equal(toLocalRadius(0.2, 4), 0.05)
  assert.equal(toLocalRadius(0.2, 0), 0.2)
})

// ─── History ─────────────────────────────────────────────────────────────────

test('undo and redo swap entries through apply and keep the stacks in step', () => {
  let h = pushStroke(pushStroke(emptyHistory<string>(), 'a'), 'b')
  assert.deepEqual(h, { undo: ['a', 'b'], redo: [], truncated: false })
  assert.equal(isHistoryDirty(h), true)

  const applied: string[] = []
  h = undoStroke(h, (e) => { applied.push(e); return `${e}'` })
  assert.deepEqual(h, { undo: ['a'], redo: ["b'"], truncated: false })
  h = undoStroke(h, (e) => { applied.push(e); return `${e}'` })
  assert.equal(isHistoryDirty(h), false)
  assert.equal(undoStroke(h, () => assert.fail('nothing to undo')), h)

  h = redoStroke(h, (e) => { applied.push(e); return e.replace("'", '') })
  assert.deepEqual(h.undo, ['a'])
  assert.deepEqual(applied, ['b', 'a', "a'"])
})

test('a new stroke clears the redo stack', () => {
  let h = pushStroke(emptyHistory<string>(), 'a')
  h = undoStroke(h, (e) => e)
  h = pushStroke(h, 'c')
  assert.deepEqual(h, { undo: ['c'], redo: [], truncated: false })
})

test('a failing apply leaves the history untouched', () => {
  const h = pushStroke(emptyHistory<string>(), 'a')
  assert.throws(() => undoStroke(h, () => { throw new Error('boom') }), /boom/)
  assert.deepEqual(h.undo, ['a'])
})

test('strokes over the limit fall off and keep the mesh dirty', () => {
  let h = emptyHistory<number>()
  for (let i = 0; i < 4; i++) h = pushStroke(h, i, 3)
  assert.deepEqual(h.undo, [1, 2, 3])
  assert.equal(h.truncated, true)
  for (let i = 0; i < 3; i++) h = undoStroke(h, (e) => e)
  assert.equal(h.undo.length, 0)
  assert.equal(isHistoryDirty(h), true)
})

// ─── Ranges ──────────────────────────────────────────────────────────────────

test('dirty ranges merge and map to attribute update ranges', () => {
  let r = mergeRange(null, { min: 10, max: 20 })
  r = mergeRange(r, { min: 4, max: 12 })
  assert.deepEqual(r, { min: 4, max: 20 })
  assert.deepEqual(mergeRange(r, { min: 1, max: 0 }), r) // empty region
  assert.equal(mergeRange(null, { min: 0, max: -1 }), null)
  assert.deepEqual(attributeUpdateRange({ min: 4, max: 20 }, 3), { start: 12, count: 51 })
})

// ─── Encoding ────────────────────────────────────────────────────────────────

test('bytesToBase64 matches Buffer on sizes around the chunk boundary', () => {
  for (const size of [0, 1, 2, 3, 32_765, 32_766, 32_767, 100_003]) {
    const bytes = new Uint8Array(size)
    for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) & 0xff
    assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'), `size ${size}`)
  }
})

test('float32ToBase64 encodes only the view, little-endian', () => {
  const backing = new Float32Array([9, 1.5, -2, 9])
  const view = backing.subarray(1, 3)
  const expected = Buffer.alloc(8)
  expected.writeFloatLE(1.5, 0)
  expected.writeFloatLE(-2, 4)
  assert.equal(float32ToBase64(view), expected.toString('base64'))
})

test('buildVertexPatch maps the glTF association to a patch', () => {
  const positions = new Float32Array([1, 2, 3])
  const normals = new Float32Array([0, 0, 1])
  assert.deepEqual(buildVertexPatch({ meshes: 2, primitives: 1 }, positions, normals), {
    mesh: 2,
    primitive: 1,
    positions: float32ToBase64(positions),
    normals: float32ToBase64(normals),
  })
  assert.equal(buildVertexPatch({ meshes: 0, primitives: 0 }, positions, null)?.normals, undefined)
  assert.equal(buildVertexPatch(undefined, positions, normals), null)
  assert.equal(buildVertexPatch({ nodes: 3 } as { meshes?: number }, positions, normals), null)
})

// ─── Session end ─────────────────────────────────────────────────────────────

test('sessionEndOutcome saves when the same mesh is shown and drops otherwise', () => {
  assert.equal(sessionEndOutcome(false, '/workspace/a.glb', '/workspace/b.glb'), 'none')
  assert.equal(sessionEndOutcome(true, '/workspace/a.glb', '/workspace/a.glb'), 'commit')
  assert.equal(sessionEndOutcome(true, '/workspace/a.glb', '/workspace/b.glb'), 'discard')
  assert.equal(sessionEndOutcome(true, '/workspace/a.glb', undefined), 'discard')
})

// ─── Shortcuts ───────────────────────────────────────────────────────────────

function key(k: string, mods: Partial<KeyLike> = {}): KeyLike {
  return { key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods }
}

test('sculptKeyAction maps the sculpt shortcuts', () => {
  assert.deepEqual(sculptKeyAction(key('z', { ctrlKey: true })), { type: 'undo' })
  assert.deepEqual(sculptKeyAction(key('Z', { ctrlKey: true, shiftKey: true })), { type: 'redo' })
  assert.deepEqual(sculptKeyAction(key('y', { metaKey: true })), { type: 'redo' })
  assert.deepEqual(sculptKeyAction(key('Escape')), { type: 'exit' })
  assert.deepEqual(sculptKeyAction(key('f')), { type: 'radius', direction: 1 })
  assert.deepEqual(sculptKeyAction(key('F', { shiftKey: true })), { type: 'radius', direction: -1 })
  assert.deepEqual(sculptKeyAction(key('g')), { type: 'brush', kind: 'grab' })
  assert.deepEqual(sculptKeyAction(key('s')), { type: 'brush', kind: 'smooth' })
  assert.deepEqual(sculptKeyAction(key('i')), { type: 'brush', kind: 'inflate' })
  assert.deepEqual(sculptKeyAction(key('t')), { type: 'brush', kind: 'flatten' })
})

test('sculptKeyAction ignores other keys and modified brush keys', () => {
  assert.equal(sculptKeyAction(key('w')), null)
  assert.equal(sculptKeyAction(key('r')), null)
  assert.equal(sculptKeyAction(key('s', { ctrlKey: true })), null)
  assert.equal(sculptKeyAction(key('g', { altKey: true })), null)
  assert.equal(sculptKeyAction(key('S', { shiftKey: true })), null)
})

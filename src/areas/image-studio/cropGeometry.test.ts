import test from 'node:test'
import assert from 'node:assert/strict'
import {
  aspectRatio, cropEdges, dragRect, fitToRatio, fullRect, isFullRect, minCropSize, type Rect,
} from './cropGeometry'

const S = { width: 200, height: 100 }
const sub = (r: Rect, keys: (keyof Rect)[]) => Object.fromEntries(keys.map((k) => [k, r[k]]))

test('fullRect covers the image and isFullRect recognizes it', () => {
  assert.deepEqual(fullRect(S), { x: 0, y: 0, w: 200, h: 100 })
  assert.equal(isFullRect(fullRect(S), S), true)
  assert.equal(isFullRect({ x: 1, y: 0, w: 199, h: 100 }, S), false)
})

test('move translates and clamps inside the image', () => {
  const start = { x: 10, y: 10, w: 100, h: 50 }
  assert.deepEqual(dragRect(start, 'move', 50, 50, S, null), { x: 60, y: 50, w: 100, h: 50 })
  assert.equal(dragRect(start, 'move', 500, 0, S, null).x, 100)
  assert.equal(dragRect(start, 'move', -500, -500, S, null).x, 0)
})

test('free edge handles move only the dragged edge', () => {
  const sq = { x: 0, y: 0, w: 100, h: 100 }
  assert.equal(dragRect(sq, 'e', 30, 0, S, null).w, 130)
  assert.deepEqual(sub(dragRect(sq, 'w', 95, 0, S, null), ['x', 'w']), { x: 84, w: 16 })
})

test('free corners clamp to the image and respect the opposite corner', () => {
  const r = dragRect({ x: 0, y: 0, w: 50, h: 50 }, 'se', 500, 500, S, null)
  assert.deepEqual(sub(r, ['w', 'h']), { w: 200, h: 100 })
  assert.deepEqual(dragRect({ x: 10, y: 10, w: 50, h: 50 }, 'nw', -20, -20, S, null), { x: 0, y: 0, w: 60, h: 60 })
})

test('ratio corner uses the larger proposed dimension and fits the image', () => {
  const start = { x: 0, y: 0, w: 50, h: 50 }
  assert.deepEqual(sub(dragRect(start, 'se', 40, 10, S, 1), ['w', 'h']), { w: 90, h: 90 })
  assert.deepEqual(sub(dragRect(start, 'se', 300, 300, S, 1), ['w', 'h']), { w: 100, h: 100 })
})

test('ratio edge changes one dimension and centers the other', () => {
  const r = dragRect({ x: 50, y: 25, w: 50, h: 50 }, 'e', 20, 0, S, 1)
  assert.deepEqual(sub(r, ['x', 'w', 'h']), { x: 50, w: 70, h: 70 })
  assert.ok(r.y >= 0 && r.y <= 30)
  assert.equal(r.y, 15)
})

test('fitToRatio and aspectRatio', () => {
  assert.deepEqual(fitToRatio({ x: 0, y: 0, w: 200, h: 100 }, 1, S), { x: 50, y: 0, w: 100, h: 100 })
  const rect = { x: 5, y: 5, w: 30, h: 20 }
  assert.equal(fitToRatio(rect, null, S), rect)
  assert.equal(aspectRatio('original', S), 2)
  assert.equal(aspectRatio('free', S), null)
  assert.equal(aspectRatio('square', S), 1)
})

test('cropEdges returns percentages', () => {
  assert.deepEqual(cropEdges({ x: 20, y: 10, w: 100, h: 50 }, S), { left: 10, top: 10, right: 40, bottom: 40 })
})

test('min size never exceeds a tiny image', () => {
  const tiny = { width: 8, height: 4 }
  assert.deepEqual(minCropSize(tiny), { w: 8, h: 4 })
  assert.deepEqual(sub(dragRect(fullRect(tiny), 'w', 100, 0, tiny, null), ['x', 'w']), { x: 0, w: 8 })
})

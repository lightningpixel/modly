import assert from 'node:assert/strict'
import test from 'node:test'

import { computeGridLayout, moveGridIndex, scrollTopToReveal, visibleRowRange } from './gridWindow'

test('grid columns stretch to fill the width and rows are square tiles plus the label', () => {
  const layout = computeGridLayout({ width: 1000, itemCount: 500, gap: 16, minColumnWidth: 160, labelHeight: 40 })
  assert.equal(layout.columns, 5)
  assert.equal(layout.columnWidth, 187)
  assert.equal(layout.rowHeight, 227)
  assert.equal(layout.rowStride, 243)
  assert.equal(layout.rowCount, 100)
  assert.equal(layout.totalHeight, 100 * 227 + 99 * 16)
})

test('grid layout degrades gracefully: one column when narrow, nothing when empty', () => {
  const narrow = computeGridLayout({ width: 100, itemCount: 3, gap: 16, minColumnWidth: 160, labelHeight: 40 })
  assert.equal(narrow.columns, 1)
  assert.equal(narrow.rowCount, 3)
  const empty = computeGridLayout({ width: 0, itemCount: 0, gap: 16, minColumnWidth: 160 })
  assert.equal(empty.rowCount, 0)
  assert.equal(empty.totalHeight, 0)
})

test('a fixed row height gives a list layout', () => {
  const list = computeGridLayout({ width: 800, itemCount: 10, gap: 2, minColumnWidth: Number.MAX_SAFE_INTEGER, rowHeight: 52 })
  assert.equal(list.columns, 1)
  assert.equal(list.columnWidth, 800)
  assert.equal(list.rowStride, 54)
  assert.equal(list.totalHeight, 10 * 52 + 9 * 2)
})

test('only rows near the viewport are rendered, whatever the library size', () => {
  const layout = { rowStride: 100, rowCount: 1000 }
  assert.deepEqual(visibleRowRange(layout, 0, 350, 2), { start: 0, end: 6 })
  assert.deepEqual(visibleRowRange(layout, 5000, 350, 2), { start: 48, end: 56 })
  assert.deepEqual(visibleRowRange(layout, 99_950, 350, 2), { start: 997, end: 1000 })
  assert.deepEqual(visibleRowRange({ rowStride: 100, rowCount: 0 }, 0, 350), { start: 0, end: 0 })
  assert.deepEqual(visibleRowRange(layout, -40, 0, 0), { start: 0, end: 1 })
})

test('scrollTopToReveal scrolls the least needed to show a row', () => {
  const layout = { rowStride: 110, rowHeight: 100 }
  assert.equal(scrollTopToReveal(layout, 2, 0, 400), null)
  assert.equal(scrollTopToReveal(layout, 5, 0, 400), 550 + 100 - 400)
  assert.equal(scrollTopToReveal(layout, 1, 500, 400), 110)
})

test('arrow keys move through the grid and stay in bounds', () => {
  assert.equal(moveGridIndex(0, 'ArrowRight', 4, 10), 1)
  assert.equal(moveGridIndex(0, 'ArrowLeft', 4, 10), 0)
  assert.equal(moveGridIndex(1, 'ArrowDown', 4, 10), 5)
  assert.equal(moveGridIndex(8, 'ArrowDown', 4, 10), 9)
  assert.equal(moveGridIndex(5, 'ArrowUp', 4, 10), 1)
  assert.equal(moveGridIndex(5, 'End', 4, 10), 9)
  assert.equal(moveGridIndex(5, 'Home', 4, 10), 0)
  assert.equal(moveGridIndex(-1, 'ArrowDown', 4, 10), 0)
  assert.equal(moveGridIndex(3, 'a', 4, 10), null)
  assert.equal(moveGridIndex(0, 'ArrowDown', 4, 0), null)
})

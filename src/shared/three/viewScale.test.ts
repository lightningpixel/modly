import test from 'node:test'
import assert from 'node:assert/strict'
import { viewScaleFor } from './viewScale'

test('a generated, unit-sized mesh keeps the default view', () => {
  assert.equal(viewScaleFor(1), 1)
  assert.equal(viewScaleFor(2), 1)
  assert.equal(viewScaleFor(0.3), 1)
})

test('an imported 30 mm part (0.03 m) is framed instead of being a speck', () => {
  assert.equal(viewScaleFor(0.03), 0.015)
})

test('a very large model is framed from further away', () => {
  assert.equal(viewScaleFor(180), 90)
})

test('an empty or broken size keeps the default view', () => {
  assert.equal(viewScaleFor(0), 1)
  assert.equal(viewScaleFor(Number.NaN), 1)
})

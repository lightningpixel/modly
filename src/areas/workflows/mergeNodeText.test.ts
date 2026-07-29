import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeNodeText } from './mergeNodeText'

const CREATURE =
  'A photographic creature, rounded volumetric body, limbs curling in depth, ' +
  'wet specular skin, dark studio background.'
const NOTE =
  'Keep the left tentacle shorter than the others; preserve the inked eye rings exactly.'

test('the artist note is added to the style, not swapped for it', () => {
  const merged = mergeNodeText(CREATURE, NOTE)
  assert.ok(merged.includes('photographic creature'), 'style direction survives')
  assert.ok(merged.includes('left tentacle shorter'), 'artist note survives')
})

test('this is the exact run that came out flat', () => {
  // Before the fix the generator received only the note — a description of a
  // drawing — and made a flat card. The regression this file guards.
  const merged = mergeNodeText(CREATURE, NOTE)
  assert.notEqual(merged, NOTE)
})

test('a Custom style carries no direction, so the note is the whole prompt', () => {
  assert.equal(mergeNodeText('', NOTE), NOTE)
  assert.equal(mergeNodeText(undefined, NOTE), NOTE)
})

test('no note leaves the style untouched', () => {
  assert.equal(mergeNodeText(CREATURE, ''), CREATURE)
  assert.equal(mergeNodeText(CREATURE, '   '), CREATURE)
})

test('nothing is said twice', () => {
  assert.equal(mergeNodeText(NOTE, NOTE), NOTE)
  assert.equal(mergeNodeText(`${CREATURE} ${NOTE}`, NOTE), `${CREATURE} ${NOTE}`)
})

test('one sentence break between them, however the style was punctuated', () => {
  assert.equal(mergeNodeText('Low poly.', 'Red.'), 'Low poly. Red.')
  assert.equal(mergeNodeText('Low poly', 'Red.'), 'Low poly. Red.')
  assert.equal(mergeNodeText('Low poly.   ', 'Red.'), 'Low poly. Red.')
})

test('non-string params are tolerated rather than crashing a run', () => {
  assert.equal(mergeNodeText(null, NOTE), NOTE)
  assert.equal(mergeNodeText(42, NOTE), NOTE)
  assert.equal(mergeNodeText(CREATURE, null), CREATURE)
})

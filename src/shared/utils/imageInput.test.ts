import test from 'node:test'
import assert from 'node:assert/strict'
import { clipboardImage, isTextEntryTarget } from './imageInput'

const item = (kind: string, type: string, file: unknown = { name: type }) => ({ kind, type, getAsFile: () => file as File })

test('clipboardImage returns the first supported image file', () => {
  assert.equal(clipboardImage(null), null)
  assert.equal(clipboardImage({ items: [item('string', 'text/plain')] }), null)
  assert.equal(clipboardImage({ items: [item('file', 'image/gif')] }), null)
  const png = { name: 'image.png' }
  assert.equal(clipboardImage({ items: [item('string', 'text/html'), item('file', 'image/png', png), item('file', 'image/jpeg')] }), png)
})

test('isTextEntryTarget is true only where Ctrl+V should paste text', () => {
  assert.equal(isTextEntryTarget(null), false)
  assert.equal(isTextEntryTarget({ tagName: 'BODY' }), false)
  assert.equal(isTextEntryTarget({ tagName: 'BUTTON' }), false)
  assert.equal(isTextEntryTarget({ tagName: 'TEXTAREA' }), true)
  assert.equal(isTextEntryTarget({ tagName: 'INPUT', type: 'text' }), true)
  assert.equal(isTextEntryTarget({ tagName: 'INPUT', type: 'number' }), true)
  assert.equal(isTextEntryTarget({ tagName: 'INPUT', type: 'checkbox' }), false)
  assert.equal(isTextEntryTarget({ tagName: 'INPUT', type: 'range' }), false)
  assert.equal(isTextEntryTarget({ tagName: 'DIV', isContentEditable: true }), true)
})

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildRunErrorNotification } from './notification.ts'

test('a cancelled run never notifies', () => {
  assert.equal(
    buildRunErrorNotification({ title: 'Generation failed', error: 'aborted', cancelled: true }),
    null,
  )
})

test('body is the run name followed by the error message', () => {
  assert.deepEqual(
    buildRunErrorNotification({ title: 'Workflow run failed', name: 'Bake textures', error: 'CUDA out of memory' }),
    { title: 'Workflow run failed', body: 'Bake textures: CUDA out of memory' },
  )
})

test('without a name the body is just the error message', () => {
  assert.deepEqual(
    buildRunErrorNotification({ title: 'Generation failed', error: 'boom' }),
    { title: 'Generation failed', body: 'boom' },
  )
})

test('keeps only the first non-empty line of a multi-line error (e.g. a traceback)', () => {
  const n = buildRunErrorNotification({
    title: 'Generation failed',
    error: '\n  RuntimeError: weights missing  \nTraceback (most recent call last):\n  File "x.py"',
  })
  assert.equal(n?.body, 'RuntimeError: weights missing')
})

test('strips the generic "Error: " prefix String(err) adds, but keeps specific error types', () => {
  assert.equal(
    buildRunErrorNotification({ title: 't', error: new Error('Node failed') })?.body,
    'Node failed',
  )
  assert.equal(
    buildRunErrorNotification({ title: 't', error: String(new Error('Error: nested')) })?.body,
    'nested',
  )
  assert.equal(
    buildRunErrorNotification({ title: 't', error: String(new TypeError('bad input')) })?.body,
    'TypeError: bad input',
  )
})

test('truncates long messages with an ellipsis', () => {
  const body = buildRunErrorNotification({ title: 't', error: 'x'.repeat(500) })?.body ?? ''
  assert.equal(body.length, 120)
  assert.ok(body.endsWith('…'))
})

test('falls back to "Unknown error" for an empty or missing error', () => {
  assert.equal(buildRunErrorNotification({ title: 't', error: undefined })?.body, 'Unknown error')
  assert.equal(buildRunErrorNotification({ title: 't', name: 'triposr', error: '   ' })?.body, 'triposr: Unknown error')
})

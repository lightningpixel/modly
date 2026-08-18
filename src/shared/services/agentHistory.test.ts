import { test } from 'node:test'
import assert from 'node:assert/strict'

import { markUnappliedTurn, appliedSomething, NO_CHANGE_MARK } from './agentHistory'

const applied = [{ payload: { type: 'update_workflow' } }]
const lookupOnly = [{ payload: null as unknown }]

test('a turn that applied a payload is sent unchanged', () => {
  assert.equal(markUnappliedTurn('assistant', 'Done.', applied), 'Done.')
  assert.equal(appliedSomething(applied), true)
})

test('a turn that only looked things up is marked', () => {
  const out = markUnappliedTurn('assistant', 'The workflow has been updated.', lookupOnly)
  assert.equal(out, `The workflow has been updated.\n${NO_CHANGE_MARK}`)
})

test('a turn with no tool call at all is marked — the case that started the drift', () => {
  const out = markUnappliedTurn('assistant', 'I added an export step.', undefined)
  assert.ok(out.endsWith(NO_CHANGE_MARK))
})

test('user messages are never annotated', () => {
  assert.equal(markUnappliedTurn('user', 'make it smaller', undefined), 'make it smaller')
})

test('empty content stays empty, and the mark is never doubled', () => {
  assert.equal(markUnappliedTurn('assistant', '', undefined), '')
  const once = markUnappliedTurn('assistant', 'Hi.', undefined)
  assert.equal(markUnappliedTurn('assistant', once, undefined), once)
})

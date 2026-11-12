import assert from 'node:assert/strict'
import test from 'node:test'

import {
  TITLE_MAX_LENGTH,
  UNTITLED,
  deriveTitle,
  relativeDate,
  settleMessages,
  sortSummaries,
  upsertSummary,
} from './agentConversations'

test('title is the first user message, collapsed to one line', () => {
  const title = deriveTitle([
    { role: 'assistant', content: 'Hello' },
    { role: 'user', content: '  make the\n\nmesh   smoother  ' },
    { role: 'user', content: 'second' },
  ])
  assert.equal(title, 'make the mesh smoother')
})

test('a long first message is cut to the title limit', () => {
  const title = deriveTitle([{ role: 'user', content: 'x'.repeat(200) }])
  assert.equal(title.length, TITLE_MAX_LENGTH)
  assert.ok(title.endsWith('…'))
  assert.equal(deriveTitle([{ role: 'user', content: 'y'.repeat(TITLE_MAX_LENGTH) }]), 'y'.repeat(TITLE_MAX_LENGTH))
})

test('no usable user message gives the placeholder title', () => {
  assert.equal(deriveTitle([]), UNTITLED)
  assert.equal(deriveTitle([{ role: 'assistant', content: 'hi' }, { role: 'user', content: '   ' }, null]), UNTITLED)
})

test('summaries sort newest first without mutating the input', () => {
  const list = [
    { id: 'a', title: 'A', updatedAt: 10 },
    { id: 'b', title: 'B', updatedAt: 30 },
    { id: 'c', title: 'C', updatedAt: 20 },
  ]
  assert.deepEqual(sortSummaries(list).map((s) => s.id), ['b', 'c', 'a'])
  assert.deepEqual(list.map((s) => s.id), ['a', 'b', 'c'])
})

test('upsertSummary replaces an entry and moves it to the top', () => {
  const list = [
    { id: 'b', title: 'B', updatedAt: 30 },
    { id: 'a', title: 'A', updatedAt: 10 },
  ]
  assert.deepEqual(upsertSummary(list, { id: 'a', title: 'A2', updatedAt: 40 }), [
    { id: 'a', title: 'A2', updatedAt: 40 },
    { id: 'b', title: 'B', updatedAt: 30 },
  ])
  assert.equal(upsertSummary(list, { id: 'c', title: 'C', updatedAt: 1 }).length, 3)
})

test('settleMessages clears streaming and running flags', () => {
  const settled = settleMessages([
    { id: 'u', role: 'user', content: 'hi' },
    { id: 'a', role: 'assistant', content: 'part', streaming: true, actions: [{ id: 't', tool: 'x', running: true }] },
  ])
  assert.deepEqual(settled, [
    { id: 'u', role: 'user', content: 'hi' },
    { id: 'a', role: 'assistant', content: 'part', streaming: false, actions: [{ id: 't', tool: 'x', running: false }] },
  ])
})

test('relativeDate buckets by age', () => {
  const now = Date.UTC(2026, 10, 12, 12, 0, 0)
  assert.equal(relativeDate(now - 5_000, now), 'just now')
  assert.equal(relativeDate(now - 5 * 60_000, now), '5m ago')
  assert.equal(relativeDate(now - 3 * 3_600_000, now), '3h ago')
  assert.equal(relativeDate(now - 2 * 86_400_000, now), '2d ago')
  assert.equal(relativeDate(now + 60_000, now), 'just now')
  assert.match(relativeDate(now - 30 * 86_400_000, now), /^Oct \d+$/)
  assert.match(relativeDate(Date.UTC(2024, 0, 15), now), /2024/)
})

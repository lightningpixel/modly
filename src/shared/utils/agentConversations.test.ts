import assert from 'node:assert/strict'
import test from 'node:test'

import {
  TITLE_MAX_LENGTH,
  UNTITLED,
  createSerialQueue,
  deriveTitle,
  relativeDate,
  settleMessages,
  sortSummaries,
  upsertSummary,
} from './agentConversations'
import { useAgentConversationStore } from '../stores/agentConversationStore'

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

test('the serial queue runs tasks one at a time, and a failure does not stop it', async () => {
  const enqueue = createSerialQueue()
  const log: string[] = []
  const first = deferred<string>()
  const a = enqueue(async () => { log.push('a start'); const v = await first.promise; log.push('a end'); return v })
  const b = enqueue(async () => { log.push('b'); throw new Error('b failed') })
  const c = enqueue(async () => { log.push('c'); return 'c' })
  await tick()
  assert.deepEqual(log, ['a start'])
  first.resolve('a')
  assert.equal(await a, 'a')
  await assert.rejects(b, /b failed/)
  assert.equal(await c, 'c')
  assert.deepEqual(log, ['a start', 'a end', 'b', 'c'])
})

// ─── Store: disk operations against a fake IPC ───────────────────────────────

interface Deferred<T> { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

type Ipc = {
  list: () => Promise<unknown[]>
  read: (id: string) => Promise<unknown>
  save: (c: { id: string; messages: unknown[] }) => Promise<void>
  remove: (id: string) => Promise<void>
}
const ipc: Ipc = {
  list: async () => [],
  read: async () => null,
  save: async () => {},
  remove: async () => {},
}
const calls: string[] = []
;(globalThis as Record<string, unknown>).window = {
  electron: {
    agent: {
      conversations: {
        list: () => { calls.push('list'); return ipc.list() },
        read: (id: string) => { calls.push(`read ${id}`); return ipc.read(id) },
        save: (c: { id: string; messages: unknown[] }) => { calls.push(`save ${c.id}`); return ipc.save(c) },
        remove: (id: string) => { calls.push(`remove ${id}`); return ipc.remove(id) },
      },
    },
  },
}

const store = useAgentConversationStore
const msg = (content: string) => ({ id: content, role: 'user' as const, content })
const stored = (id: string, updatedAt: number) => ({ id, title: id, createdAt: 1, updatedAt, messages: [msg(id)] })

function resetIpc(): void {
  ipc.list = async () => []
  ipc.read = async () => null
  ipc.save = async () => {}
  ipc.remove = async () => {}
  calls.length = 0
}

// Runs first: init is memoized once it succeeds.
test('store: a failed init is retried, and an unreadable latest conversation falls back to the next', async () => {
  resetIpc()
  const quietError = console.error
  console.error = () => {}
  try {
    ipc.list = async () => { throw new Error('IPC down') }
    await store.getState().init()
    assert.deepEqual(store.getState().list, [])

    ipc.list = async () => [
      { id: 'broken', title: 'broken', updatedAt: 30 },
      { id: 'good', title: 'good', updatedAt: 20 },
      { id: 'older', title: 'older', updatedAt: 10 },
    ]
    ipc.read = async (id) => (id === 'good' ? stored('good', 20) : null)
    await store.getState().init()
    assert.equal(store.getState().currentId, 'good')
    assert.deepEqual(store.getState().list.map((s) => s.id), ['good', 'older'])
    assert.deepEqual(calls, ['list', 'list', 'read broken', 'read good'])

    // Memoized now.
    await store.getState().init()
    assert.equal(calls.filter((c) => c === 'list').length, 2)
  } finally {
    console.error = quietError
  }
})

test('store: switching away waits for a save in flight, and stays put when it fails', async () => {
  resetIpc()
  await store.getState().newConversation()
  const id = store.getState().currentId
  const quietError = console.error
  console.error = () => {}
  try {
    const first = deferred<void>()
    ipc.save = () => first.promise
    store.getState().setMessages([msg('hello')])
    const flushing = store.getState().flush()
    await tick()
    const switching = store.getState().newConversation()
    await tick()
    // Only the first write has started; the switch is waiting for it.
    assert.deepEqual(calls, [`save ${id}`])

    ipc.save = async () => { throw new Error('disk full') }
    first.reject(new Error('disk full'))
    await flushing
    await switching
    // The switch retried the write, which failed too: nothing is lost.
    assert.deepEqual(calls, [`save ${id}`, `save ${id}`])
    assert.equal(store.getState().currentId, id)
    assert.deepEqual(store.getState().messages, [msg('hello')])

    ipc.save = async () => {}
    await store.getState().newConversation()
    assert.notEqual(store.getState().currentId, id)
    assert.equal(store.getState().list[0]?.id, id)
  } finally {
    console.error = quietError
  }
})

test('store: deleting the current conversation waits for its save and does not come back', async () => {
  resetIpc()
  await store.getState().newConversation()
  const id = store.getState().currentId
  const write = deferred<void>()
  ipc.save = () => write.promise
  store.getState().setMessages([msg('to delete')])
  const flushing = store.getState().flush()
  await tick()
  const removing = store.getState().remove(id)
  await tick()
  assert.deepEqual(calls, [`save ${id}`])

  write.resolve()
  await flushing
  await removing
  assert.deepEqual(calls, [`save ${id}`, `remove ${id}`])
  assert.equal(store.getState().list.some((s) => s.id === id), false)
  assert.notEqual(store.getState().currentId, id)
  assert.deepEqual(store.getState().messages, [])
})

test('store: a failed delete keeps the pending changes', async () => {
  resetIpc()
  await store.getState().newConversation()
  const id = store.getState().currentId
  const quietError = console.error
  console.error = () => {}
  try {
    ipc.remove = async () => { throw new Error('locked') }
    store.getState().setMessages([msg('keep me')])
    await store.getState().remove(id)
    assert.equal(store.getState().currentId, id)

    await store.getState().flush()
    assert.deepEqual(calls, [`remove ${id}`, `save ${id}`])
    assert.equal(store.getState().list[0]?.id, id)
  } finally {
    console.error = quietError
  }
})

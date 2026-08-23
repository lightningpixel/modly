import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// A localStorage the persist middleware can actually write to — without one it
// disables itself, and partialize/migrate/merge (most of what is tested here)
// would never run.
function fakeLocalStorage(seed = {}) {
  const data = new Map(Object.entries(seed))
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, v),
    removeItem: (k) => data.delete(k),
    raw: data,
  }
}

/** Fresh module instance per test: the store is created at import time, so its
 *  initial hydration has to see this test's localStorage. zustand's default
 *  storage reads `window.localStorage` (not the bare global), and throws the
 *  persistence away when that lookup fails. */
function loadStore(storage) {
  globalThis.window = { localStorage: storage }
  globalThis.localStorage = storage
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-chatstore-test-')), 'chatStore.cjs')
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve('src/shared/stores/chatStore.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    // The store only imports `Workflow` as a type; nothing resolves at runtime.
    alias: { '@shared/types/electron.d': resolve('src/shared/types/electron.d.ts') },
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return require(outfile).useChatStore
}

const userMsg = (id, content) => ({ id, role: 'user', content })
const stored = (storage) => JSON.parse(storage.raw.get('modly-chat-history')).state

test('a conversation is titled after its first user message', () => {
  const store = loadStore(fakeLocalStorage())
  store.getState().setMessages([userMsg('u1', 'fais-moi un canard low-poly')])

  const { conversations, activeId } = store.getState()
  assert.equal(conversations.length, 1)
  assert.equal(conversations.find((c) => c.id === activeId).title, 'fais-moi un canard low-poly')
})

test('a new conversation starts empty and leaves the previous one intact', () => {
  const store = loadStore(fakeLocalStorage())
  store.getState().setMessages([userMsg('u1', 'premier fil')])
  const first = store.getState().activeId

  store.getState().newConversation()
  assert.deepEqual(store.getState().messages, [])
  assert.notEqual(store.getState().activeId, first)
  assert.equal(store.getState().conversations.length, 2)

  // The transcript of the thread we left is kept, not the live (now empty) one.
  const kept = store.getState().conversations.find((c) => c.id === first)
  assert.equal(kept.messages.length, 1)
})

test('pressing new twice on a blank conversation does not stack empty threads', () => {
  const store = loadStore(fakeLocalStorage())
  store.getState().newConversation()
  store.getState().newConversation()
  assert.equal(store.getState().conversations.length, 1)
})

test('switching back restores that conversation transcript and summary', () => {
  const store = loadStore(fakeLocalStorage())
  store.getState().setMessages([userMsg('u1', 'fil A')])
  store.getState().setCompaction('note A', 1)
  const a = store.getState().activeId

  store.getState().newConversation()
  store.getState().setMessages([userMsg('u2', 'fil B')])
  assert.equal(store.getState().summary, '')

  store.getState().switchConversation(a)
  assert.equal(store.getState().messages[0].content, 'fil A')
  assert.equal(store.getState().summary, 'note A')
  assert.equal(store.getState().compactedUpTo, 1)
})

test('clear empties the open conversation but keeps it in the list', () => {
  const store = loadStore(fakeLocalStorage())
  store.getState().setMessages([userMsg('u1', 'à jeter')])
  store.getState().setCompaction('note', 1)
  const id = store.getState().activeId

  store.getState().clear()
  assert.deepEqual(store.getState().messages, [])
  assert.equal(store.getState().summary, '')
  assert.equal(store.getState().activeId, id)
  assert.equal(store.getState().conversations.length, 1)
  assert.equal(store.getState().conversations[0].title, '')
})

test('deleting the open conversation falls back to the next one', () => {
  const store = loadStore(fakeLocalStorage())
  store.getState().setMessages([userMsg('u1', 'fil A')])
  const a = store.getState().activeId
  store.getState().newConversation()
  store.getState().setMessages([userMsg('u2', 'fil B')])
  const b = store.getState().activeId

  store.getState().deleteConversation(b)
  assert.equal(store.getState().activeId, a)
  assert.equal(store.getState().messages[0].content, 'fil A')
})

test('deleting the last conversation leaves a usable empty one', () => {
  const store = loadStore(fakeLocalStorage())
  store.getState().setMessages([userMsg('u1', 'seul fil')])
  store.getState().deleteConversation(store.getState().activeId)

  const { conversations, activeId, messages } = store.getState()
  assert.equal(conversations.length, 1)
  assert.equal(conversations[0].id, activeId)   // the store is never left without one
  assert.deepEqual(messages, [])
})

test('deleting a background conversation does not disturb the open one', () => {
  const store = loadStore(fakeLocalStorage())
  store.getState().setMessages([userMsg('u1', 'fil A')])
  const a = store.getState().activeId
  store.getState().newConversation()
  store.getState().setMessages([userMsg('u2', 'fil B')])
  const b = store.getState().activeId

  store.getState().deleteConversation(a)
  assert.equal(store.getState().activeId, b)
  assert.equal(store.getState().messages[0].content, 'fil B')
})

test('the title is written once and the thread list is left alone after that', () => {
  const store = loadStore(fakeLocalStorage())
  store.getState().setMessages([userMsg('u1', 'auto title')])
  const listAfterTitle = store.getState().conversations

  store.getState().setMessages((prev) => [...prev, userMsg('u2', 'something else')])

  assert.equal(store.getState().conversations[0].title, 'auto title')
  // Same array reference: a streamed token must not hand every subscriber a new
  // conversation list for a rendering that did not change.
  assert.equal(store.getState().conversations, listAfterTitle)
})

test('a name typed by the user is not overwritten by the next message', () => {
  const store = loadStore(fakeLocalStorage())
  store.getState().setMessages([userMsg('u1', 'auto title')])
  const id = store.getState().activeId

  store.getState().renameConversation(id, '  Low-poly duck  ')
  store.getState().setMessages((prev) => [...prev, userMsg('u2', 'something else')])

  assert.equal(store.getState().conversations[0].title, 'Low-poly duck')
})

test('clearing the name lets the next message derive one again', () => {
  const store = loadStore(fakeLocalStorage())
  store.getState().setMessages([userMsg('u1', 'first title')])
  const id = store.getState().activeId

  store.getState().renameConversation(id, '')
  store.getState().setMessages((prev) => [...prev, userMsg('u2', 'never mind')])

  assert.equal(store.getState().conversations[0].title, 'first title')
})

test('what is persisted is the thread list, with the open transcript folded in', () => {
  const storage = fakeLocalStorage()
  const store = loadStore(storage)
  store.getState().setMessages([userMsg('u1', 'persisté')])

  const state = stored(storage)
  assert.equal(state.conversations.length, 1)
  assert.equal(state.activeId, store.getState().activeId)
  // The live copy is not stored twice — the entry itself carries the messages.
  assert.equal(state.messages, undefined)
  assert.equal(state.conversations[0].messages[0].content, 'persisté')
})

test('image attachments and the streaming flag stay out of storage', () => {
  const storage = fakeLocalStorage()
  const store = loadStore(storage)
  store.getState().setMessages([
    { id: 'u1', role: 'user', content: 'voici', imageDataUrls: ['data:image/png;base64,AAAA'] },
    { id: 'a1', role: 'assistant', content: 'en cours', streaming: true },
  ])

  const [saved] = stored(storage).conversations
  assert.equal(saved.messages[0].imageDataUrls, undefined)
  assert.equal(saved.messages[1].streaming, undefined)
})

test('a v1 single-thread history is reloaded as the first conversation', () => {
  const storage = fakeLocalStorage({
    'modly-chat-history': JSON.stringify({
      version: 1,
      state: { messages: [userMsg('u1', 'ancien historique')], summary: 'note', compactedUpTo: 1 },
    }),
  })
  const store = loadStore(storage)

  const { conversations, activeId, messages, summary, compactedUpTo } = store.getState()
  assert.equal(conversations.length, 1)
  assert.equal(conversations[0].id, activeId)
  assert.equal(messages[0].content, 'ancien historique')
  assert.equal(summary, 'note')
  assert.equal(compactedUpTo, 1)
  assert.equal(conversations[0].title, 'ancien historique')
})

test('the v1 payload is copied aside before it is rewritten', () => {
  // The migration is the one irreversible step: after the first write the old
  // value is gone, so a bug in it would take the user's whole chat history.
  const v1 = JSON.stringify({
    version: 1,
    state: { messages: [userMsg('u1', 'précieux')], summary: '', compactedUpTo: 0 },
  })
  const storage = fakeLocalStorage({ 'modly-chat-history': v1 })
  const store = loadStore(storage)
  store.getState().setMessages([userMsg('u2', 'la suite')])   // forces a write

  assert.equal(storage.raw.get('modly-chat-history-v1-backup'), v1)
  assert.notEqual(storage.raw.get('modly-chat-history'), v1)  // really was rewritten
})

test('a saved session reopens on the conversation it was left on', () => {
  const storage = fakeLocalStorage()
  const first = loadStore(storage)
  first.getState().setMessages([userMsg('u1', 'fil A')])
  first.getState().newConversation()
  first.getState().setMessages([userMsg('u2', 'fil B')])
  const wasActive = first.getState().activeId

  const reloaded = loadStore(storage)
  assert.equal(reloaded.getState().activeId, wasActive)
  assert.equal(reloaded.getState().messages[0].content, 'fil B')
  assert.equal(reloaded.getState().conversations.length, 2)
})

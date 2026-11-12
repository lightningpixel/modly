import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createConversationStorage,
  isConversation,
  isValidConversationId,
  sortSummaries,
} from './agent-conversations'

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'modly-conv-'))
  try {
    await fn(join(root, 'agent', 'conversations'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const conv = (id: string, updatedAt: number, title = id) =>
  ({ id, title, createdAt: 1, updatedAt, messages: [{ id: 'u', role: 'user', content: title }] })

test('conversation ids: uuids pass, path tricks and odd characters do not', () => {
  assert.equal(isValidConversationId('3f2a9c1e-8b7d-4e6f-a5b4-c3d2e1f0a9b8'), true)
  assert.equal(isValidConversationId('a'), true)
  assert.equal(isValidConversationId('a'.repeat(64)), true)
  assert.equal(isValidConversationId('a'.repeat(65)), false)
  assert.equal(isValidConversationId(''), false)
  assert.equal(isValidConversationId('../secrets'), false)
  assert.equal(isValidConversationId('..\\secrets'), false)
  assert.equal(isValidConversationId('a/b'), false)
  assert.equal(isValidConversationId('ABC'), false)
  assert.equal(isValidConversationId('abc.json'), false)
  assert.equal(isValidConversationId('abc\n'), false)
  assert.equal(isValidConversationId(42), false)
})

test('isConversation checks the stored shape', () => {
  assert.equal(isConversation(conv('abc-1', 2)), true)
  assert.equal(isConversation({ ...conv('abc-1', 2), id: '../x' }), false)
  assert.equal(isConversation({ ...conv('abc-1', 2), messages: 'nope' }), false)
  assert.equal(isConversation({ ...conv('abc-1', 2), updatedAt: '2' }), false)
  assert.equal(isConversation(null), false)
})

test('sortSummaries puts the newest first', () => {
  const sorted = sortSummaries([conv('a', 10), conv('b', 30), conv('c', 20)])
  assert.deepEqual(sorted.map((s) => s.id), ['b', 'c', 'a'])
})

test('list is empty before anything is saved', async () => {
  await withDir(async (dir) => {
    assert.deepEqual(await createConversationStorage(dir).list(), [])
  })
})

test('save, read, list newest first, remove', async () => {
  await withDir(async (dir) => {
    const storage = createConversationStorage(dir)
    await storage.save(conv('old', 10, 'Old'))
    await storage.save(conv('new', 20, 'New'))
    assert.deepEqual(await storage.read('old'), conv('old', 10, 'Old'))
    assert.deepEqual(await storage.list(), [
      { id: 'new', title: 'New', updatedAt: 20 },
      { id: 'old', title: 'Old', updatedAt: 10 },
    ])
    // No temp file is left behind.
    assert.deepEqual((await readdir(dir)).sort(), ['new.json', 'old.json'])

    await storage.remove('old')
    assert.equal(await storage.read('old'), null)
    assert.deepEqual((await storage.list()).map((s) => s.id), ['new'])
  })
})

test('saving again overwrites the file', async () => {
  await withDir(async (dir) => {
    const storage = createConversationStorage(dir)
    await storage.save(conv('a', 1, 'First'))
    await storage.save(conv('a', 2, 'Second'))
    assert.equal((await storage.read('a'))?.title, 'Second')
  })
})

test('invalid ids and shapes are refused', async () => {
  await withDir(async (dir) => {
    const storage = createConversationStorage(dir)
    await assert.rejects(storage.save({ ...conv('a', 1), id: '../escape' }))
    await assert.rejects(storage.save({ id: 'a' }))
    await assert.rejects(storage.remove('../escape'))
    assert.equal(await storage.read('../escape'), null)
  })
})

test('corrupted or mismatched files are skipped', async () => {
  await withDir(async (dir) => {
    const storage = createConversationStorage(dir)
    await storage.save(conv('good', 5))
    await writeFile(join(dir, 'broken.json'), '{not json', 'utf-8')
    await writeFile(join(dir, 'other.json'), JSON.stringify(conv('different', 9)), 'utf-8')
    await writeFile(join(dir, 'notes.txt'), 'hi', 'utf-8')
    assert.deepEqual((await storage.list()).map((s) => s.id), ['good'])
    assert.equal(await storage.read('broken'), null)
    assert.equal(await storage.read('other'), null)
  })
})

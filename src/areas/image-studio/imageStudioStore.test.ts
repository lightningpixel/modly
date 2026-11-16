import test from 'node:test'
import assert from 'node:assert/strict'
import {
  addToHistory,
  createImageStudioStore,
  fileNameOf,
  findByPath,
  sourceOf,
  withoutEntries,
  type StudioHistory,
  type StudioImage,
} from './imageStudioStore'

const image = (id: string, sourceId?: string): StudioImage => ({
  id, path: `C:\\work\\${id}.png`, previewUrl: `blob:${id}`, name: `${id}.png`, sourceId, createdAt: 0,
})

const history = (...entries: StudioImage[]): StudioHistory => ({ entries, selectedId: entries[0]?.id ?? null })

test('addToHistory puts the image first, selects it and drops the oldest beyond the cap', () => {
  const { history: next, dropped } = addToHistory(history(image('b'), image('a')), image('c'), 2)
  assert.deepEqual(next.entries.map((e) => e.id), ['c', 'b'])
  assert.equal(next.selectedId, 'c')
  assert.deepEqual(dropped.map((e) => e.id), ['a'])
})

test('withoutEntries moves the selection to the next older image, else the newer one', () => {
  const start = { ...history(image('c'), image('b'), image('a')), selectedId: 'b' }
  assert.equal(withoutEntries(start, ['b']).history.selectedId, 'a')
  assert.equal(withoutEntries({ ...start, selectedId: 'a' }, ['a']).history.selectedId, 'b')
  assert.equal(withoutEntries(start, ['a', 'b', 'c']).history.selectedId, null)
  assert.equal(withoutEntries(start, ['c']).history.selectedId, 'b')
})

test('withoutEntries detaches images made from a removed source and is a no-op for unknown ids', () => {
  const start = history(image('cut', 'photo'), image('photo'))
  const { history: next, dropped } = withoutEntries(start, ['photo'])
  assert.deepEqual(next.entries, [{ ...image('cut'), sourceId: undefined }])
  assert.deepEqual(dropped.map((e) => e.id), ['photo'])
  assert.equal(withoutEntries(start, ['nope']).history, start)
})

test('sourceOf, findByPath and fileNameOf', () => {
  const entries = [image('cut', 'photo'), image('photo'), image('orphan', 'gone')]
  assert.equal(sourceOf(entries, entries[0])?.id, 'photo')
  assert.equal(sourceOf(entries, entries[1]), undefined)
  assert.equal(sourceOf(entries, entries[2]), undefined)
  assert.equal(sourceOf(entries, undefined), undefined)
  assert.equal(findByPath(entries, 'c:/WORK/photo.png')?.id, 'photo')
  assert.equal(findByPath(entries, 'c:/work/other.png'), undefined)
  assert.equal(fileNameOf('C:\\a\\b\\pic.webp'), 'pic.webp')
  assert.equal(fileNameOf('/x/y.png'), 'y.png')
})

test('the store keeps history, selects new images and revokes previews it drops', () => {
  const revoked: string[] = []
  const store = createImageStudioStore((url) => revoked.push(url))
  const a = store.getState().add({ path: 'C:/a.png', previewUrl: 'blob:a', name: 'a.png' })
  const b = store.getState().add({ path: 'C:/b.png', previewUrl: 'blob:b', name: 'b.png', sourceId: a.id })
  assert.notEqual(a.id, b.id)
  assert.equal(store.getState().selectedId, b.id)
  assert.deepEqual(store.getState().entries.map((e) => e.id), [b.id, a.id])

  store.getState().select(a.id)
  assert.equal(store.getState().selectedId, a.id)
  store.getState().select('missing')
  assert.equal(store.getState().selectedId, a.id)

  store.getState().remove(a.id)
  assert.deepEqual(revoked, ['blob:a'])
  assert.equal(store.getState().selectedId, b.id)
  assert.equal(store.getState().entries[0].sourceId, undefined)

  store.getState().clear()
  assert.deepEqual(revoked, ['blob:a', 'blob:b'])
  assert.deepEqual(store.getState().entries, [])
  assert.equal(store.getState().selectedId, null)
})

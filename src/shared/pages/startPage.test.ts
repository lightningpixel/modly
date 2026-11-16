import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_START_PAGE, readStartPage, writeStartPage } from './startPage'

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) },
  }
}

test('the app starts on Home unless the user chose Generate', () => {
  assert.equal(DEFAULT_START_PAGE, 'home')
  assert.equal(readStartPage(memoryStorage()), 'home')
  assert.equal(readStartPage(memoryStorage({ 'modly.startPage': 'generate' })), 'generate')
})

test('an unknown or unreadable value falls back to Home', () => {
  assert.equal(readStartPage(memoryStorage({ 'modly.startPage': 'settings' })), 'home')
  assert.equal(readStartPage(undefined), 'home')
  const throwing = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
  assert.equal(readStartPage(throwing), 'home')
  assert.doesNotThrow(() => writeStartPage('generate', throwing))
})

test('writeStartPage round-trips', () => {
  const storage = memoryStorage()
  writeStartPage('generate', storage)
  assert.equal(readStartPage(storage), 'generate')
  writeStartPage('home', storage)
  assert.equal(readStartPage(storage), 'home')
})

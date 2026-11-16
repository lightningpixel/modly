import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

async function load() {
  return import(new URL('./api-auth.ts', import.meta.url).href)
}

test('generateApiToken: 64 hex characters, different every time', async () => {
  const { generateApiToken } = await load()
  const a = generateApiToken()
  assert.match(a, /^[0-9a-f]{64}$/)
  assert.notEqual(a, generateApiToken())
})

test('getApiToken: one token per launch, sent in X-Modly-Token', async () => {
  const { getApiToken, apiAuthHeaders } = await load()
  const token = getApiToken()
  assert.match(token, /^[0-9a-f]{64}$/)
  assert.equal(getApiToken(), token)
  assert.deepEqual(apiAuthHeaders(), { 'X-Modly-Token': token })
})

test('the token is not put on process.env', async () => {
  const { getApiToken } = await load()
  const token = getApiToken()
  assert.ok(!Object.values(process.env).includes(token))
})

test('apiClient adds the token to every request', async () => {
  const { apiClient, getApiToken } = await load()
  let sent: Record<string, unknown> = {}
  await apiClient.get('http://127.0.0.1:8765/model/all', {
    adapter: async (config: { headers: { toJSON(): Record<string, unknown> } }) => {
      sent = config.headers.toJSON()
      return { data: null, status: 200, statusText: 'OK', headers: {}, config }
    },
  })
  assert.equal(sent['X-Modly-Token'], getApiToken())
})

test('allowedOrigins: the dev server origin, whatever its port, plus file pages', async () => {
  const { allowedOrigins } = await load()
  assert.deepEqual(allowedOrigins('http://localhost:5174/'), ['http://localhost:5174', 'file://', 'null'])
  assert.deepEqual(allowedOrigins('http://127.0.0.1:5173/index.html?x=1'), ['http://127.0.0.1:5173', 'file://', 'null'])
  assert.deepEqual(allowedOrigins(undefined), ['file://', 'null'])
  assert.deepEqual(allowedOrigins(''), ['file://', 'null'])
  assert.deepEqual(allowedOrigins('not a url'), ['file://', 'null'])
})

test('isApiRequest: only the backend origin on its current port', async () => {
  const { isApiRequest } = await load()
  assert.equal(isApiRequest('http://127.0.0.1:8765/health', 8765), true)
  assert.equal(isApiRequest('http://localhost:8765/generate/status/1', 8765), true)
  assert.equal(isApiRequest('http://127.0.0.1:8766/model/all', 8766), true)
  // The port moved: the old one no longer gets the token.
  assert.equal(isApiRequest('http://127.0.0.1:8765/model/all', 8766), false)
  // The Vite dev server, other hosts and schemes.
  assert.equal(isApiRequest('http://localhost:5173/src/main.tsx', 8765), false)
  assert.equal(isApiRequest('http://127.0.0.1/model/all', 8765), false)
  assert.equal(isApiRequest('http://example.com:8765/model/all', 8765), false)
  assert.equal(isApiRequest('https://127.0.0.1:8765/model/all', 8765), false)
  assert.equal(isApiRequest('http://127.0.0.1.evil.test:8765/', 8765), false)
  assert.equal(isApiRequest('garbage', 8765), false)
})

test('writeTokenFile / removeTokenFile', async () => {
  const { writeTokenFile, removeTokenFile, TOKEN_FILE } = await load()
  const dir = mkdtempSync(join(tmpdir(), 'modly-api-token-'))
  try {
    const file = join(dir, TOKEN_FILE)
    assert.equal(TOKEN_FILE, 'api-token')
    // A leftover from an earlier launch, readable by everyone.
    writeFileSync(file, 'old', { mode: 0o644 })
    writeTokenFile(dir, 'a'.repeat(64))
    assert.equal(readFileSync(file, 'utf8'), 'a'.repeat(64))
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600)
    removeTokenFile(dir)
    assert.equal(existsSync(file), false)
    removeTokenFile(dir) // already gone: no throw
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('isAppNavigation: the window stays on its own pages', async () => {
  const { isAppNavigation } = await load()
  // production: file pages only
  assert.equal(isAppNavigation('file:///C:/app/out/renderer/index.html'), true)
  assert.equal(isAppNavigation('https://example.test/'), false)
  assert.equal(isAppNavigation('http://127.0.0.1:8765/workspace/x.glb'), false)
  // dev: the Vite origin only
  const dev = 'http://localhost:5174/'
  assert.equal(isAppNavigation('http://localhost:5174/#/settings', dev), true)
  assert.equal(isAppNavigation('http://localhost:5173/', dev), false)
  assert.equal(isAppNavigation('file:///etc/passwd', dev), false)
  assert.equal(isAppNavigation('not a url', dev), false)
})

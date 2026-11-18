import assert from 'node:assert/strict'
import test from 'node:test'
import { APP_HEADER, appOrigins, getAppSecret, isApiRequest, isAppNavigation } from './api-guard'

test('getAppSecret: 64 hex characters, one per launch, never on process.env', () => {
  const secret = getAppSecret()
  assert.match(secret, /^[0-9a-f]{64}$/)
  assert.equal(getAppSecret(), secret)
  assert.ok(!Object.values(process.env).includes(secret))
  assert.equal(APP_HEADER, 'X-Modly-App')
})

test('appOrigins: the dev renderer origin, nothing in production', () => {
  assert.deepEqual(appOrigins('http://localhost:5174/index.html'), ['http://localhost:5174'])
  assert.deepEqual(appOrigins(undefined), [])
  assert.deepEqual(appOrigins('not a url'), [])
  assert.deepEqual(appOrigins('file:///C:/app/index.html'), [])
})

test('isAppNavigation: the window stays on its own pages', () => {
  assert.ok(isAppNavigation('file:///C:/app/index.html'))
  assert.ok(!isAppNavigation('https://evil.example/'))
  assert.ok(isAppNavigation('http://localhost:5173/#/x', 'http://localhost:5173'))
  assert.ok(!isAppNavigation('http://localhost:5174/', 'http://localhost:5173'))
  assert.ok(!isAppNavigation('file:///C:/app/index.html', 'http://localhost:5173'))
  assert.ok(!isAppNavigation('::', 'http://localhost:5173'))
})

test('isApiRequest: only the backend on its current port', () => {
  assert.ok(isApiRequest('http://127.0.0.1:8765/model/all', 8765))
  assert.ok(isApiRequest('http://localhost:8765/health', 8765))
  assert.ok(!isApiRequest('http://127.0.0.1:8766/model/all', 8765))
  assert.ok(!isApiRequest('https://127.0.0.1:8765/', 8765))
  assert.ok(!isApiRequest('http://evil.example:8765/', 8765))
  assert.ok(!isApiRequest('nope', 8765))
})

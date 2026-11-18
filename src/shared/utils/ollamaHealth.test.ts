import assert from 'node:assert/strict'
import test from 'node:test'

import { adviceText, ollamaAdvice, ollamaHealthUrl, parseOllamaHealth } from './ollamaHealth.ts'

const base = { base_url: 'http://localhost:11434', model: 'qwen2.5:3b' }

test('the health URL carries the configured base URL and model, encoded', () => {
  const url = ollamaHealthUrl('http://127.0.0.1:8765', 'http://localhost:11434/v1', 'qwen2.5:3b')
  assert.equal(
    url,
    'http://127.0.0.1:8765/agent/ollama/health?base_url=http%3A%2F%2Flocalhost%3A11434%2Fv1&model=qwen2.5%3A3b',
  )
})

test('ok needs no advice', () => {
  assert.equal(ollamaAdvice({ ...base, status: 'ok' }), null)
})

test('unreachable tells the user to start Ollama, with the command', () => {
  const advice = ollamaAdvice({ ...base, status: 'unreachable', detail: 'connection refused' })
  assert.ok(advice)
  assert.match(advice.title, /not running/i)
  assert.match(advice.body, /localhost:11434/)
  assert.equal(advice.command, 'ollama serve')
})

test('model_missing tells the user to pull the configured model', () => {
  const advice = ollamaAdvice({ ...base, status: 'model_missing', available: ['llama3:8b'] })
  assert.ok(advice)
  assert.match(advice.title, /qwen2\.5:3b/)
  assert.equal(advice.command, 'ollama pull qwen2.5:3b')
})

test('no_model points at Settings and has no command', () => {
  const advice = ollamaAdvice({ ...base, model: '', status: 'no_model' })
  assert.ok(advice)
  assert.match(advice.body, /Settings → Agent/)
  assert.equal(advice.command, undefined)
})

test('adviceText flattens the advice into one plain-text chat line', () => {
  assert.equal(
    adviceText({ title: 'Ollama is not running', body: 'Start it, or run:', command: 'ollama serve' }),
    'Ollama is not running. Start it, or run: ollama serve',
  )
  assert.equal(adviceText({ title: 'No model', body: 'Pick one.' }), 'No model. Pick one.')
})

test('a well-formed response parses', () => {
  const parsed = parseOllamaHealth({ ...base, status: 'model_missing', available: ['a'], extra: 1 })
  assert.deepEqual(parsed, { ...base, status: 'model_missing', available: ['a'], detail: undefined })
})

test('an unknown status or a non-object is rejected', () => {
  assert.equal(parseOllamaHealth({ ...base, status: 'weird' }), null)
  assert.equal(parseOllamaHealth(null), null)
  assert.equal(parseOllamaHealth('ok'), null)
})

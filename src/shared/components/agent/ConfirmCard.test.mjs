import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Bundle ConfirmCard.tsx with its real react/zustand dependencies; its only
// other import is type-only. Rendering is left to the app; this covers the
// confirm queue that turns confirm(description) into a Promise.
function load() {
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-confirm-test-')), 'ConfirmCard.cjs')
  const result = buildSync({
    entryPoints: [resolve('src/shared/components/agent/ConfirmCard.tsx')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    write: false,
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return createRequire(import.meta.url)(outfile)
}

const { useConfirmQueue, ConfirmCard } = load()
const queue = () => useConfirmQueue.getState()

test('confirm shows a pending request and resolves true on Confirm', async () => {
  const answer = queue().confirm('Uninstall the extension “TripoSR”', { tool: 'uninstall_extension', id: 'e1', callId: 'c1', destructive: true })
  const [request] = queue().requests
  assert.equal(request.status, 'pending')
  assert.equal(request.callId, 'c1')
  assert.equal(request.destructive, true)

  queue().answer(request.key, true)

  assert.equal(await answer, true)
  assert.equal(queue().requests[0].status, 'confirmed')
  queue().clearAnswered()
  assert.deepEqual(queue().requests, [])
})

test('Cancel resolves false, and a second answer is ignored', async () => {
  const answer = queue().confirm('Delete the workflow “Turntable”')
  const { key } = queue().requests[0]
  queue().answer(key, false)
  queue().answer(key, true)

  assert.equal(await answer, false)
  assert.equal(queue().requests[0].status, 'cancelled')
  queue().clearAnswered()
})

test('cancelAll declines every pending request', async () => {
  const a = queue().confirm('one')
  const b = queue().confirm('two')
  queue().cancelAll()
  assert.deepEqual(await Promise.all([a, b]), [false, false])
  assert.deepEqual(queue().requests.map((r) => r.status), ['cancelled', 'cancelled'])
  queue().clearAnswered()
})

test('ConfirmCard is a component', () => {
  assert.equal(typeof ConfirmCard, 'function')
})

/**
 * A JS process extension runs in a worker thread that is kept warm between
 * runs. If that worker dies mid-run -- an uncaught error outside the awaited
 * processor call, running out of memory on a large mesh, process.exit() -- it
 * never posts 'done' or 'error'. The run must settle with an error instead of
 * leaving the workflow waiting forever, and the next run must get a fresh
 * worker rather than posting into the dead one.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

function loadModule() {
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-worker-exit-test-')), 'process-runner.cjs')
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve('electron/main/process-runner.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return require(outfile)
}

// Behaves according to params.mode; `runs` counts runs served by this worker,
// so a fresh worker starts again from 1.
function makeRunner() {
  const { ProcessRunner } = loadModule()
  const root = mkdtempSync(join(tmpdir(), 'modly-worker-exit-'))
  const extDir = join(root, 'ext')
  mkdirSync(extDir, { recursive: true })
  writeFileSync(join(extDir, 'processor.js'), [
    'let runs = 0',
    'module.exports = async (input, params) => {',
    '  runs += 1',
    "  if (params.mode === 'throw') throw new Error('bad input')",
    "  if (params.mode === 'crash') {",
    "    setTimeout(() => { throw new Error('worker blew up') }, 0)",
    '    return new Promise(() => {})',
    '  }',
    "  if (params.mode === 'exit') process.exit(3)",
    '  return { text: String(runs) }',
    '}',
    '',
  ].join('\n'))
  return new ProcessRunner(extDir, 'processor.js', join(root, 'workspace'), root)
}

test('a run whose worker crashes rejects instead of hanging', { timeout: 5000 }, async () => {
  const runner = makeRunner()
  try {
    await assert.rejects(runner.run({}, { mode: 'crash' }), /worker blew up/)
  } finally {
    runner.terminate()
  }
})

test('after its worker exits, the runner starts a fresh one for the next run', { timeout: 5000 }, async () => {
  const runner = makeRunner()
  try {
    await assert.rejects(runner.run({}, { mode: 'exit' }), /exited with code 3/)
    assert.deepEqual(await runner.run({}, { mode: 'ok' }), { text: '1' })
  } finally {
    runner.terminate()
  }
})

test('an error thrown by the processor still rejects with its message and keeps the warm worker', { timeout: 5000 }, async () => {
  const runner = makeRunner()
  try {
    await assert.rejects(runner.run({}, { mode: 'throw' }), { message: 'Error: bad input' })
    // Same worker thread: its run counter carried over instead of restarting.
    assert.deepEqual(await runner.run({}, { mode: 'ok' }), { text: '2' })
  } finally {
    runner.terminate()
  }
})

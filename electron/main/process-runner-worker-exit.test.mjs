/**
 * A JS process extension runs in a worker thread that is kept warm between
 * runs. If that worker dies mid-run -- an uncaught error outside the awaited
 * processor call, running out of memory on a large mesh, process.exit() -- it
 * never posts 'done' or 'error'. The run must settle with an error instead of
 * leaving the workflow waiting forever, and the next run must get a fresh
 * worker rather than posting into the dead one -- including when the worker
 * died while idle, between two runs.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import vm from 'node:vm'

function loadModule() {
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve('electron/main/process-runner.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    external: ['electron'],
  })
  // process-runner imports electron's `app` (only the Python runner uses it);
  // the real package cannot load outside Electron, so hand it a stub.
  const module = { exports: {} }
  const dependencies = (name) => (name === 'electron' ? { app: {} } : require(name))
  vm.runInNewContext(result.outputFiles[0].text, {
    module, exports: module.exports, require: dependencies, process, console, Buffer, setTimeout, clearTimeout,
  })
  return module.exports
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
    // Returns normally, then a timer it left behind kills the idle worker.
    "  if (params.mode === 'late-crash') setTimeout(() => { throw new Error('late failure') }, 10)",
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

test('a worker that dies between runs is replaced for the next run', { timeout: 5000 }, async () => {
  const runner = makeRunner()
  try {
    // The run itself succeeds; the timer it leaves behind kills the idle worker.
    assert.deepEqual(await runner.run({}, { mode: 'late-crash' }), { text: '1' })
    await new Promise((settle) => setTimeout(settle, 200))
    // A fresh worker serves the next run (counter restarts) instead of hanging.
    assert.deepEqual(await runner.run({}, { mode: 'ok' }), { text: '1' })
  } finally {
    runner.terminate()
  }
})

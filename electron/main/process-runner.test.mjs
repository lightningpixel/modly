import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// python-bridge pulls in electron at module scope; the runner only needs its
// API_BASE_URL constant, so it is stubbed out at bundle time.
const stubPythonBridge = {
  name: 'stub-python-bridge',
  setup(build) {
    build.onResolve({ filter: /python-bridge$/ }, () => ({ path: 'python-bridge', namespace: 'stub' }))
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: "export const API_BASE_URL = 'http://127.0.0.1:8000'",
      loader: 'js',
    }))
  },
}

async function loadModule() {
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-runner-test-')), 'process-runner.cjs')
  const require = createRequire(import.meta.url)
  const result = await build({
    entryPoints: [resolve('electron/main/process-runner.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    plugins: [stubPythonBridge],
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return require(outfile)
}

const { ProcessRunner, PythonProcessRunner, getPythonProcessRunner, terminateProcessRunner } = await loadModule()

const newRunner = () =>
  new PythonProcessRunner('python', tmpdir(), 'main.py', tmpdir(), tmpdir(), tmpdir())

test('a cancel landing before the spawn kills the run instead of orphaning it', async () => {
  const runner = newRunner()
  // Cancel arriving while the IPC handler is still resolving paths.
  runner.terminate()
  // run() used to clear the flag on entry, so the guard could never fire and a
  // process was spawned that nothing could reach any more.
  await assert.rejects(runner.run({}, {}), /Cancelled/)
})

test('the next run gets a fresh runner after a cancel', () => {
  const first = getPythonProcessRunner('ext-a', 'python', tmpdir(), 'main.py', tmpdir(), tmpdir(), tmpdir())
  terminateProcessRunner('ext-a')
  const second = getPythonProcessRunner('ext-a', 'python', tmpdir(), 'main.py', tmpdir(), tmpdir(), tmpdir())
  // terminate() drops the runner from the registry, which is what makes the
  // sticky cancelled flag safe.
  assert.notEqual(first, second)
})

test('the JS worker runner also refuses to start after a cancel', async () => {
  // Same window as the Python runner: Cancel lands while the IPC handler is
  // still resolving the extension folder. run() used to clear the flag and
  // ensureReady() then booted a brand-new Worker, so the extension ran to
  // completion with the run store already back to idle.
  const runner = new ProcessRunner(tmpdir(), 'index.js', tmpdir(), tmpdir())
  runner.terminate()
  await assert.rejects(runner.run({}, {}), /Cancelled/)
})

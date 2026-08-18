import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Bundle the store with its real zustand dependency — same approach as
// workflowsStore.test.mjs. Only fetchModels() is exercised, so the React hook
// at the bottom of the module is never rendered.
function loadStore() {
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-llmstore-test-')), 'llmModelsStore.cjs')
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve('src/shared/stores/llmModelsStore.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return require(outfile).useLlmModelsStore
}

/** A /llm/models endpoint whose answers are released one at a time. */
function deferredFetch() {
  const calls = []
  globalThis.fetch = () => {
    let release
    const body = new Promise((r) => { release = r })
    calls.push({ release })
    return Promise.resolve({ json: () => body })
  }
  return calls
}

const model = (id, downloaded) => ({
  id, name: id, hf_filename: `${id}.gguf`, downloaded, source: 'catalog',
})

test('concurrent plain fetches share one request', async () => {
  const useStore = loadStore()
  const calls = deferredFetch()

  const a = useStore.getState().fetchModels('http://api')
  const b = useStore.getState().fetchModels('http://api')
  assert.equal(calls.length, 1)

  calls[0].release({ models: [model('qwen', false)] })
  await Promise.all([a, b])
  assert.equal(useStore.getState().models[0].downloaded, false)
})

test('a forced refresh re-fetches instead of joining the pending request', async () => {
  const useStore = loadStore()
  const calls = deferredFetch()

  // Mount-time fetch, still in flight when the download finishes.
  const initial = useStore.getState().fetchModels('http://api')
  const refreshed = useStore.getState().fetchModels('http://api', { force: true })

  calls[0].release({ models: [model('qwen', false)] })
  await initial
  assert.equal(calls.length, 2, 'force must issue its own request')

  calls[1].release({ models: [model('qwen', true)] })
  await refreshed
  // Joining the pre-download request left `downloaded: false`, and the preflight
  // kept refusing to run the workflow.
  assert.equal(useStore.getState().models[0].downloaded, true)
})

test('a forced refresh still settles when the pending request fails', async () => {
  const useStore = loadStore()
  const calls = []
  globalThis.fetch = () => {
    let settle
    const p = new Promise((resolve, reject) => { settle = { resolve, reject } })
    calls.push(settle)
    return p
  }

  const initial = useStore.getState().fetchModels('http://api')
  const refreshed = useStore.getState().fetchModels('http://api', { force: true })

  calls[0].reject(new Error('offline'))
  await initial
  calls[1].resolve({ json: async () => ({ models: [model('qwen', true)] }) })
  await refreshed

  assert.equal(useStore.getState().models[0].downloaded, true)
  assert.equal(useStore.getState().error, null)
})

test('a cached catalog is not re-fetched without force', async () => {
  const useStore = loadStore()
  const calls = deferredFetch()

  const first = useStore.getState().fetchModels('http://api')
  calls[0].release({ models: [model('qwen', true)] })
  await first

  await useStore.getState().fetchModels('http://api')
  assert.equal(calls.length, 1)
})

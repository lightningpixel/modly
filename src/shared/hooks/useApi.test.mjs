import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Bundle useApi.ts with stubbed dependencies:
//   - axios            → records requests and returns canned responses
//   - appStore         → useAppStore returns a fixed apiUrl (no React runtime)
// The stub modules communicate with the test through globalThis.
function loadUseApi() {
  const dir = mkdtempSync(join(tmpdir(), 'modly-useapi-test-'))

  const axiosStub = join(dir, 'axios-stub.mjs')
  writeFileSync(axiosStub, `
    function record(base, method, url, body) {
      const full = (base ?? '') + url
      globalThis.__calls.push({ method, url: full, body })
      const r = globalThis.__responses[full]
      return Promise.resolve({ data: r ?? {} })
    }
    export default {
      create: (cfg) => ({
        get:  (url) => record(cfg?.baseURL, 'get', url),
        post: (url, body) => record(cfg?.baseURL, 'post', url, body),
      }),
    }
  `, 'utf8')

  const storeStub = join(dir, 'store-stub.mjs')
  writeFileSync(storeStub, `
    export const useAppStore = (sel) => sel({ apiUrl: 'http://test.local' })
    export const GenerationOptions = {}
  `, 'utf8')

  const outfile = join(dir, 'useApi.cjs')
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve('src/shared/hooks/useApi.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    alias: {
      axios: axiosStub,
      '@shared/stores/appStore': storeStub,
    },
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return require(outfile).useApi
}

function reset() {
  globalThis.__calls = []
  globalThis.__responses = {}
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test('exposes every method consumed by the app (regression: getAllModelsStatus)', () => {
  reset()
  const api = loadUseApi()()
  for (const name of [
    'generateFromImage', 'pollJobStatus', 'cancelJob', 'getModelStatus',
    'getAllModelsStatus', 'optimizeMesh', 'smoothMesh', 'importMesh', 'transformMesh',
  ]) {
    assert.equal(typeof api[name], 'function', `useApi() must expose ${name}`)
  }
})

test('getAllModelsStatus hits /model/all and returns the payload', async () => {
  reset()
  globalThis.__responses['http://test.local/model/all'] = [{ id: 'm1', name: 'M1', downloaded: true }]
  const api = loadUseApi()()

  const result = await api.getAllModelsStatus()

  assert.deepEqual(globalThis.__calls, [{ method: 'get', url: 'http://test.local/model/all', body: undefined }])
  assert.deepEqual(result, [{ id: 'm1', name: 'M1', downloaded: true }])
})

test('pollJobStatus maps output_url → outputUrl', async () => {
  reset()
  globalThis.__responses['http://test.local/generate/status/job1'] = {
    status: 'done', progress: 100, output_url: '/workspace/out.glb',
  }
  const api = loadUseApi()()

  const result = await api.pollJobStatus('job1')

  assert.equal(result.status, 'done')
  assert.equal(result.outputUrl, '/workspace/out.glb')
})

test('optimizeMesh maps face_count → faceCount and posts target_faces', async () => {
  reset()
  globalThis.__responses['http://test.local/optimize/mesh'] = { url: '/o.glb', face_count: 5000 }
  const api = loadUseApi()()

  const result = await api.optimizeMesh('/in.glb', 5000)

  const call = globalThis.__calls[0]
  assert.equal(call.url, 'http://test.local/optimize/mesh')
  assert.deepEqual(call.body, { path: '/in.glb', target_faces: 5000 })
  assert.deepEqual(result, { url: '/o.glb', faceCount: 5000 })
})

test('cancelJob posts to the cancel endpoint and swallows errors', async () => {
  reset()
  const api = loadUseApi()()
  await api.cancelJob('job9')
  assert.equal(globalThis.__calls[0].url, 'http://test.local/generate/cancel/job9')
})

test('generateFromImage posts multipart and maps job_id → jobId', async () => {
  reset()
  globalThis.__responses['http://test.local/generate/from-image'] = { job_id: 'job42' }
  // generateFromImage builds a Blob/FormData from base64 image data.
  const api = loadUseApi()()

  const options = {
    modelId: 'model-x', remesh: 'none', enableTexture: false,
    textureResolution: 1024, modelParams: {},
  }
  const result = await api.generateFromImage('/img.png', options, btoa('fake-png-bytes'))

  const call = globalThis.__calls[0]
  assert.equal(call.url, 'http://test.local/generate/from-image')
  assert.ok(call.body instanceof FormData)
  assert.equal(call.body.get('model_id'), 'model-x')
  assert.equal(result.jobId, 'job42')
})

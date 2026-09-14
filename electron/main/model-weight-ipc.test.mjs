import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync, transformSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
function moduleFromCode(code, dependencies = require) {
  const module = { exports: {} }
  vm.runInNewContext(code, { module, exports: module.exports, require: dependencies, process, console, Buffer, setTimeout, clearTimeout })
  return module.exports
}
function loadModule(path) {
  return moduleFromCode(buildSync({ entryPoints: [resolve(path)], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text)
}
const realSources = loadModule('electron/main/model-sources.ts')
const realPlan = loadModule('electron/main/model-download-plan.ts')
const realGuard = loadModule('electron/main/extension-path-guard.ts')
const realOperations = loadModule('electron/main/model-weight-operations.ts')
const ipcCode = transformSync(readFileSync('electron/main/ipc-handlers.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code
const source = { id: 'weights', provider: 'huggingface', repo_id: 'org/base', destination: '.', checks: ['weights.bin'] }
function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'modly-weight-ipc-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const settings = { modelsDir: join(root, 'models'), extensionsDir: join(root, 'extensions') }
  const extension = join(settings.extensionsDir, 'demo')
  mkdirSync(extension, { recursive: true })
  writeFileSync(join(extension, 'manifest.json'), JSON.stringify({
    id: 'demo', type: 'model', weight_groups: [{ id: 'base', model_sources: [source] }],
    nodes: [{ id: 'a', weight_groups: ['base'] }, { id: 'b', weight_groups: ['base'], model_sources: [{ ...source, repo_id: 'org/adapter' }] }],
  }))
  const handlers = new Map(), events = [], removed = [], calls = []
  const hooks = {
    unload: async () => ({ data: { unloaded: true } }),
    download: async (id) => {
      const dir = realSources.resolveWeightStorageRoot(settings.modelsDir, id)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'weights.bin'), 'complete')
    },
  }
  const stub = new Proxy({}, { get: () => () => {} })
  const deps = (name) => {
    if (name === 'electron') return { ipcMain: { handle: (id, fn) => handlers.set(id, fn), on: () => {} }, app: { getPath: () => root, on: () => {} } }
    if (name === 'axios') return { post: (...args) => hooks.unload(...args) }
    if (name === './model-sources') return realSources
    if (name === './model-download-plan') return realPlan
    if (name === './extension-path-guard') return realGuard
    if (name === './model-weight-operations') return realOperations
    if (name === './settings-store') return { getSettings: () => settings, setSettings: (_, patch) => Object.assign(settings, patch) }
    if (name === './builtin-sync') return { getBuiltinExtensionsDir: () => join(root, 'builtin') }
    if (name === './python-bridge') return { API_BASE_URL: 'http://test' }
    if (name === './model-downloader') return {
      downloadModelSourcesFromHF: async (...args) => { calls.push(args[0]); await hooks.download(...args) },
    }
    if (name === './extension-install-recovery') return { rmWithRetry: async (dir) => { removed.push(dir); rmSync(dir, { recursive: true, force: true }); return { ok: true } } }
    if (name.startsWith('./') || name === 'electron-updater') return stub
    return require(name)
  }
  moduleFromCode(ipcCode, deps).setupIpcHandlers({}, () => ({ webContents: { send: (...event) => events.push(event) } }))
  const event = { sender: { send: (...args) => events.push(args) } }
  const invoke = (name, ...args) => handlers.get(`model:${name}`)(event, ...args)
  return { settings, hooks, invoke, removed, events, calls, handlers, root }
}

for (const action of ['deleteSharedGroup', 'deleteExtensionWeights']) {
  test(`${action} reserves its root before awaiting unload and releases it afterwards`, async (t) => {
    const f = fixture(t), entered = deferred(), finish = deferred()
    f.hooks.unload = async () => { entered.resolve(); await finish.promise; return { data: { unloaded: true } } }
    const deleting = f.invoke(action, 'demo', 'base')
    await entered.promise
    const blocked = await f.invoke('download', 'demo/a')
    assert.equal(blocked.success, false)
    assert.match(blocked.error, /busy/)
    assert.equal(f.calls.length, 0)
    finish.resolve()
    assert.equal((await deleting).success, true)
    assert.equal((await f.invoke('download', 'demo/a')).success, true)
  })
  test(`${action} preserves files when unload fails or is not confirmed`, async (t) => {
    const f = fixture(t)
    for (const unload of [async () => { throw new Error('timeout') }, async () => ({ data: {} })]) {
      f.hooks.unload = unload
      assert.equal((await f.invoke(action, 'demo', 'base')).success, false)
      assert.equal(f.removed.length, 0)
    }
    // Failure must release the lease as well.
    assert.equal((await f.invoke('download', 'demo/a')).success, true)
  })
}

test('active download blocks deletion, including a complete base needed by a private adapter', async (t) => {
  const f = fixture(t)
  await f.invoke('download', 'demo/a')
  const entered = deferred(), finish = deferred()
  f.hooks.download = async () => { entered.resolve(); await finish.promise }
  const downloading = f.invoke('download', 'demo/b')
  await entered.promise
  assert.equal((await f.invoke('deleteSharedGroup', 'demo', 'base')).success, false)
  assert.equal(f.removed.length, 0)
  finish.resolve()
  await downloading
})

test('paused shared cancellation cleans the original target and preserves completed files', async (t) => {
  const f = fixture(t)
  const groupDir = join(f.settings.modelsDir, 'demo', '_shared', 'base')
  f.hooks.download = async () => {
    mkdirSync(groupDir, { recursive: true })
    writeFileSync(join(groupDir, 'weights.bin.part'), 'partial')
    writeFileSync(join(groupDir, 'finished.bin'), 'complete')
    throw new Error('Model download paused')
  }
  assert.equal((await f.invoke('download', 'demo/a')).paused, true)
  f.settings.modelsDir = join(f.root, 'new-models')
  assert.equal((await f.invoke('cancelDownload', 'demo/a')).success, true)
  assert.equal(existsSync(join(groupDir, 'weights.bin.part')), false)
  assert.equal(existsSync(join(groupDir, 'finished.bin')), true)
})

test('paused cleanup cannot delete a sibling download partials', async (t) => {
  const f = fixture(t)
  f.hooks.download = async () => { throw new Error('Model download paused') }
  await f.invoke('download', 'demo/a')
  const entered = deferred(), finish = deferred()
  f.hooks.download = async () => { entered.resolve(); await finish.promise }
  const sibling = f.invoke('download', 'demo/b')
  await entered.promise
  const result = await f.invoke('cancelDownload', 'demo/a')
  assert.equal(result.success, false)
  assert.match(result.error, /busy/)
  finish.resolve()
  await sibling
})

test('private failure notifies readiness changes and preserves the usable shared base', async (t) => {
  const f = fixture(t), normalDownload = f.hooks.download
  f.hooks.download = async (id) => {
    if (id === 'demo/b') throw new Error('adapter failed')
    await normalDownload(id)
  }
  const result = await f.invoke('download', 'demo/b')
  assert.equal(result.success, false)
  assert.equal(await f.invoke('isDownloaded', 'demo/a'), true)
  assert.equal(await f.invoke('isDownloaded', 'demo/b'), false)
  assert.ok(f.events.filter(([name]) => name === 'model:weightsChanged').length >= 2)
})

test('physical locks reject case aliases and parent roots without blocking unrelated roots', () => {
  const locks = new realOperations.ModelWeightOperations()
  const release = locks.acquire('node', [resolve('Models/Demo/Fast')])
  assert.throws(() => locks.acquire('alias', [resolve('models/demo/fast')]), /busy/)
  assert.throws(() => locks.acquire('extension', [resolve('models/demo')]), /busy/)
  locks.acquire('sibling', [resolve('models/demo/other')])()
  release()
  assert.equal(locks.busy, false)
})

for (const action of ['pauseDownload', 'cancelDownload']) {
  test(`${action} at a target boundary does not start the private source`, async (t) => {
    const f = fixture(t), entered = deferred(), finish = deferred()
    f.hooks.download = async () => { entered.resolve(); await finish.promise }
    const downloading = f.invoke('download', 'demo/b')
    await entered.promise
    const stopping = f.invoke(action, 'demo/b')
    finish.resolve()
    assert.equal((await stopping).success, true)
    const result = await downloading
    assert.equal(result[action === 'pauseDownload' ? 'paused' : 'cancelled'], true)
    assert.deepEqual(f.calls, ['demo/_shared/base'])
  })
}

test('model path changes are rejected while weights are reserved', async (t) => {
  const f = fixture(t), entered = deferred(), finish = deferred()
  f.hooks.download = async () => { entered.resolve(); await finish.promise }
  const downloading = f.invoke('download', 'demo/a')
  await entered.promise
  await assert.rejects(f.handlers.get('settings:set')(null, { modelsDir: join(f.root, 'new') }), /busy/)
  assert.equal((await f.handlers.get('api:updatePaths')(null, { modelsDir: join(f.root, 'new') })).success, false)
  finish.resolve()
  await downloading
})

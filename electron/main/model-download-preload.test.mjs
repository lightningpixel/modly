import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

function loadModule() {
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-preload-download-')), 'electron-api.cjs')
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve('electron/preload/electron-api.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return require(outfile)
}

test('renderer model actions keep node and shared-weight identities explicit', async () => {
  const { createElectronApi } = loadModule()
  const calls = []
  const ipc = {
    invoke: async (...args) => { calls.push(args); return { success: true } },
    send: () => {},
    on: () => {},
    removeAllListeners: () => {},
  }
  const api = createElectronApi(ipc, { setZoomFactor: () => {} })

  await api.model.isDownloaded('pixal3d/generate')
  await api.model.hasLocalData('pixal3d/generate')
  await api.model.sharedGroups('pixal3d')
  await api.model.download('pixal3d/generate')
  await api.model.deleteSharedGroup('pixal3d', 'base')
  await api.model.deleteExtensionWeights('pixal3d')

  assert.deepEqual(calls, [
    ['model:isDownloaded', 'pixal3d/generate'],
    ['model:hasLocalData', 'pixal3d/generate'],
    ['model:sharedGroups', 'pixal3d'],
    ['model:download', 'pixal3d/generate'],
    ['model:deleteSharedGroup', 'pixal3d', 'base'],
    ['model:deleteExtensionWeights', 'pixal3d'],
  ])
})

test('UI exposes partial-data removal and dependent-node warnings', () => {
  const page = readFileSync(resolve('src/areas/models/ModelsPage.tsx'), 'utf8')
  const drawer = readFileSync(resolve('src/areas/models/components/ExtensionDrawer.tsx'), 'utf8')

  assert.match(page, /window\.electron\.model\.hasLocalData\(fullId\)/)
  assert.match(page, /deleteExtensionWeights\(extId\)/)
  assert.match(drawer, /localDataIds\.includes\(fullId\) && state\.kind !== 'downloading'/)
  assert.match(drawer, /Remove partial model data/)
  assert.match(drawer, /following nodes will become unavailable/)
})

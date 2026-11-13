import assert from 'node:assert/strict'
import test from 'node:test'

import type { AssetLibraryEntry, AssetThumbnailSaveResult } from '../types/assetLibrary'
import {
  createAssetThumbnailQueue,
  entriesNeedingThumbnails,
  meshUrlForWorkspacePath,
  workspacePathFromMeshUrl,
} from './assetThumbnailQueue.ts'

const IMAGE = new Uint8Array([1, 2, 3])

function fakeDeps(options: { cached?: Set<string>, version?: () => string, save?: () => AssetThumbnailSaveResult, renderFails?: boolean } = {}) {
  const renders: string[] = []
  const saves: Array<{ workspacePath: string, version: string }> = []
  let active = 0
  let maxActive = 0
  let idle = 0
  const deps = {
    status: async (workspacePath: string) => ({
      success: true as const,
      workspacePath,
      version: options.version?.() ?? 'v1',
      thumbnailUrl: options.cached?.has(workspacePath) ? `modly-thumb://thumbnails/${workspacePath}` : undefined,
    }),
    save: async (request: { workspacePath: string, version: string }) => {
      saves.push({ workspacePath: request.workspacePath, version: request.version })
      return options.save?.() ?? { success: true as const, thumbnailUrl: `modly-thumb://thumbnails/${request.workspacePath}` }
    },
    render: async (workspacePath: string) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      renders.push(workspacePath)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      if (options.renderFails) throw new Error('bad mesh')
      return IMAGE
    },
    onIdle: () => { idle += 1 },
  }
  return { deps, renders, saves, stats: () => ({ maxActive, idle }) }
}

test('mesh URLs map to workspace paths for glb/gltf only', () => {
  assert.equal(workspacePathFromMeshUrl('/workspace/Default/hero.glb'), 'Default/hero.glb')
  assert.equal(workspacePathFromMeshUrl('/workspace/My%20Coll/hero.gltf?v=2'), 'My Coll/hero.gltf')
  assert.equal(workspacePathFromMeshUrl('/workspace/Default/part.stl'), null)
  assert.equal(workspacePathFromMeshUrl('/optimize/serve-file?path=C%3A%2Fhero.glb'), null)
  assert.equal(workspacePathFromMeshUrl('/workspace/%E0%A4%A.glb'), null)
  assert.equal(meshUrlForWorkspacePath('http://127.0.0.1:8765/', 'My Coll/hero #1.glb'), 'http://127.0.0.1:8765/workspace/My%20Coll/hero%20%231.glb')
})

test('only ready, openable 3D entries without a thumbnail need one', () => {
  const base: AssetLibraryEntry = {
    id: 'a', workspacePath: 'Workflows/a.glb', displayName: 'a.glb', sourceScope: 'workflows',
    state: 'ready', previewKind: '3d-model', warnings: [], openable: true,
  }
  const entries: AssetLibraryEntry[] = [
    base,
    { ...base, id: 'b', thumbnailUrl: 'modly-thumb://thumbnails/b' },
    { ...base, id: 'c', previewKind: 'text', openable: false },
    { ...base, id: 'd', state: 'unsafe' },
  ]
  assert.deepEqual(entriesNeedingThumbnails(entries).map((entry) => entry.id), ['a'])
})

test('renders serially, dedupes in-flight paths and skips cached versions', async () => {
  const { deps, renders, saves, stats } = fakeDeps({ cached: new Set(['Workflows/cached.glb']) })
  const queue = createAssetThumbnailQueue(deps)
  const results = await Promise.all([
    queue.ensure('Workflows/a.glb'),
    queue.ensure('Workflows/a.glb'),
    queue.ensure('Workflows/b.glb'),
    queue.ensure('Workflows/cached.glb'),
  ])
  assert.deepEqual(results, [
    'modly-thumb://thumbnails/Workflows/a.glb',
    'modly-thumb://thumbnails/Workflows/a.glb',
    'modly-thumb://thumbnails/Workflows/b.glb',
    'modly-thumb://thumbnails/Workflows/cached.glb',
  ])
  assert.deepEqual(renders, ['Workflows/a.glb', 'Workflows/b.glb'])
  assert.deepEqual(saves, [{ workspacePath: 'Workflows/a.glb', version: 'v1' }, { workspacePath: 'Workflows/b.glb', version: 'v1' }])
  assert.equal(stats().maxActive, 1)
  assert.equal(stats().idle, 1)
})

test('a version that failed to render is not retried until the file changes', async () => {
  let version = 'v1'
  const { deps, renders } = fakeDeps({ renderFails: true, version: () => version })
  const queue = createAssetThumbnailQueue(deps)
  assert.equal(await queue.ensure('Workflows/broken.glb'), null)
  assert.equal(await queue.ensure('Workflows/broken.glb'), null)
  assert.equal(renders.length, 1)
  version = 'v2'
  await queue.ensure('Workflows/broken.glb')
  assert.equal(renders.length, 2)
})

test('reports each thumbnail once per processed request, and nothing for failures', async () => {
  const { deps } = fakeDeps({ cached: new Set(['Workflows/cached.glb']) })
  const ready: Array<[string, string]> = []
  const queue = createAssetThumbnailQueue({ ...deps, onReady: (path, url) => { ready.push([path, url]) } })
  await Promise.all([queue.ensure('Workflows/a.glb'), queue.ensure('Workflows/a.glb'), queue.ensure('Workflows/cached.glb')])
  assert.deepEqual(ready, [
    ['Workflows/a.glb', 'modly-thumb://thumbnails/Workflows/a.glb'],
    ['Workflows/cached.glb', 'modly-thumb://thumbnails/Workflows/cached.glb'],
  ])

  const failing = fakeDeps({ renderFails: true })
  const silent: string[] = []
  await createAssetThumbnailQueue({ ...failing.deps, onReady: (path) => { silent.push(path) } }).ensure('Workflows/broken.glb')
  assert.deepEqual(silent, [])
})

test('a stale save is retried on the next request', async () => {
  let stale = true
  const { deps, renders } = fakeDeps({
    save: () => stale
      ? { success: false, error: { code: 'stale', message: 'changed' } }
      : { success: true, thumbnailUrl: 'modly-thumb://thumbnails/x' },
  })
  const queue = createAssetThumbnailQueue(deps)
  assert.equal(await queue.ensure('Workflows/a.glb'), null)
  stale = false
  assert.equal(await queue.ensure('Workflows/a.glb'), 'modly-thumb://thumbnails/x')
  assert.equal(renders.length, 2)
})

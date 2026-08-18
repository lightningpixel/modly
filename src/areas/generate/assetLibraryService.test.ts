import assert from 'node:assert/strict'
import test from 'node:test'

import { createAssetLibraryService } from './assetLibraryService.ts'

test('renderer service validates requests before IPC and projects structured errors', async () => {
  let invoked = false
  const service = createAssetLibraryService({
    list: async () => ({ success: true, entries: [] }),
    read: async () => { invoked = true; return { success: false, error: { code: 'not-found', message: 'should not run' } } },
    open: async () => { invoked = true; return { success: false, error: { code: 'not-found', message: 'should not run' } } },
  })

  const read = await service.read({ workspacePath: '../escape.glb' })
  const open = await service.open({ workspacePath: '/tmp/hero.glb' })
  assert.equal(read.success, false)
  assert.equal(!read.success && read.error.code, 'unsafe-path')
  assert.equal(open.success, false)
  assert.equal(!open.success && open.error.code, 'unsafe-path')
  assert.equal(invoked, false)
})

test('renderer service validates sourceWorkspacePath before read and open IPC calls', async () => {
  let invoked = false
  const service = createAssetLibraryService({
    list: async () => ({ success: true, entries: [] }),
    read: async () => { invoked = true; return { success: false, error: { code: 'not-found', message: 'should not run' } } },
    open: async () => { invoked = true; return { success: false, error: { code: 'not-found', message: 'should not run' } } },
  })

  const read = await service.read({ workspacePath: 'Workflows/hero.landmarks.v1.json', sourceWorkspacePath: '../secret.glb' })
  const open = await service.open({ workspacePath: 'Workflows/hero.landmarks.v1.json', sourceWorkspacePath: 'C:\\secret.glb' })

  assert.equal(read.success, false)
  assert.equal(!read.success && read.error.code, 'unsafe-path')
  assert.equal(open.success, false)
  assert.equal(!open.success && open.error.code, 'unsafe-path')
  assert.equal(invoked, false)
})

test('renderer service delegates safe IPC calls and normalizes returned entries', async () => {
  let openRequest: unknown = null
  const service = createAssetLibraryService({
    list: async () => ({
      success: true,
      entries: [{
        id: 'asset', workspacePath: 'Workflows/hero.glb', displayName: 'hero.glb', sourceScope: 'workflows',
        capability: 'mesh', state: 'ready', previewKind: '3d-model', warnings: ['a', 'a'], openable: true,
      }],
    }),
    read: async () => ({ success: false, error: { code: 'not-found', message: 'Missing' } }),
    open: async (request) => { openRequest = request; return { success: false, error: { code: 'not-found', message: 'Missing' } } },
  })

  const result = await service.list()
  assert.equal(result.success, true)
  assert.deepEqual(result.success && result.entries[0]?.warnings, ['a'])
  await service.open({ workspacePath: 'Workflows/hero.landmarks.v1.json', sourceWorkspacePath: 'Workflows/hero.glb' })
  assert.deepEqual(openRequest, { workspacePath: 'Workflows/hero.landmarks.v1.json', sourceWorkspacePath: 'Workflows/hero.glb' })
})

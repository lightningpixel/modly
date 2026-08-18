import assert from 'node:assert/strict'
import test from 'node:test'

import { createElectronApi } from './electron-api.ts'

test('preload exposes scoped workspace library list/read/open methods', async () => {
  const calls: Array<{ channel: string, payload?: unknown }> = []
  const api = createElectronApi({
    invoke: async (channel: string, payload?: unknown) => {
      calls.push({ channel, payload })
      return { success: true, entries: [] }
    },
    send: () => undefined,
    on: () => undefined,
    removeAllListeners: () => undefined,
  }, { setZoomFactor: () => undefined })

  await api.workspace.library.list()
  await api.workspace.library.read({
    workspacePath: 'Workflows/checkpoints/hero.landmarks.v1.json',
    sourceWorkspacePath: 'Workflows/checkpoints/hero.glb',
  })
  await api.workspace.library.open({
    workspacePath: 'Workflows/checkpoints/hero.landmarks.v1.json',
    sourceWorkspacePath: 'Workflows/checkpoints/hero.glb',
  })
  await api.workspace.library.thumbnail({ workspacePath: 'Exports/hero.glb' })
  await api.workspace.library.thumbnail({ workspacePath: 'Exports/hero.glb', previewClip: 'walk' })

  assert.deepEqual(calls, [
    { channel: 'workspace:library:list', payload: undefined },
    {
      channel: 'workspace:library:read',
      payload: {
        workspacePath: 'Workflows/checkpoints/hero.landmarks.v1.json',
        sourceWorkspacePath: 'Workflows/checkpoints/hero.glb',
      },
    },
    {
      channel: 'workspace:library:open',
      payload: {
        workspacePath: 'Workflows/checkpoints/hero.landmarks.v1.json',
        sourceWorkspacePath: 'Workflows/checkpoints/hero.glb',
      },
    },
    { channel: 'workspace:library:thumbnail', payload: { workspacePath: 'Exports/hero.glb' } },
    { channel: 'workspace:library:thumbnail', payload: { workspacePath: 'Exports/hero.glb', previewClip: 'walk' } },
  ])
})

import assert from 'node:assert/strict'
import test from 'node:test'

import type { TextureWatchUpdate } from '../../src/shared/types/liveTexture.ts'
import { createElectronApi } from './electron-api.ts'

test('preload exposes texture watching without exposing file system internals', async () => {
  const invokes: string[] = []
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const api = createElectronApi({
    invoke: async (channel: string) => {
      invokes.push(channel)
      return channel === 'texture:chooseAndWatch'
        ? { cancelled: true }
        : undefined
    },
    send: () => undefined,
    on: (channel, listener) => listeners.set(channel, listener),
    removeAllListeners: (channel) => listeners.delete(channel),
  }, { setZoomFactor: () => undefined })

  await api.texture.chooseAndWatch()
  await api.texture.stopWatching()
  assert.deepEqual(invokes, ['texture:chooseAndWatch', 'texture:stopWatching'])

  let received: TextureWatchUpdate | null = null
  api.texture.onChange((update) => { received = update })
  listeners.get('texture:changed')?.({}, {
    state: 'reading',
    filePath: '/tmp/paint.png',
    fileName: 'paint.png',
    revision: 2,
    changedAt: 1,
  })
  assert.equal(received?.state, 'reading')

  api.texture.offChange()
  assert.equal(listeners.has('texture:changed'), false)
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { useAssetThumbnailStore } from './assetThumbnailStore'

test('records rendered thumbnails by workspace path and ignores repeats', () => {
  const { setThumbnailUrl } = useAssetThumbnailStore.getState()
  setThumbnailUrl('Workflows/a.glb', 'modly-thumb://a@v1')
  const afterFirst = useAssetThumbnailStore.getState().urls
  setThumbnailUrl('Workflows/a.glb', 'modly-thumb://a@v1')
  assert.equal(useAssetThumbnailStore.getState().urls, afterFirst)
  setThumbnailUrl('Workflows/b.glb', 'modly-thumb://b@v1')
  setThumbnailUrl('Workflows/a.glb', 'modly-thumb://a@v2')
  assert.deepEqual(useAssetThumbnailStore.getState().urls, {
    'Workflows/a.glb': 'modly-thumb://a@v2',
    'Workflows/b.glb': 'modly-thumb://b@v1',
  })
})

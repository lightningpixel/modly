import assert from 'node:assert/strict'
import test from 'node:test'

import type { AssetLibraryEntry } from '../../shared/types/assetLibrary'
import { projectAssetLibraryEntry, type ProjectedAssetLibraryEntry } from '../generate/assetLibraryProjection'
import { formatRelativeDate, selectRecentAssets } from './recents'

function entry(name: string, overrides: Partial<AssetLibraryEntry> = {}): ProjectedAssetLibraryEntry {
  return projectAssetLibraryEntry({
    id: `library:${name}`,
    workspacePath: `Workflows/run/${name}`,
    displayName: name,
    sourceScope: 'workflows',
    capability: 'mesh',
    state: 'ready',
    previewKind: '3d-model',
    warnings: [],
    openable: true,
    ...overrides,
  })
}

test('recent assets are the newest openable ones, newest first, capped', () => {
  const entries = [
    entry('old.glb', { createdAt: '2026-01-01T00:00:00.000Z' }),
    entry('new.glb', { createdAt: '2026-03-01T00:00:00.000Z' }),
    entry('mid.glb', { createdAt: '2026-02-01T00:00:00.000Z' }),
    entry('locked.glb', { createdAt: '2026-04-01T00:00:00.000Z', state: 'unsafe', openable: false }),
    entry('notes.txt', { createdAt: '2026-05-01T00:00:00.000Z', previewKind: 'text', openable: false }),
  ]
  assert.deepEqual(selectRecentAssets(entries).map((e) => e.displayName), ['new.glb', 'mid.glb', 'old.glb'])
  assert.deepEqual(selectRecentAssets(entries, 2).map((e) => e.displayName), ['new.glb', 'mid.glb'])
  assert.deepEqual(selectRecentAssets([]), [])
})

test('formatRelativeDate reads ISO dates relative to now', () => {
  const now = Date.parse('2026-11-14T12:00:00.000Z')
  // English whatever the OS language, like the rest of the UI.
  assert.equal(formatRelativeDate('2026-11-14T11:55:00.000Z', now), '5 minutes ago')
  assert.equal(formatRelativeDate('2026-11-13T12:00:00.000Z', now), 'yesterday')
  assert.equal(formatRelativeDate('2026-11-14T11:59:50.000Z', now), 'this minute')
  assert.equal(formatRelativeDate('nope', now), null)
  assert.equal(formatRelativeDate(undefined, now), null)
})

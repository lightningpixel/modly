import assert from 'node:assert/strict'
import test from 'node:test'

import type { AssetLibraryEntry } from '../../shared/types/assetLibrary'
import { projectAssetLibraryEntry, type ProjectedAssetLibraryEntry } from '../generate/assetLibraryProjection'
import {
  DEFAULT_LIBRARY_QUERY,
  capabilityLabel,
  libraryCapabilityOptions,
  libraryScopeOptions,
  selectLibraryEntries,
  type LibraryQuery,
} from './libraryView'

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

const ENTRIES = [
  entry('zebra.glb', { createdAt: '2026-01-01T00:00:00.000Z' }),
  entry('apple.glb', { createdAt: '2026-03-01T00:00:00.000Z' }),
  entry('rig.glb', { capability: 'rigged-mesh', createdAt: '2026-02-01T00:00:00.000Z' }),
  entry('export.glb', { sourceScope: 'exports', workspacePath: 'Exports/export.glb', createdAt: '2025-12-01T00:00:00.000Z' }),
  entry('hidden.glb', { workspacePath: 'Workflows/run/tmp/hidden.glb' }),
  entry('unsupported.bin', { state: 'unsupported' }),
  entry('loose.glb', { capability: undefined }),
]

const names = (entries: ProjectedAssetLibraryEntry[]) => entries.map((e) => e.displayName)
const query = (overrides: Partial<LibraryQuery>): LibraryQuery => ({ ...DEFAULT_LIBRARY_QUERY, ...overrides })

test('sorts globally by date (newest first) or name, hiding entries the picker hides', () => {
  assert.deepEqual(names(selectLibraryEntries(ENTRIES, query({ sort: 'date' }))), ['apple.glb', 'rig.glb', 'zebra.glb', 'export.glb'])
  assert.deepEqual(names(selectLibraryEntries(ENTRIES, query({ sort: 'name' }))), ['apple.glb', 'export.glb', 'rig.glb', 'zebra.glb'])
})

test('type sort keeps the picker order: scope, then capability, then name', () => {
  assert.deepEqual(names(selectLibraryEntries(ENTRIES, query({ sort: 'type' }))), ['apple.glb', 'zebra.glb', 'rig.glb', 'export.glb'])
})

test('filters by capability, source scope and search together', () => {
  assert.deepEqual(names(selectLibraryEntries(ENTRIES, query({ capability: 'rigged-mesh' }))), ['rig.glb'])
  assert.deepEqual(names(selectLibraryEntries(ENTRIES, query({ scope: 'exports' }))), ['export.glb'])
  assert.deepEqual(names(selectLibraryEntries(ENTRIES, query({ search: 'APP' }))), ['apple.glb'])
  assert.deepEqual(names(selectLibraryEntries(ENTRIES, query({ search: 'apple', capability: 'rigged-mesh' }))), [])
})

test('filter options count what each choice would show', () => {
  assert.deepEqual(libraryScopeOptions(ENTRIES).map((o) => [o.value, o.count]), [['all', 4], ['workflows', 3], ['exports', 1]])
  assert.deepEqual(libraryCapabilityOptions(ENTRIES).map((o) => [o.value, o.count]), [['all', 4], ['mesh', 3], ['rigged-mesh', 1]])
  assert.equal(capabilityLabel('rigged-mesh'), 'Rigged mesh')
  assert.equal(capabilityLabel(undefined), 'Asset')
})

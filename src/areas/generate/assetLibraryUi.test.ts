import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildAssetLibraryOpenRequest,
  createAssetLibraryOpenJob,
  describeAssetLibraryOpenability,
  filterAssetLibraryScopeGroups,
  getDefaultAssetLibraryCollapsedSectionKeys,
  isAssetLibraryEntryOpenable,
  resolveOpenPanelAfterLibrarySelection,
  toggleAssetLibrarySectionKey,
  type AssetLibrarySortMode,
  type GenerateOpenPanel,
} from './assetLibraryUi.ts'
import { projectAssetLibraryEntry, resolveAssetLibraryOpenTarget, type ProjectedAssetLibraryEntry } from './assetLibraryProjection.ts'
import type { AssetLibraryEntry } from '../../shared/types/assetLibrary.ts'

function entry(overrides: Partial<AssetLibraryEntry> = {}): ProjectedAssetLibraryEntry {
  const base: AssetLibraryEntry = {
    id: 'library:Workflows/hero.glb',
    workspacePath: 'Workflows/hero.glb',
    displayName: 'hero.glb',
    sourceScope: 'workflows',
    capability: 'mesh',
    state: 'ready',
    previewKind: '3d-model',
    warnings: [],
    openable: true,
    createdAt: '2026-06-16T10:00:00.000Z',
    ...overrides,
  }
  return projectAssetLibraryEntry(base)
}

function groupPaths(entries: ProjectedAssetLibraryEntry[], search = '', sortMode: AssetLibrarySortMode = 'type'): string[] {
  return filterAssetLibraryScopeGroups(entries, search, sortMode).flatMap((scopeGroup) => (
    scopeGroup.entryGroups.flatMap((group) => group.entries.map((item) => item.workspacePath))
  ))
}

test('organizes visible library assets by scope and capability with collapsible section keys', () => {
  const entries = [
    entry({ id: 'workflow-mesh', workspacePath: 'Workflows/run/hero.glb', displayName: 'hero.glb', sourceScope: 'workflows', capability: 'mesh' }),
    entry({ id: 'export-rig', workspacePath: 'Exports/rig/hero-rig.gltf', displayName: 'hero-rig.gltf', sourceScope: 'exports', capability: 'rigged-mesh' }),
    entry({ id: 'hidden-cache', workspacePath: 'Workflows/run/cache/internal.glb', displayName: 'internal.glb', sourceScope: 'workflows' }),
    entry({ id: 'unsupported', workspacePath: 'Exports/readme.txt', displayName: 'readme.txt', sourceScope: 'exports', state: 'unsupported', openable: false }),
  ]

  const groups = filterAssetLibraryScopeGroups(entries, '', 'type')
  assert.deepEqual(groups.map((group) => [group.sourceScope, group.entryGroups.map((entryGroup) => entryGroup.capability)]), [
    ['workflows', ['mesh']],
    ['exports', ['rigged-mesh']],
  ])
  assert.deepEqual(groupPaths(entries), ['Workflows/run/hero.glb', 'Exports/rig/hero-rig.gltf'])
  assert.equal(getDefaultAssetLibraryCollapsedSectionKeys().includes('scope:workflows'), true)
  assert.deepEqual(toggleAssetLibrarySectionKey(['scope:workflows'], 'scope:workflows'), [])
  assert.deepEqual(toggleAssetLibrarySectionKey([], 'scope:exports'), ['scope:exports'])
})

test('searches workspace assets by name path capability scope source and manifest while supporting name/date sorting', () => {
  const entries = [
    entry({ id: 'b', workspacePath: 'Workflows/run/zebra.glb', displayName: 'zebra.glb', sourceScope: 'workflows', capability: 'mesh', createdAt: '2026-06-15T10:00:00.000Z' }),
    entry({ id: 'a', workspacePath: 'Exports/rig/alpha.gltf', displayName: 'alpha.gltf', sourceScope: 'exports', capability: 'rigged-mesh', createdAt: '2026-06-16T10:00:00.000Z' }),
    entry({
      id: 'c', workspacePath: 'Exports/motion/walk.json', displayName: 'walk.json', sourceScope: 'exports', capability: 'animation-motion', openable: false, previewKind: 'text',
      source: { workspacePath: 'Workflows/run/zebra.glb', displayName: 'zebra.glb' },
      manifest: { workspacePath: 'Exports/motion/walk.scene.json', capability: 'scene-manifest' },
    }),
  ]

  assert.deepEqual(groupPaths(entries, 'rigged'), ['Exports/rig/alpha.gltf'])
  assert.deepEqual(groupPaths(entries, 'walk.scene'), ['Exports/motion/walk.json'])
  assert.deepEqual(groupPaths(entries, 'zebra.glb'), ['Workflows/run/zebra.glb', 'Exports/motion/walk.json'])
  assert.deepEqual(groupPaths(entries, 'exports', 'name'), ['Exports/rig/alpha.gltf', 'Exports/motion/walk.json'])
  assert.deepEqual(groupPaths(entries, '', 'date'), ['Workflows/run/zebra.glb', 'Exports/rig/alpha.gltf', 'Exports/motion/walk.json'])
})

test('opens only safe glb and gltf entries through existing Generate job and history state', () => {
  const glb = entry({ workspacePath: 'Workflows/run/hero.glb', displayName: 'hero.glb' })
  const ply = entry({ workspacePath: 'Exports/scan.ply', displayName: 'scan.ply', openable: false, nonOpenableReason: 'Only .glb/.gltf workspace assets are openable in this release.' })

  assert.equal(isAssetLibraryEntryOpenable(glb), true)
  assert.equal(isAssetLibraryEntryOpenable(ply), false)
  assert.equal(describeAssetLibraryOpenability(glb), 'Ready to open this asset directly in Generate.')
  assert.equal(describeAssetLibraryOpenability(ply), 'Only .glb/.gltf workspace assets are openable in this release.')
  assert.deepEqual(buildAssetLibraryOpenRequest(glb), { workspacePath: 'Workflows/run/hero.glb' })

  const target = resolveAssetLibraryOpenTarget(glb)
  assert.equal(target.kind, 'self')
  if (target.kind !== 'self') throw new Error('expected self target')

  const selection = createAssetLibraryOpenJob(glb, target, 1718546400000)
  if (!selection) throw new Error('expected open selection')
  assert.equal(selection.historyUrl, '/workspace/Workflows/run/hero.glb')
  assert.equal(selection.job.status, 'done')
  assert.equal(selection.job.outputUrl, '/workspace/Workflows/run/hero.glb')
  assert.equal(selection.job.originalOutputUrl, '/workspace/Workflows/run/hero.glb')
  assert.equal(resolveOpenPanelAfterLibrarySelection('library' satisfies GenerateOpenPanel), 'library')
})

test('builds linked-source open requests and import jobs for safe sidecars', () => {
  const sidecar = entry({
    id: 'sidecar',
    workspacePath: 'Workflows/run/hero.landmarks.v1.json',
    displayName: 'hero.landmarks.v1.json',
    capability: 'landmarks-sidecar',
    previewKind: 'text',
    openable: false,
    source: { workspacePath: 'Workflows/run/hero.glb', displayName: 'hero.glb' },
  })

  assert.equal(isAssetLibraryEntryOpenable(sidecar), true)
  assert.equal(describeAssetLibraryOpenability(sidecar), 'Ready to open linked source hero.glb in Generate.')
  assert.deepEqual(buildAssetLibraryOpenRequest(sidecar), {
    workspacePath: 'Workflows/run/hero.landmarks.v1.json',
    sourceWorkspacePath: 'Workflows/run/hero.glb',
  })

  const target = resolveAssetLibraryOpenTarget(sidecar)
  assert.equal(target.kind, 'linked-source')
  if (target.kind !== 'linked-source') throw new Error('expected linked source target')
  const selection = createAssetLibraryOpenJob(sidecar, target, 1718546400001)
  assert.equal(selection?.historyUrl, '/workspace/Workflows/run/hero.glb')
  assert.equal(selection?.job.outputUrl, '/workspace/Workflows/run/hero.glb')
})

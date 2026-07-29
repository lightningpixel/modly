import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildAssetLibraryOpenRequest,
  buildAssetLibraryProjectGroups,
  clampAssetLibraryPanelHeight,
  clampAssetLibraryPanelWidth,
  createAssetLibraryOpenJob,
  createDefaultAssetLibraryFilters,
  describeAssetLibraryOpenability,
  findAssetLibraryMotionClipIndex,
  formatAssetLibraryClipName,
  getAssetLibraryPanelLayout,
  getDefaultAssetLibraryCollapsedSectionKeys,
  getStoredAssetLibraryPanelHeight,
  getStoredAssetLibraryPanelWidth,
  isAssetLibraryEntryOpenable,
  isAssetLibrarySectionExpanded,
  resolveOpenPanelAfterLibrarySelection,
  storeAssetLibraryPanelHeight,
  storeAssetLibraryPanelWidth,
  toggleAssetLibrarySectionKey,
  type AssetLibraryFilters,
  type AssetLibrarySortMode,
  type GenerateOpenPanel,
} from './assetLibraryUi.ts'
import { projectAssetLibraryEntry, resolveAssetLibraryOpenTarget, type ProjectedAssetLibraryEntry } from './assetLibraryProjection.ts'
import type { AssetLibraryEntry } from '../../shared/types/assetLibrary.ts'

function entry(overrides: Partial<AssetLibraryEntry> = {}): ProjectedAssetLibraryEntry {
  const base: AssetLibraryEntry = {
    id: 'library:Default/hero.glb',
    workspacePath: 'Default/hero.glb',
    displayName: 'hero.glb',
    sourceScope: 'generated',
    capability: 'mesh',
    state: 'ready',
    previewKind: '3d-model',
    warnings: [],
    openable: true,
    createdAt: '2026-06-16T10:00:00.000Z',
    semantic: { name: 'Hero', tags: ['mid-poly'] },
    ...overrides,
  }
  return projectAssetLibraryEntry(base)
}

const root = entry({
  id: 'root',
  workspacePath: 'Default/hero.glb',
  displayName: 'Hero',
  createdAt: '2026-06-15T10:00:00.000Z',
  semantic: { name: 'Hero', tags: ['mid-poly'] },
})

const derived = entry({
  id: 'derived',
  workspacePath: 'Exports/adventure/hero-rigged.glb',
  displayName: 'Hero Rigged',
  sourceScope: 'exports',
  capability: 'rigged-mesh',
  createdAt: '2026-06-18T10:00:00.000Z',
  semantic: {
    name: 'Hero Rigged',
    project: 'Adventure',
    tags: ['rigged', 'animated', 'character', 'mid-poly', 'clip-hero-walk'],
    derivedFrom: {
      parent: { workspacePath: 'Default/hero.glb', displayName: 'Hero' },
      root: { workspacePath: 'Default/hero.glb', displayName: 'Hero' },
    },
  },
})

const prop = entry({
  id: 'prop',
  workspacePath: 'Exports/props/chair.glb',
  displayName: 'Chair',
  sourceScope: 'exports',
  createdAt: '2026-06-17T10:00:00.000Z',
  semantic: { name: 'Chair', project: 'Props', tags: ['prop', 'low-poly', 'textured'] },
})

const unnamed = entry({
  id: 'unnamed',
  workspacePath: 'Workflows/run/1785_abcd.glb',
  displayName: '1785_abcd.glb',
  sourceScope: 'workflows',
  createdAt: '2026-06-19T10:00:00.000Z',
  semantic: { tags: ['unnamed', 'high-poly'] },
})

function groups(
  entries: ProjectedAssetLibraryEntry[],
  search = '',
  sortMode: AssetLibrarySortMode = 'date',
  filters: AssetLibraryFilters = createDefaultAssetLibraryFilters(),
) {
  return buildAssetLibraryProjectGroups(entries, search, sortMode, filters)
}

test('groups by project and collapses every version that shares a lineage root', () => {
  const result = groups([root, derived, prop, unnamed])

  assert.deepEqual(result.map((group) => group.projectLabel), ['Adventure', 'Props', 'Needs project'])
  const heroFamily = result[0].families[0]
  assert.equal(heroFamily.rootWorkspacePath, 'Default/hero.glb')
  assert.equal(heroFamily.primaryEntry.id, 'derived')
  assert.deepEqual(heroFamily.entries.map((item) => item.id), ['derived', 'root'])
  assert.equal(result.reduce((count, group) => count + group.families.length, 0), 3)
  assert.equal(result.reduce((count, group) => count + group.entryCount, 0), 4)
  assert.deepEqual(getDefaultAssetLibraryCollapsedSectionKeys(), [])
  assert.deepEqual(toggleAssetLibrarySectionKey([], 'project:adventure'), ['project:adventure'])
})

test('searches semantic metadata and lineage while filters answer real asset questions', () => {
  const entries = [root, derived, prop, unnamed]

  assert.deepEqual(groups(entries, 'clip-hero-walk').map((group) => group.projectLabel), ['Adventure'])
  assert.deepEqual(groups(entries, 'Default/hero.glb')[0].families[0].entries.map((item) => item.id), ['derived', 'root'])
  assert.deepEqual(groups(entries, 'props').map((group) => group.projectLabel), ['Props'])

  assert.deepEqual(groups(entries, '', 'date', { kind: 'rigged', poly: 'all', needsAttention: false }).map((group) => group.projectLabel), ['Adventure'])
  assert.deepEqual(groups(entries, '', 'date', { kind: 'animated', poly: 'all', needsAttention: false }).map((group) => group.projectLabel), ['Adventure'])
  assert.deepEqual(groups(entries, '', 'date', { kind: 'character', poly: 'all', needsAttention: false }).map((group) => group.projectLabel), ['Adventure'])
  assert.deepEqual(groups(entries, '', 'date', { kind: 'prop', poly: 'all', needsAttention: false }).map((group) => group.projectLabel), ['Props'])
  assert.deepEqual(groups(entries, '', 'date', { kind: 'all', poly: 'high-poly', needsAttention: false }).map((group) => group.projectLabel), ['Needs project'])
  assert.deepEqual(groups(entries, '', 'date', { kind: 'all', poly: 'all', needsAttention: true }).map((group) => group.projectLabel), ['Needs project'])
})

test('defaults to newest-first families and retains name and type sorting', () => {
  const olderProp = entry({
    id: 'older-prop',
    workspacePath: 'Exports/props/table.glb',
    displayName: 'Table',
    sourceScope: 'exports',
    createdAt: '2026-06-14T10:00:00.000Z',
    semantic: { name: 'Table', project: 'Props', tags: ['prop', 'high-poly'] },
  })

  assert.deepEqual(groups([olderProp, prop])[0].families.map((family) => family.name), ['Chair', 'Table'])
  assert.deepEqual(groups([olderProp, prop], '', 'name')[0].families.map((family) => family.name), ['Chair', 'Table'])
  assert.deepEqual(groups([root, derived, prop], '', 'type').flatMap((group) => group.families.map((family) => family.name)), ['Hero Rigged', 'Chair'])
})

test('opens safe Default, Workflows, and Exports models through existing Generate job state', () => {
  const glb = entry({ workspacePath: 'Default/hero.glb', displayName: 'Hero' })
  const ply = entry({ workspacePath: 'Exports/scan.ply', displayName: 'scan.ply', sourceScope: 'exports', openable: false, nonOpenableReason: 'Only .glb/.gltf workspace assets are openable in this release.' })

  assert.equal(isAssetLibraryEntryOpenable(glb), true)
  assert.equal(isAssetLibraryEntryOpenable(ply), false)
  assert.equal(describeAssetLibraryOpenability(glb), 'Ready to open this asset directly in Generate.')
  assert.equal(describeAssetLibraryOpenability(ply), 'Only .glb/.gltf workspace assets are openable in this release.')
  assert.deepEqual(buildAssetLibraryOpenRequest(glb), { workspacePath: 'Default/hero.glb' })

  const target = resolveAssetLibraryOpenTarget(glb)
  assert.equal(target.kind, 'self')
  if (target.kind !== 'self') throw new Error('expected self target')

  const selection = createAssetLibraryOpenJob(glb, target, 1718546400000)
  assert.equal(selection.historyUrl, '/workspace/Default/hero.glb')
  assert.equal(selection.job.status, 'done')
  assert.equal(selection.job.libraryEntryId, glb.id)
  assert.equal(selection.job.libraryWorkspacePath, glb.workspacePath)
  assert.equal(resolveOpenPanelAfterLibrarySelection('library' satisfies GenerateOpenPanel), 'library')
})

test('builds linked-source open requests and import jobs for safe sidecars', () => {
  const sidecar = entry({
    id: 'sidecar',
    workspacePath: 'Workflows/run/hero.landmarks.v1.json',
    displayName: 'hero.landmarks.v1.json',
    sourceScope: 'workflows',
    capability: 'landmarks-sidecar',
    previewKind: 'text',
    openable: false,
    source: { workspacePath: 'Default/hero.glb', displayName: 'hero.glb' },
  })

  assert.equal(isAssetLibraryEntryOpenable(sidecar), true)
  assert.deepEqual(buildAssetLibraryOpenRequest(sidecar), {
    workspacePath: 'Workflows/run/hero.landmarks.v1.json',
    sourceWorkspacePath: 'Default/hero.glb',
  })
})

test('Library panel clamps to gallery-safe bounds and degrades silently without localStorage', () => {
  assert.equal(clampAssetLibraryPanelWidth(0), 560)
  assert.equal(clampAssetLibraryPanelWidth(9999), 1200)
  assert.equal(clampAssetLibraryPanelWidth(700), 700)
  assert.equal(getStoredAssetLibraryPanelWidth(), 880)
  assert.doesNotThrow(() => storeAssetLibraryPanelWidth(700))

  assert.equal(clampAssetLibraryPanelHeight(0), 420)
  assert.equal(clampAssetLibraryPanelHeight(9999), 1200)
  assert.equal(clampAssetLibraryPanelHeight(500), 500)
  assert.equal(getStoredAssetLibraryPanelHeight(), 900)
  assert.doesNotThrow(() => storeAssetLibraryPanelHeight(500))
})

test('Library panel shifts, shrinks, and flips to stay inside zoomed viewports', () => {
  const zoomed = getAssetLibraryPanelLayout(
    { left: 420, right: 500, top: 40, bottom: 70 },
    { width: 640, height: 430 },
    880,
    900,
  )
  assert.deepEqual(zoomed, {
    left: 12,
    top: 74,
    width: 616,
    height: 344,
    placement: 'below',
  })
  assert.ok(zoomed.left >= 0)
  assert.ok(zoomed.left + zoomed.width <= 640)
  assert.ok(zoomed.top + zoomed.height <= 430)

  const flipped = getAssetLibraryPanelLayout(
    { left: 700, right: 780, top: 700, bottom: 730 },
    { width: 1000, height: 800 },
    560,
    600,
  )
  assert.deepEqual(flipped, {
    left: 428,
    top: 96,
    width: 560,
    height: 600,
    placement: 'above',
  })
})

test('live discovery expands matching projects without overwriting collapse state', () => {
  const collapsed = ['project:adventure']
  assert.equal(isAssetLibrarySectionExpanded(collapsed, 'project:adventure', false), false)
  assert.equal(isAssetLibrarySectionExpanded(collapsed, 'project:props', false), true)
  assert.equal(isAssetLibrarySectionExpanded(collapsed, 'project:adventure', true), true)
})

test('formats machine clip names as legible animation names', () => {
  assert.equal(formatAssetLibraryClipName('slow_turn_glance'), 'Slow Turn Glance')
  assert.equal(formatAssetLibraryClipName('RigAction'), 'Rig Action')
  assert.equal(findAssetLibraryMotionClipIndex([{ name: 'Idle' }, { name: 'slow-turn_glance' }], 'slow_turn_glance'), 1)
  assert.equal(findAssetLibraryMotionClipIndex([{ name: 'Idle' }], 'Walk'), -1)
})

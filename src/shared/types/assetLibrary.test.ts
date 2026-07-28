import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ASSET_CAPABILITIES,
  ASSET_ENTRY_STATES,
  ASSET_LIBRARY_MANIFEST_CAPABILITIES,
  ASSET_LIBRARY_PREVIEW_KINDS,
  ASSET_LIBRARY_SOURCE_SCOPES,
} from './assetLibrary.ts'
import type {
  AssetLibraryEntry,
  AssetLibraryListResult,
  AssetLibraryOpenRequest,
  AssetLibraryReadResult,
  AssetLibrarySourceLink,
  AssetLibraryThumbnailRequest,
  AssetLibraryThumbnailResult,
} from './assetLibrary.ts'

test('declares capability-first asset taxonomy without extension categories', () => {
  assert.deepEqual(ASSET_CAPABILITIES, [
    'mesh',
    'rigged-mesh',
    'animation-motion',
    'landmarks-sidecar',
    'generated-world',
    'scene-manifest',
  ])
  assert.deepEqual(ASSET_ENTRY_STATES, ['ready', 'unknown-metadata', 'unsupported', 'unsafe'])
  assert.deepEqual(ASSET_LIBRARY_PREVIEW_KINDS, ['3d-model', 'text', 'binary', 'none'])
  assert.deepEqual(ASSET_LIBRARY_SOURCE_SCOPES, ['generated', 'workflows', 'exports'])
  assert.deepEqual(ASSET_LIBRARY_MANIFEST_CAPABILITIES, ['generated-world', 'scene-manifest'])
  assert.equal((ASSET_CAPABILITIES as readonly string[]).includes('glb'), false)
  assert.equal((ASSET_CAPABILITIES as readonly string[]).includes('splat'), false)
})

test('AssetLibraryEntry keeps capability, source scope, provenance, warnings, and openability explicit', () => {
  const entry = {
    id: 'library:Workflows/checkpoints/hero.glb',
    workspacePath: 'Workflows/checkpoints/hero.glb',
    displayName: 'hero.glb',
    sourceScope: 'workflows',
    capability: 'rigged-mesh',
    state: 'ready',
    previewKind: '3d-model',
    provenance: { workflowId: 'wf-1', workflowNodeId: 'node-1' },
    warnings: ['Rig metadata was inferred from a sidecar.'],
    openable: true,
    semantic: {
      name: 'Hero',
      project: 'Adventure',
      tags: ['rigged', 'animated', 'mid-poly'],
      created: '2026-06-16T10:00:00.000Z',
      derivedFrom: {
        parent: { workspacePath: 'Default/hero.glb', displayName: 'Hero' },
        root: { workspacePath: 'Default/hero.glb', displayName: 'Hero' },
      },
    },
  } satisfies AssetLibraryEntry

  const list = { success: true, entries: [entry] } satisfies AssetLibraryListResult
  assert.equal(list.entries[0]?.capability, 'rigged-mesh')
  assert.equal(list.entries[0]?.sourceScope, 'workflows')
  assert.equal(list.entries[0]?.provenance?.workflowId, 'wf-1')
  assert.equal(list.entries[0]?.warnings[0], 'Rig metadata was inferred from a sidecar.')
  assert.equal(list.entries[0]?.openable, true)
  assert.equal(list.entries[0]?.semantic?.project, 'Adventure')
  assert.equal(list.entries[0]?.semantic?.derivedFrom?.root.workspacePath, 'Default/hero.glb')
})

test('structured results preserve renderer-visible error codes and read previews', () => {
  const failure = {
    success: false,
    error: { code: 'unsafe-path', message: 'Workspace path escapes the allowed roots.' },
  } satisfies AssetLibraryListResult
  const read = {
    success: true,
    entry: {
      id: 'library:Exports/model.ply',
      workspacePath: 'Exports/model.ply',
      displayName: 'model.ply',
      sourceScope: 'exports',
      capability: 'mesh',
      state: 'ready',
      previewKind: 'binary',
      warnings: [],
      openable: false,
      nonOpenableReason: '.ply workspace assets are list-only in this release.',
    },
    preview: { kind: 'binary', byteLength: 12, binaryKind: 'ply', message: 'Binary preview is unavailable.' },
  } satisfies AssetLibraryReadResult

  assert.equal(failure.error.code, 'unsafe-path')
  assert.equal(read.preview.kind, 'binary')
  assert.equal(read.entry.openable, false)
})

test('AssetLibraryEntry carries library-owned source, manifest, artifact, version, and provenance metadata', () => {
  const source = {
    workspacePath: 'Workflows/checkpoints/hero.glb',
    displayName: 'hero.glb',
    role: 'source-mesh',
  } satisfies AssetLibrarySourceLink
  const entry = {
    id: 'library:Workflows/checkpoints/hero.landmarks.v1.json',
    workspacePath: 'Workflows/checkpoints/hero.landmarks.v1.json',
    displayName: 'hero.landmarks.v1.json',
    sourceScope: 'workflows',
    capability: 'landmarks-sidecar',
    state: 'ready',
    previewKind: 'text',
    source,
    manifest: {
      workspacePath: 'Workflows/checkpoints/hero.scene.json',
      capability: 'scene-manifest',
    },
    artifactId: 'artifact-hero',
    versionId: 'version-1',
    provenance: { workflowId: 'wf-1', workflowNodeId: 'node-1', source: 'library-sidecar' },
    warnings: [],
    openable: false,
  } satisfies AssetLibraryEntry

  assert.equal(entry.source?.workspacePath, 'Workflows/checkpoints/hero.glb')
  assert.equal(entry.manifest?.capability, 'scene-manifest')
  assert.equal(entry.artifactId, 'artifact-hero')
  assert.equal(entry.versionId, 'version-1')
  assert.equal(entry.provenance?.source, 'library-sidecar')
})

test('thumbnail requests and results can carry a previewClip name and its clip list', () => {
  // Typed (not `satisfies`) so the omitted optional `previewClip` is still
  // part of `staticRequest`'s type instead of narrowing it away entirely.
  const staticRequest: AssetLibraryThumbnailRequest = { workspacePath: 'Exports/hero.glb' }
  const clipRequest: AssetLibraryThumbnailRequest = { workspacePath: 'Exports/hero.glb', previewClip: 'walk' }
  const staticResult = {
    success: true,
    dataUrl: 'data:image/png;base64,aa',
    previews: [{ clip: 'idle', duration: 1.5 }, { clip: 'walk', duration: 0.8 }],
  } satisfies AssetLibraryThumbnailResult
  const clipResult = { success: true, dataUrl: 'data:image/webp;base64,bb' } satisfies AssetLibraryThumbnailResult
  const miss = { success: false } satisfies AssetLibraryThumbnailResult

  assert.equal(staticRequest.previewClip, undefined)
  assert.equal(clipRequest.previewClip, 'walk')
  assert.equal(staticResult.previews?.[1]?.clip, 'walk')
  assert.equal(clipResult.success && clipResult.dataUrl, 'data:image/webp;base64,bb')
  assert.equal(miss.success, false)
})

test('read and open requests can carry a sourceWorkspacePath for linked-source opens', () => {
  const request = {
    workspacePath: 'Workflows/checkpoints/hero.landmarks.v1.json',
    sourceWorkspacePath: 'Workflows/checkpoints/hero.glb',
  } satisfies AssetLibraryOpenRequest

  assert.equal(request.workspacePath, 'Workflows/checkpoints/hero.landmarks.v1.json')
  assert.equal(request.sourceWorkspacePath, 'Workflows/checkpoints/hero.glb')
})

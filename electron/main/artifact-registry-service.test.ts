import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  classifyAssetLibraryCandidate,
  listWorkspaceAssetLibrary,
  normalizeWorkspaceAssetPath,
  openWorkspaceAssetLibraryEntry,
  readWorkspaceAssetLibraryEntry,
  readWorkspaceAssetLibraryThumbnail,
  registerWorkspaceAssetLibraryIpcHandlers,
} from './artifact-registry-service.ts'

async function withWorkspace(run: (workspaceDir: string) => Promise<void>) {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), 'modly-library-'))
  try {
    await run(workspaceDir)
  } finally {
    await rm(workspaceDir, { recursive: true, force: true })
  }
}

test('normalizes only workspace-relative paths under allowed Workflows and Exports roots', () => withWorkspace(async (workspaceDir) => {
  assert.equal(normalizeWorkspaceAssetPath(workspaceDir, 'Workflows/checkpoints/hero.glb').workspacePath, 'Workflows/checkpoints/hero.glb')
  assert.equal(normalizeWorkspaceAssetPath(workspaceDir, 'Exports/hero.glb').workspacePath, 'Exports/hero.glb')
  assert.throws(() => normalizeWorkspaceAssetPath(workspaceDir, '../secret.glb'), /traversal|escape|relative/i)
  assert.throws(() => normalizeWorkspaceAssetPath(workspaceDir, '/tmp/secret.glb'), /absolute/i)
  assert.throws(() => normalizeWorkspaceAssetPath(workspaceDir, 'Workflows/%2e%2e/secret.glb'), /encoded/i)
  assert.throws(() => normalizeWorkspaceAssetPath(workspaceDir, 'Collections/hero.glb'), /allowed workspace library roots/i)
}))

test('classifies supported assets by capability instead of extension category', () => {
  assert.deepEqual(classifyAssetLibraryCandidate({ workspacePath: 'Workflows/a.glb' }), {
    capability: 'mesh', state: 'ready', previewKind: '3d-model', openable: true,
  })
  assert.deepEqual(classifyAssetLibraryCandidate({ workspacePath: 'Workflows/rigged.gltf', hasRigMetadata: true }), {
    capability: 'rigged-mesh', state: 'ready', previewKind: '3d-model', openable: true,
  })
  assert.equal(classifyAssetLibraryCandidate({ workspacePath: 'Workflows/motion.bvh' }).capability, 'animation-motion')
  assert.equal(classifyAssetLibraryCandidate({ workspacePath: 'Workflows/scan.splat' }).openable, false)
  assert.equal(classifyAssetLibraryCandidate({ workspacePath: 'Workflows/notes.txt' }).state, 'unsupported')
})

test('lists Workflows and Exports assets while skipping hidden, cache, and internal files', () => withWorkspace(async (workspaceDir) => {
  await mkdir(path.join(workspaceDir, 'Workflows/checkpoints'), { recursive: true })
  await mkdir(path.join(workspaceDir, 'Workflows/.hidden'), { recursive: true })
  await mkdir(path.join(workspaceDir, 'Workflows/cache'), { recursive: true })
  await mkdir(path.join(workspaceDir, 'Exports'), { recursive: true })
  await writeFile(path.join(workspaceDir, 'Workflows/checkpoints/hero.glb'), 'glb')
  await writeFile(path.join(workspaceDir, 'Workflows/checkpoints/hero.rigmeta.json'), '{}')
  await writeFile(path.join(workspaceDir, 'Workflows/.hidden/private.glb'), 'glb')
  await writeFile(path.join(workspaceDir, 'Workflows/cache/temp.glb'), 'glb')
  await writeFile(path.join(workspaceDir, 'Exports/exported.ply'), 'ply')

  const result = await listWorkspaceAssetLibrary({ workspaceDir })
  assert.equal(result.success, true)
  assert.deepEqual(result.success && result.entries.map((entry) => entry.workspacePath), [
    'Exports/exported.ply',
    'Workflows/checkpoints/hero.glb',
  ])
  assert.equal(result.success && result.entries.find((entry) => entry.workspacePath.endsWith('hero.glb'))?.capability, 'rigged-mesh')
  assert.equal(result.success && result.entries.find((entry) => entry.workspacePath.endsWith('exported.ply'))?.openable, false)
}))

test('reads and opens only safe GLB/GLTF workspace assets', () => withWorkspace(async (workspaceDir) => {
  await mkdir(path.join(workspaceDir, 'Workflows/checkpoints'), { recursive: true })
  await mkdir(path.join(workspaceDir, 'Exports'), { recursive: true })
  await writeFile(path.join(workspaceDir, 'Workflows/checkpoints/hero.glb'), 'glb')
  await writeFile(path.join(workspaceDir, 'Exports/static.ply'), 'ply')

  const read = await readWorkspaceAssetLibraryEntry({ workspaceDir, workspacePath: 'Workflows/checkpoints/hero.glb' })
  assert.equal(read.success, true)
  assert.equal(read.success && read.preview.kind, '3d-model')
  const opened = await openWorkspaceAssetLibraryEntry({ workspaceDir, workspacePath: 'Workflows/checkpoints/hero.glb' })
  assert.equal(opened.success, true)
  assert.equal(opened.success && opened.entry.openable, true)
  const blocked = await openWorkspaceAssetLibraryEntry({ workspaceDir, workspacePath: 'Exports/static.ply' })
  assert.equal(blocked.success, false)
  assert.equal(!blocked.success && blocked.error.code, 'not-openable')
  const unsafe = await readWorkspaceAssetLibraryEntry({ workspaceDir, workspacePath: '../secret.glb' })
  assert.equal(unsafe.success, false)
  assert.equal(!unsafe.success && unsafe.error.code, 'unsafe-path')
}))

test('Electron read/open boundary rejects Windows absolute and UNC workspace paths', () => withWorkspace(async (workspaceDir) => {
  await mkdir(path.join(workspaceDir, 'Workflows/checkpoints'), { recursive: true })
  await writeFile(path.join(workspaceDir, 'Workflows/checkpoints/hero.glb'), 'glb')

  const unsafeWorkspacePaths = [
    'C:\\Users\\x\\asset.glb',
    'C:/Users/x/asset.glb',
    '\\\\server\\share\\asset.glb',
  ]

  for (const workspacePath of unsafeWorkspacePaths) {
    const read = await readWorkspaceAssetLibraryEntry({ workspaceDir, workspacePath })
    const opened = await openWorkspaceAssetLibraryEntry({ workspaceDir, workspacePath })

    assert.equal(read.success, false, `${workspacePath} should be rejected for read`)
    assert.equal(!read.success && read.error.code, 'unsafe-path')
    assert.equal(opened.success, false, `${workspacePath} should be rejected for open`)
    assert.equal(!opened.success && opened.error.code, 'unsafe-path')
  }
}))

test('Electron read/open boundary rejects Windows absolute and UNC sourceWorkspacePath values', () => withWorkspace(async (workspaceDir) => {
  await mkdir(path.join(workspaceDir, 'Workflows/checkpoints'), { recursive: true })
  await writeFile(path.join(workspaceDir, 'Workflows/checkpoints/hero.glb'), 'glb')
  await writeFile(path.join(workspaceDir, 'Workflows/checkpoints/hero.landmarks.v1.json'), JSON.stringify({
    sourceWorkspacePath: 'Workflows/checkpoints/hero.glb',
  }))

  const unsafeSourcePaths = [
    'C:\\Users\\x\\asset.glb',
    'C:/Users/x/asset.glb',
    '\\\\server\\share\\asset.glb',
  ]

  for (const sourceWorkspacePath of unsafeSourcePaths) {
    const read = await readWorkspaceAssetLibraryEntry({
      workspaceDir,
      workspacePath: 'Workflows/checkpoints/hero.landmarks.v1.json',
      sourceWorkspacePath,
    })
    const opened = await openWorkspaceAssetLibraryEntry({
      workspaceDir,
      workspacePath: 'Workflows/checkpoints/hero.landmarks.v1.json',
      sourceWorkspacePath,
    })

    assert.equal(read.success, false, `${sourceWorkspacePath} should be rejected as read source`)
    assert.equal(!read.success && read.error.code, 'unsafe-path')
    assert.equal(opened.success, false, `${sourceWorkspacePath} should be rejected as open source`)
    assert.equal(!opened.success && opened.error.code, 'unsafe-path')
  }
}))

test('enriches sidecars with safe source, manifest, artifact, version, and provenance metadata', () => withWorkspace(async (workspaceDir) => {
  await mkdir(path.join(workspaceDir, 'Workflows/checkpoints'), { recursive: true })
  await writeFile(path.join(workspaceDir, 'Workflows/checkpoints/hero.glb'), 'glb')
  await writeFile(path.join(workspaceDir, 'Workflows/checkpoints/hero.scene.json'), JSON.stringify({ schema: 'scene-manifest' }))
  await writeFile(path.join(workspaceDir, 'Workflows/checkpoints/hero.landmarks.v1.json'), JSON.stringify({
    sourceWorkspacePath: 'Workflows/checkpoints/hero.glb',
    manifestWorkspacePath: 'Workflows/checkpoints/hero.scene.json',
    artifactId: 'artifact-hero',
    versionId: 'version-1',
    provenance: { workflowId: 'wf-1', workflowNodeId: 'node-1' },
  }))

  const read = await readWorkspaceAssetLibraryEntry({ workspaceDir, workspacePath: 'Workflows/checkpoints/hero.landmarks.v1.json' })

  assert.equal(read.success, true)
  if (!read.success) return
  assert.equal(read.entry.source?.workspacePath, 'Workflows/checkpoints/hero.glb')
  assert.equal(read.entry.manifest?.workspacePath, 'Workflows/checkpoints/hero.scene.json')
  assert.equal(read.entry.manifest?.capability, 'scene-manifest')
  assert.equal(read.entry.artifactId, 'artifact-hero')
  assert.equal(read.entry.versionId, 'version-1')
  assert.equal(read.entry.provenance?.workflowId, 'wf-1')
}))

test('fails closed for unsafe, self, missing, and mismatched sourceWorkspacePath opens', () => withWorkspace(async (workspaceDir) => {
  await mkdir(path.join(workspaceDir, 'Workflows/checkpoints'), { recursive: true })
  await writeFile(path.join(workspaceDir, 'Workflows/checkpoints/hero.glb'), 'glb')
  await writeFile(path.join(workspaceDir, 'Workflows/checkpoints/other.glb'), 'glb')
  await writeFile(path.join(workspaceDir, 'Workflows/checkpoints/hero.landmarks.v1.json'), JSON.stringify({
    sourceWorkspacePath: 'Workflows/checkpoints/hero.glb',
  }))
  await writeFile(path.join(workspaceDir, 'Workflows/checkpoints/self.landmarks.v1.json'), JSON.stringify({
    sourceWorkspacePath: 'Workflows/checkpoints/self.landmarks.v1.json',
  }))
  await writeFile(path.join(workspaceDir, 'Workflows/checkpoints/missing.landmarks.v1.json'), JSON.stringify({
    sourceWorkspacePath: 'Workflows/checkpoints/missing.glb',
  }))

  const opened = await openWorkspaceAssetLibraryEntry({
    workspaceDir,
    workspacePath: 'Workflows/checkpoints/hero.landmarks.v1.json',
    sourceWorkspacePath: 'Workflows/checkpoints/hero.glb',
  })
  assert.equal(opened.success, true)
  assert.equal(opened.success && opened.entry.source?.workspacePath, 'Workflows/checkpoints/hero.glb')

  const unsafe = await openWorkspaceAssetLibraryEntry({ workspaceDir, workspacePath: 'Workflows/checkpoints/hero.landmarks.v1.json', sourceWorkspacePath: '../secret.glb' })
  const self = await openWorkspaceAssetLibraryEntry({ workspaceDir, workspacePath: 'Workflows/checkpoints/self.landmarks.v1.json', sourceWorkspacePath: 'Workflows/checkpoints/self.landmarks.v1.json' })
  const missing = await openWorkspaceAssetLibraryEntry({ workspaceDir, workspacePath: 'Workflows/checkpoints/missing.landmarks.v1.json', sourceWorkspacePath: 'Workflows/checkpoints/missing.glb' })
  const mismatched = await openWorkspaceAssetLibraryEntry({ workspaceDir, workspacePath: 'Workflows/checkpoints/hero.landmarks.v1.json', sourceWorkspacePath: 'Workflows/checkpoints/other.glb' })

  assert.equal(unsafe.success, false)
  assert.equal(!unsafe.success && unsafe.error.code, 'unsafe-path')
  assert.equal(self.success, false)
  assert.equal(!self.success && self.error.code, 'not-openable')
  assert.equal(missing.success, false)
  assert.equal(!missing.success && missing.error.code, 'not-openable')
  assert.equal(mismatched.success, false)
  assert.equal(!mismatched.success && mismatched.error.code, 'not-openable')
}))

test('reads a sibling .thumb.png for GLB assets and stays silent when one is missing', () => withWorkspace(async (workspaceDir) => {
  await mkdir(path.join(workspaceDir, 'Exports/props'), { recursive: true })
  await writeFile(path.join(workspaceDir, 'Exports/props/hero.glb'), 'glb')
  await writeFile(path.join(workspaceDir, 'Exports/props/hero.thumb.png'), 'fake-png-bytes')
  await writeFile(path.join(workspaceDir, 'Exports/props/no-thumb.glb'), 'glb')
  await writeFile(path.join(workspaceDir, 'Exports/static.ply'), 'ply')

  const withThumb = await readWorkspaceAssetLibraryThumbnail({ workspaceDir, workspacePath: 'Exports/props/hero.glb' })
  assert.equal(withThumb.success, true)
  assert.equal(withThumb.success && withThumb.dataUrl, `data:image/png;base64,${Buffer.from('fake-png-bytes').toString('base64')}`)

  const withoutThumb = await readWorkspaceAssetLibraryThumbnail({ workspaceDir, workspacePath: 'Exports/props/no-thumb.glb' })
  assert.equal(withoutThumb.success, false)

  const nonMesh = await readWorkspaceAssetLibraryThumbnail({ workspaceDir, workspacePath: 'Exports/static.ply' })
  assert.equal(nonMesh.success, false)

  const unsafe = await readWorkspaceAssetLibraryThumbnail({ workspaceDir, workspacePath: '../secret.glb' })
  assert.equal(unsafe.success, false)
}))

test('attaches preview clip metadata to the thumbnail response when a manifest exists', () => withWorkspace(async (workspaceDir) => {
  await mkdir(path.join(workspaceDir, 'Exports/props'), { recursive: true })
  await writeFile(path.join(workspaceDir, 'Exports/props/hero.glb'), 'glb')
  await writeFile(path.join(workspaceDir, 'Exports/props/hero.thumb.png'), 'fake-png-bytes')
  await writeFile(path.join(workspaceDir, 'Exports/props/hero.preview-idle.webp'), 'fake-idle-webp')
  await writeFile(path.join(workspaceDir, 'Exports/props/hero.preview-walk.webp'), 'fake-walk-webp')
  await writeFile(path.join(workspaceDir, 'Exports/props/hero.previews.json'), JSON.stringify([
    { clip: 'idle', file: 'hero.preview-idle.webp', duration: 1.5 },
    { clip: 'walk', file: 'hero.preview-walk.webp', duration: 0.8 },
  ]))

  const withThumb = await readWorkspaceAssetLibraryThumbnail({ workspaceDir, workspacePath: 'Exports/props/hero.glb' })
  assert.equal(withThumb.success, true)
  assert.deepEqual(withThumb.success && withThumb.previews, [
    { clip: 'idle', duration: 1.5 },
    { clip: 'walk', duration: 0.8 },
  ])
}))

test('fetches a specific preview clip WebP by name over the same thumbnail request', () => withWorkspace(async (workspaceDir) => {
  await mkdir(path.join(workspaceDir, 'Exports/props'), { recursive: true })
  await writeFile(path.join(workspaceDir, 'Exports/props/hero.glb'), 'glb')
  await writeFile(path.join(workspaceDir, 'Exports/props/hero.preview-walk.webp'), 'fake-walk-webp')
  await writeFile(path.join(workspaceDir, 'Exports/props/hero.previews.json'), JSON.stringify([
    { clip: 'walk', file: 'hero.preview-walk.webp', duration: 0.8 },
  ]))

  const clip = await readWorkspaceAssetLibraryThumbnail({ workspaceDir, workspacePath: 'Exports/props/hero.glb', previewClip: 'walk' })
  assert.equal(clip.success, true)
  assert.equal(clip.success && clip.dataUrl, `data:image/webp;base64,${Buffer.from('fake-walk-webp').toString('base64')}`)

  const unknownClip = await readWorkspaceAssetLibraryThumbnail({ workspaceDir, workspacePath: 'Exports/props/hero.glb', previewClip: 'sprint' })
  assert.equal(unknownClip.success, false)
}))

test('thumbnail response carries no previews field when no manifest exists, and stays silent on a malformed one', () => withWorkspace(async (workspaceDir) => {
  await mkdir(path.join(workspaceDir, 'Exports/props'), { recursive: true })
  await writeFile(path.join(workspaceDir, 'Exports/props/hero.glb'), 'glb')
  await writeFile(path.join(workspaceDir, 'Exports/props/hero.thumb.png'), 'fake-png-bytes')
  await writeFile(path.join(workspaceDir, 'Exports/props/broken.glb'), 'glb')
  await writeFile(path.join(workspaceDir, 'Exports/props/broken.thumb.png'), 'fake-png-bytes')
  await writeFile(path.join(workspaceDir, 'Exports/props/broken.previews.json'), 'not valid json{')

  const noManifest = await readWorkspaceAssetLibraryThumbnail({ workspaceDir, workspacePath: 'Exports/props/hero.glb' })
  assert.equal(noManifest.success, true)
  assert.equal(noManifest.success && noManifest.previews, undefined)

  const malformedManifest = await readWorkspaceAssetLibraryThumbnail({ workspaceDir, workspacePath: 'Exports/props/broken.glb' })
  assert.equal(malformedManifest.success, true)
  assert.equal(malformedManifest.success && malformedManifest.previews, undefined)
}))

test('rejects a preview manifest entry that tries to escape the asset directory via its file field', () => withWorkspace(async (workspaceDir) => {
  await mkdir(path.join(workspaceDir, 'Exports/props'), { recursive: true })
  await writeFile(path.join(workspaceDir, 'Exports/props/hero.glb'), 'glb')
  await writeFile(path.join(workspaceDir, 'Exports/props/hero.thumb.png'), 'fake-png-bytes')
  await writeFile(path.join(workspaceDir, 'secret.webp'), 'top-secret-bytes')
  await writeFile(path.join(workspaceDir, 'Exports/props/hero.previews.json'), JSON.stringify([
    { clip: 'escape-relative', file: '../../secret.webp', duration: 1 },
    { clip: 'escape-absolute', file: '/etc/passwd', duration: 1 },
    { clip: 'wrong-extension', file: 'hero.glb', duration: 1 },
  ]))

  // The manifest lists the clip in its metadata (harmless — it's just a name),
  // but every attempt to actually fetch the referenced file must fail closed.
  const listed = await readWorkspaceAssetLibraryThumbnail({ workspaceDir, workspacePath: 'Exports/props/hero.glb' })
  assert.equal(listed.success, true)
  assert.equal(listed.success && listed.previews?.length, 3)

  const relative = await readWorkspaceAssetLibraryThumbnail({ workspaceDir, workspacePath: 'Exports/props/hero.glb', previewClip: 'escape-relative' })
  assert.equal(relative.success, false)
  const absolute = await readWorkspaceAssetLibraryThumbnail({ workspaceDir, workspacePath: 'Exports/props/hero.glb', previewClip: 'escape-absolute' })
  assert.equal(absolute.success, false)
  const wrongExtension = await readWorkspaceAssetLibraryThumbnail({ workspaceDir, workspacePath: 'Exports/props/hero.glb', previewClip: 'wrong-extension' })
  assert.equal(wrongExtension.success, false)
}))

test('IPC thumbnail handler forwards previewClip from payload', async () => {
  const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>()
  registerWorkspaceAssetLibraryIpcHandlers({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    getWorkspaceDir: () => '/tmp/modly-workspace',
  })

  const result = await handlers.get('workspace:library:thumbnail')?.({}, { workspacePath: 'Exports/hero.glb', previewClip: 'walk' })
  // No such workspace/file in this test, so it must fail closed rather than throw.
  assert.equal((result as { success: boolean }).success, false)
})

test('IPC read and open handlers forward sourceWorkspacePath without trusting malformed payloads', async () => {
  const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>()
  registerWorkspaceAssetLibraryIpcHandlers({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    getWorkspaceDir: () => '/tmp/modly-workspace',
  })

  const result = await handlers.get('workspace:library:open')?.({}, {
    workspacePath: 'Workflows/hero.landmarks.v1.json',
    sourceWorkspacePath: '../secret.glb',
  })

  assert.equal(typeof (result as { success?: unknown }).success, 'boolean')
  assert.equal((result as { success: boolean, error?: { code: string } }).error?.code, 'unsafe-path')
})

test('registers workspace library IPC handlers with structured results', async () => {
  const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>()
  registerWorkspaceAssetLibraryIpcHandlers({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    getWorkspaceDir: () => '/tmp/modly-workspace',
  })

  assert.equal(typeof handlers.get('workspace:library:list'), 'function')
  assert.equal(typeof handlers.get('workspace:library:read'), 'function')
  assert.equal(typeof handlers.get('workspace:library:open'), 'function')
  assert.equal(typeof handlers.get('workspace:library:thumbnail'), 'function')
  const result = await handlers.get('workspace:library:read')?.({}, { workspacePath: '../escape.glb' })
  assert.equal(typeof (result as { success?: unknown }).success, 'boolean')
  assert.equal((result as { success: boolean, error?: { code: string } }).error?.code, 'unsafe-path')
  const thumbnail = await handlers.get('workspace:library:thumbnail')?.({}, { workspacePath: '../escape.glb' })
  assert.equal((thumbnail as { success: boolean }).success, false)
  const missingPayload = await handlers.get('workspace:library:thumbnail')?.({}, {})
  assert.equal((missingPayload as { success: boolean }).success, false)
})

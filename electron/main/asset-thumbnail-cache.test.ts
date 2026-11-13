import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  getThumbnailStatus,
  normalizeThumbnailSourcePath,
  pruneThumbnails,
  removeThumbnails,
  resolveThumbnailUrl,
  saveThumbnail,
  thumbnailPathKey,
  thumbnailVersion,
} from './asset-thumbnail-cache.ts'
import { listWorkspaceAssetLibrary } from './artifact-registry-service.ts'

const WEBP = new Uint8Array([...Buffer.from('RIFF'), 4, 0, 0, 0, ...Buffer.from('WEBPVP8 ')])

async function withCache(run: (context: { workspaceDir: string, thumbnailsDir: string }) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'modly-thumbs-'))
  try {
    const context = { workspaceDir: path.join(root, 'workspace'), thumbnailsDir: path.join(root, 'thumbnails') }
    await mkdir(path.join(context.workspaceDir, 'Workflows'), { recursive: true })
    await run(context)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function writeMesh(workspaceDir: string, workspacePath: string, content = 'glb', mtime = new Date('2026-01-01T00:00:00Z')) {
  const absolute = path.join(workspaceDir, ...workspacePath.split('/'))
  await mkdir(path.dirname(absolute), { recursive: true })
  await writeFile(absolute, content)
  await utimes(absolute, mtime, mtime)
}

test('cache key depends on workspace dir and path; version on mtime and size', () => {
  assert.equal(thumbnailPathKey('/a', 'Workflows/hero.glb'), thumbnailPathKey('/a', 'Workflows/hero.glb'))
  assert.notEqual(thumbnailPathKey('/a', 'Workflows/hero.glb'), thumbnailPathKey('/b', 'Workflows/hero.glb'))
  assert.notEqual(thumbnailPathKey('/a', 'Workflows/hero.glb'), thumbnailPathKey('/a', 'Workflows/other.glb'))
  assert.match(thumbnailPathKey('/a', 'Workflows/hero.glb'), /^[0-9a-f]{32}$/)
  assert.equal(thumbnailVersion({ mtimeMs: 1000.7, size: 10 }), thumbnailVersion({ mtimeMs: 1000.2, size: 10 }))
  assert.notEqual(thumbnailVersion({ mtimeMs: 1000, size: 10 }), thumbnailVersion({ mtimeMs: 2000, size: 10 }))
  assert.notEqual(thumbnailVersion({ mtimeMs: 1000, size: 10 }), thumbnailVersion({ mtimeMs: 1000, size: 11 }))
})

test('only safe workspace-relative .glb/.gltf paths are thumbnail sources', () => {
  assert.equal(normalizeThumbnailSourcePath('/ws', 'Default\\hero.glb').workspacePath, 'Default/hero.glb')
  assert.equal(normalizeThumbnailSourcePath('/ws', 'Workflows/./a/hero.GLTF').workspacePath, 'Workflows/a/hero.GLTF')
  assert.throws(() => normalizeThumbnailSourcePath('/ws', '../hero.glb'))
  assert.throws(() => normalizeThumbnailSourcePath('/ws', '/tmp/hero.glb'))
  assert.throws(() => normalizeThumbnailSourcePath('/ws', 'C:\\hero.glb'))
  assert.throws(() => normalizeThumbnailSourcePath('/ws', 'Workflows/%2e%2e/hero.glb'))
  assert.throws(() => normalizeThumbnailSourcePath('/ws', 'Workflows/notes.json'))
})

test('thumbnail URLs resolve only to cache file names', () => {
  const name = `${'a'.repeat(32)}.abc-1f-r1.webp`
  assert.equal(resolveThumbnailUrl('/cache', `modly-thumb://thumbnails/${name}`), path.join('/cache', name))
  assert.equal(resolveThumbnailUrl('/cache', 'modly-thumb://thumbnails/../secret.webp'), null)
  assert.equal(resolveThumbnailUrl('/cache', `modly-thumb://other/${name}`), null)
  assert.equal(resolveThumbnailUrl('/cache', `file:///cache/${name}`), null)
  assert.equal(resolveThumbnailUrl('/cache', 'modly-thumb://thumbnails/x.json'), null)
})

test('a saved thumbnail is served for its version and goes stale when the file changes', () => withCache(async (context) => {
  await writeMesh(context.workspaceDir, 'Workflows/hero.glb')
  const before = await getThumbnailStatus(context, 'Workflows/hero.glb')
  assert.ok(before.success)
  assert.equal(before.thumbnailUrl, undefined)

  const saved = await saveThumbnail(context, { workspacePath: 'Workflows/hero.glb', version: before.version, image: WEBP })
  assert.ok(saved.success)
  assert.ok(resolveThumbnailUrl(context.thumbnailsDir, saved.thumbnailUrl))
  const cached = await getThumbnailStatus(context, 'Workflows/hero.glb')
  assert.ok(cached.success)
  assert.equal(cached.thumbnailUrl, saved.thumbnailUrl)

  await writeMesh(context.workspaceDir, 'Workflows/hero.glb', 'edited glb', new Date('2026-02-01T00:00:00Z'))
  const edited = await getThumbnailStatus(context, 'Workflows/hero.glb')
  assert.ok(edited.success)
  assert.equal(edited.thumbnailUrl, undefined)
  assert.notEqual(edited.version, before.version)

  // A render of the old version is refused; the new version replaces the old file.
  const stale = await saveThumbnail(context, { workspacePath: 'Workflows/hero.glb', version: before.version, image: WEBP })
  assert.equal(!stale.success && stale.error.code, 'stale')
  const resaved = await saveThumbnail(context, { workspacePath: 'Workflows/hero.glb', version: edited.version, image: WEBP })
  assert.ok(resaved.success)
  const webps = (await readdir(context.thumbnailsDir)).filter((name) => name.endsWith('.webp'))
  assert.equal(webps.length, 1)
}))

test('save rejects non-WebP payloads and unsafe paths', () => withCache(async (context) => {
  await writeMesh(context.workspaceDir, 'Workflows/hero.glb')
  const status = await getThumbnailStatus(context, 'Workflows/hero.glb')
  assert.ok(status.success)
  const png = await saveThumbnail(context, { workspacePath: 'Workflows/hero.glb', version: status.version, image: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) })
  assert.equal(!png.success && png.error.code, 'invalid-image')
  const notBytes = await saveThumbnail(context, { workspacePath: 'Workflows/hero.glb', version: status.version, image: 'RIFF' })
  assert.equal(!notBytes.success && notBytes.error.code, 'invalid-image')
  const unsafe = await saveThumbnail(context, { workspacePath: '../hero.glb', version: status.version, image: WEBP })
  assert.equal(!unsafe.success && unsafe.error.code, 'unsafe-path')
  const missing = await getThumbnailStatus(context, 'Workflows/missing.glb')
  assert.equal(!missing.success && missing.error.code, 'not-found')
}))

test('removeThumbnails and pruning drop thumbnails of deleted assets', () => withCache(async (context) => {
  await writeMesh(context.workspaceDir, 'Workflows/kept.glb')
  await writeMesh(context.workspaceDir, 'Workflows/deleted.glb')
  await writeMesh(context.workspaceDir, 'Default/removed.glb')
  for (const workspacePath of ['Workflows/kept.glb', 'Workflows/deleted.glb', 'Default/removed.glb']) {
    const status = await getThumbnailStatus(context, workspacePath)
    assert.ok(status.success)
    assert.ok((await saveThumbnail(context, { workspacePath, version: status.version, image: WEBP })).success)
  }

  await removeThumbnails(context, 'Default/removed.glb')
  assert.equal((await readdir(context.thumbnailsDir)).length, 4)

  await rm(path.join(context.workspaceDir, 'Workflows', 'deleted.glb'))
  await writeFile(path.join(context.thumbnailsDir, `${'b'.repeat(32)}.abc-1-r1.webp`), WEBP)
  await pruneThumbnails(context.thumbnailsDir)
  const remaining = await readdir(context.thumbnailsDir)
  assert.equal(remaining.length, 2)
  const kept = await getThumbnailStatus(context, 'Workflows/kept.glb')
  assert.ok(kept.success && kept.thumbnailUrl)
}))

test('library entries expose thumbnailUrl only for cached renders of the current version', () => withCache(async (context) => {
  await writeMesh(context.workspaceDir, 'Workflows/hero.glb')
  await writeMesh(context.workspaceDir, 'Workflows/other.glb')
  await writeFile(path.join(context.workspaceDir, 'Workflows', 'hero.world.json'), '{}')
  const status = await getThumbnailStatus(context, 'Workflows/hero.glb')
  assert.ok(status.success)
  const saved = await saveThumbnail(context, { workspacePath: 'Workflows/hero.glb', version: status.version, image: WEBP })
  assert.ok(saved.success)

  const listed = await listWorkspaceAssetLibrary(context)
  assert.ok(listed.success)
  const byPath = new Map(listed.entries.map((entry) => [entry.workspacePath, entry]))
  assert.equal(byPath.get('Workflows/hero.glb')?.thumbnailUrl, saved.thumbnailUrl)
  assert.equal(byPath.get('Workflows/other.glb')?.thumbnailUrl, undefined)
  assert.equal(byPath.get('Workflows/hero.world.json')?.thumbnailUrl, undefined)

  const withoutCache = await listWorkspaceAssetLibrary({ workspaceDir: context.workspaceDir })
  assert.ok(withoutCache.success)
  assert.ok(withoutCache.entries.every((entry) => entry.thumbnailUrl === undefined))
}))

import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  MAX_WORKSPACE_IMAGE_BYTES,
  isRevealableImagePath,
  registerWorkspaceImageIpcHandlers,
  sanitizeImageBaseName,
  saveWorkspaceImage,
  sniffImageMime,
  validateWorkspaceImageRequest,
  workspaceImageFileName,
} from './workspace-images'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0])
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0])

async function withWorkspace(run: (workspaceDir: string) => Promise<void>) {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), 'modly-images-'))
  try {
    await run(workspaceDir)
  } finally {
    await rm(workspaceDir, { recursive: true, force: true })
  }
}

test('sniffImageMime recognises PNG, JPEG and WebP signatures only', () => {
  assert.equal(sniffImageMime(PNG), 'image/png')
  assert.equal(sniffImageMime(JPEG), 'image/jpeg')
  assert.equal(sniffImageMime(WEBP), 'image/webp')
  assert.equal(sniffImageMime(new TextEncoder().encode('GIF89a')), null)
  assert.equal(sniffImageMime(new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])), null)
  assert.equal(sniffImageMime(new Uint8Array()), null)
})

test('sanitizeImageBaseName keeps a short safe stem and never a path or device name', () => {
  assert.equal(sanitizeImageBaseName('My photo (1).png'), 'My-photo-1')
  assert.equal(sanitizeImageBaseName('../../etc/passwd'), 'passwd')
  assert.equal(sanitizeImageBaseName('C:\\Users\\me\\shot.webp'), 'shot')
  assert.equal(sanitizeImageBaseName('Café déjà vu.jpg'), 'Cafe-deja-vu')
  assert.equal(sanitizeImageBaseName('CON.png'), 'image')
  assert.equal(sanitizeImageBaseName('..'), 'image')
  assert.equal(sanitizeImageBaseName('.png'), 'png')
  assert.equal(sanitizeImageBaseName('***'), 'image')
  assert.equal(sanitizeImageBaseName(undefined), 'image')
  assert.equal(sanitizeImageBaseName(42), 'image')
  assert.ok(sanitizeImageBaseName('a'.repeat(300)).length <= 60)
})

test('workspaceImageFileName is time-stamped and suffixed', () => {
  assert.equal(workspaceImageFileName('pasted', 'png', new Date(2026, 10, 16, 9, 5, 7), 'a1b2c3'), 'pasted-20261116-090507-a1b2c3.png')
})

test('validateWorkspaceImageRequest refuses missing, oversized, unsupported and mislabelled bytes', () => {
  assert.ok('error' in validateWorkspaceImageRequest(undefined))
  assert.ok('error' in validateWorkspaceImageRequest({ bytes: 'abc', mime: 'image/png' }))
  assert.ok('error' in validateWorkspaceImageRequest({ bytes: new Uint8Array(), mime: 'image/png' }))
  assert.ok('error' in validateWorkspaceImageRequest({ bytes: PNG, mime: 'image/gif' }))
  assert.ok('error' in validateWorkspaceImageRequest({ bytes: JPEG, mime: 'image/png' }))
  const big = new Uint8Array(MAX_WORKSPACE_IMAGE_BYTES + 1)
  big.set(PNG)
  assert.ok('error' in validateWorkspaceImageRequest({ bytes: big, mime: 'image/png' }))
  assert.deepEqual(validateWorkspaceImageRequest({ bytes: JPEG, mime: 'image/jpeg', name: 'x.jpeg' }), { bytes: JPEG, extension: 'jpg', baseName: 'x' })
})

test('saveWorkspaceImage writes into <workspace>/Images and never overwrites', async () => {
  await withWorkspace(async (workspaceDir) => {
    const suffixes = ['aaaaaa', 'aaaaaa', 'bbbbbb']
    const deps = { now: () => new Date(2026, 0, 2, 3, 4, 5), randomSuffix: () => suffixes.shift() ?? 'zzzzzz' }
    const first = await saveWorkspaceImage(workspaceDir, { bytes: PNG, mime: 'image/png', name: '../evil' }, deps)
    assert.deepEqual(first, { success: true, path: path.join(workspaceDir, 'Images', 'evil-20260102-030405-aaaaaa.png') })
    // Same name and suffix: the clash draws another suffix instead of overwriting.
    const second = await saveWorkspaceImage(workspaceDir, { bytes: PNG, mime: 'image/png', name: 'evil.png' }, deps)
    assert.ok(second.success)
    assert.equal(path.basename(second.path), 'evil-20260102-030405-bbbbbb.png')
    assert.deepEqual((await readdir(path.join(workspaceDir, 'Images'))).sort(), ['evil-20260102-030405-aaaaaa.png', 'evil-20260102-030405-bbbbbb.png'])
    assert.deepEqual(new Uint8Array(await readFile(first.success ? first.path : '')), PNG)
  })
})

test('saveWorkspaceImage reports invalid requests without writing', async () => {
  await withWorkspace(async (workspaceDir) => {
    const result = await saveWorkspaceImage(workspaceDir, { bytes: new TextEncoder().encode('<svg/>'), mime: 'image/svg+xml' })
    assert.equal(result.success, false)
    assert.deepEqual(await readdir(workspaceDir), [])
    assert.equal((await saveWorkspaceImage('', { bytes: PNG, mime: 'image/png' })).success, false)
  })
})

test('isRevealableImagePath accepts only existing absolute image files', async () => {
  await withWorkspace(async (workspaceDir) => {
    const saved = await saveWorkspaceImage(workspaceDir, { bytes: PNG, mime: 'image/png' })
    assert.ok(saved.success)
    assert.equal(await isRevealableImagePath(saved.path), true)
    assert.equal(await isRevealableImagePath(path.join(workspaceDir, 'missing.png')), false)
    assert.equal(await isRevealableImagePath(path.join(workspaceDir, 'Images')), false)
    assert.equal(await isRevealableImagePath('relative.png'), false)
    assert.equal(await isRevealableImagePath(path.join(workspaceDir, 'script.exe')), false)
    assert.equal(await isRevealableImagePath(null), false)
  })
})

test('the IPC handlers save into the current workspace and reveal only images', async () => {
  await withWorkspace(async (workspaceDir) => {
    const handlers = new Map<string, (event: unknown, payload?: unknown) => Promise<unknown>>()
    const revealed: string[] = []
    registerWorkspaceImageIpcHandlers({
      ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler) } },
      getWorkspaceDir: () => workspaceDir,
      showItemInFolder: (p) => { revealed.push(p) },
    })
    const saved = await handlers.get('workspace:images:save')?.({}, { bytes: PNG, mime: 'image/png', name: 'pasted' }) as { success: boolean, path: string }
    assert.ok(saved.success)
    assert.ok(saved.path.startsWith(path.join(workspaceDir, 'Images') + path.sep))
    assert.deepEqual(await handlers.get('workspace:images:reveal')?.({}, saved.path), { success: true })
    assert.equal((await handlers.get('workspace:images:reveal')?.({}, workspaceDir) as { success: boolean }).success, false)
    assert.deepEqual(revealed, [saved.path])
  })
})

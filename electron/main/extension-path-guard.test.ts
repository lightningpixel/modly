import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

async function loadGuard() {
  return import(new URL('./extension-path-guard.ts', import.meta.url).href)
}

test('assertSafeExtensionId accepts conservative extension ids', async () => {
  const { assertSafeExtensionId } = await loadGuard()
  assert.equal(assertSafeExtensionId('mesh-process'), 'mesh-process')
  assert.equal(assertSafeExtensionId('image_model.v2'), 'image_model.v2')
  assert.equal(assertSafeExtensionId('kimodo-soma-rp'), 'kimodo-soma-rp')
})

test('assertSafeExtensionId rejects empty, traversal and absolute ids', async () => {
  const { assertSafeExtensionId } = await loadGuard()
  assert.throws(() => assertSafeExtensionId(''), /must not be empty/i)
  assert.throws(() => assertSafeExtensionId('.'), /is invalid/i)
  assert.throws(() => assertSafeExtensionId('..'), /is invalid/i)
  assert.throws(() => assertSafeExtensionId('../escape'), /path separators/i)
  assert.throws(() => assertSafeExtensionId('..\\escape'), /path separators/i)
  assert.throws(() => assertSafeExtensionId('/abs/path'), /absolute path|path separators/i)
})

test('assertSafeExtensionId rejects uppercase and unsupported characters', async () => {
  const { assertSafeExtensionId } = await loadGuard()
  assert.throws(() => assertSafeExtensionId('Mesh-Process'), /must match/i)
  assert.throws(() => assertSafeExtensionId('bad id'), /must match/i)
  assert.throws(() => assertSafeExtensionId('bad:id'), /must match/i)
})

test('resolveExtensionPathWithinRoot confines paths to root', async () => {
  const { resolveExtensionPathWithinRoot } = await loadGuard()
  const root = path.join('/tmp', 'extensions-root')
  assert.equal(resolveExtensionPathWithinRoot(root, 'mesh-process'), path.resolve(root, 'mesh-process'))
  assert.throws(() => resolveExtensionPathWithinRoot(root, '../escape'), /path separators/i)
})

test('resolvePathWithinRoot rejects canonical escapes', async () => {
  const { resolvePathWithinRoot } = await loadGuard()
  const root = path.join('/tmp', 'extensions-root')
  assert.equal(resolvePathWithinRoot(root, '.modly-backup-safe-123'), path.resolve(root, '.modly-backup-safe-123'))
  assert.throws(() => resolvePathWithinRoot(root, '../escape'), /escapes root/i)
})

test('buildExtensionBackupPath stays within root and rejects unsafe ids', async () => {
  const { buildExtensionBackupPath } = await loadGuard()
  const root = path.join('/tmp', 'extensions-root')
  assert.equal(buildExtensionBackupPath(root, 'mesh-process', '123'), path.resolve(root, '.modly-backup-mesh-process-123'))
  assert.throws(() => buildExtensionBackupPath(root, '../escape', '123'), /path separators/i)
})

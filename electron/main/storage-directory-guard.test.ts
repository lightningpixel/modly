import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  validateStorageDeletion,
  validateStorageMove,
  assertNoSymlinkAncestors,
  assertEmptyDestination,
  deleteStorageDirectory,
  moveStorageDirectory,
} from './storage-directory-guard'

const dirs = {
  modelsDir: 'E:\\modly\\models',
  workspaceDir: 'E:\\modly\\workspace',
  workflowsDir: 'E:\\modly\\workflows',
  extensionsDir: 'E:\\modly\\extensions',
  dependenciesDir: 'E:\\modly\\dependencies',
  agentDir: 'E:\\modly\\agent',
}
const home = 'C:\\Users\\Tester'
const userData = 'C:\\Users\\Tester\\AppData\\Roaming\\modly'
const opts = { platform: 'win32' as const, homeDir: home, appDir: 'C:\\Program Files\\Modly\\resources\\app.asar' }

test('deletion permits an exact configured managed directory', () => {
  assert.equal(validateStorageDeletion('e:\\MODLY\\models\\\\', dirs, userData, opts), dirs.modelsDir)
  assert.equal(validateStorageDeletion(dirs.workflowsDir, dirs, userData, opts), dirs.workflowsDir)
  assert.equal(validateStorageDeletion('E:\\modly\\workspace\\tmp', dirs, userData, opts), 'E:\\modly\\workspace\\tmp')
})

test('deletion rejects filesystem roots, shallow folders and relative paths', () => {
  for (const bad of ['E:\\\\', 'C:\\\\', 'E:\\Photos', 'models', '.', '']) {
    assert.throws(() => validateStorageDeletion(bad, { ...dirs, modelsDir: bad }, userData, opts))
  }
  assert.throws(() => validateStorageDeletion('\\\\server\\share\\models', dirs, userData, opts))
})

test('deletion requires an exact configured root or workspace/tmp (not a prefix)', () => {
  for (const bad of [
    'E:\\modly\\models-backup', 'E:\\modly\\models\\elsewhere',
    'E:\\modly\\workspace\\tmp-fake', 'E:\\modly\\workflows2',
    'E:\\elsewhere\\models',
  ]) {
    assert.throws(() => validateStorageDeletion(bad, dirs, userData, opts), /not an approved/i)
  }
})

test('deletion rejects home, application and userData ancestors even if configured', () => {
  for (const bad of [home, 'C:\\Users', 'C:\\Program Files', 'C:\\Users\\Tester\\AppData', userData]) {
    assert.throws(() => validateStorageDeletion(bad, { ...dirs, modelsDir: bad }, userData, opts))
  }
})

test('deletion refuses one configured folder enclosing another', () => {
  assert.throws(() => validateStorageDeletion(dirs.modelsDir, {
    ...dirs, workspaceDir: 'E:\\modly\\models\\my-workspace',
  }, userData, opts), /another configured/i)
})

test('move allows separate configured source and empty destination path', () => {
  assert.deepEqual(validateStorageMove(dirs.modelsDir, 'D:\\modly-assets\\models', dirs, userData, opts), {
    src: dirs.modelsDir, dest: 'D:\\modly-assets\\models',
  })
})

test('move rejects rogue sources, root, parent, child and overlapping destinations', () => {
  const badSources = ['E:\\\\', home, 'E:\\modly\\models-other', 'E:\\modly\\models\\child']
  for (const bad of badSources) {
    assert.throws(() => validateStorageMove(bad, 'D:\\modly\\models', dirs, userData, opts))
  }
  for (const bad of [
    dirs.modelsDir, 'E:\\modly', 'E:\\modly\\models\\new', 'E:\\modly\\workflows',
    'E:\\\\', 'D:\\Backups', 'E:\\modly\\workspace\\inside',
  ]) {
    assert.throws(() => validateStorageMove(dirs.modelsDir, bad, dirs, userData, opts))
  }
})

test('POSIX root and relative path are rejected', () => {
  const linuxDirs = {
    modelsDir: '/home/tester/modly/models',
    workspaceDir: '/home/tester/modly/workspace',
    workflowsDir: '/home/tester/modly/workflows',
    extensionsDir: '/home/tester/modly/extensions',
    dependenciesDir: '/home/tester/modly/dependencies',
    agentDir: '/home/tester/modly/agent',
  }
  const linuxOpts = { platform: 'linux' as const, homeDir: '/home/tester' }
  assert.equal(validateStorageDeletion(linuxDirs.modelsDir, linuxDirs, '/home/tester/.config/modly', linuxOpts), linuxDirs.modelsDir)
  assert.throws(() => validateStorageDeletion('/', { ...linuxDirs, modelsDir: '/' }, '/home/tester/.config/modly', linuxOpts))
  assert.throws(() => validateStorageMove('relative', '/tmp/safe/new', linuxDirs, '/home/tester/.config/modly', linuxOpts))
})

test('destination must be empty, missing is fine', async () => {
  const base = await mkdtemp(join(tmpdir(), 'modly-storage-'))
  try {
    await assertEmptyDestination(join(base, 'new'))
    await mkdir(join(base, 'empty'))
    await assertEmptyDestination(join(base, 'empty'))
    await writeFile(join(base, 'empty', 'personal.txt'), 'do not overwrite')
    await assert.rejects(() => assertEmptyDestination(join(base, 'empty')), /empty/i)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('symlinked ancestors and target are refused', { skip: process.platform === 'win32' }, async () => {
  const base = await mkdtemp(join(tmpdir(), 'modly-storage-link-'))
  try {
    await mkdir(join(base, 'real', 'models'), { recursive: true })
    await symlink(join(base, 'real'), join(base, 'alias'), 'dir')
    await assertNoSymlinkAncestors(join(base, 'real', 'models'))
    await assert.rejects(() => assertNoSymlinkAncestors(join(base, 'alias', 'models')), /symbolic link/i)
    await assert.rejects(() => assertNoSymlinkAncestors(join(base, 'alias')), /symbolic link/i)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('unsafe real deletion refuses a storage root and preserves personal files', async () => {
  const base = await mkdtemp(join(tmpdir(), 'modly-real-delete-'))
  const managed = join(base, 'models')
  const personal = join(base, 'personal.txt')
  const unixDirs = {
    modelsDir: managed, workspaceDir: join(base, 'workspace'),
    workflowsDir: join(base, 'workflows'), extensionsDir: join(base, 'extensions'),
    dependenciesDir: join(base, 'dependencies'), agentDir: join(base, 'agent'),
  }
  const options = { platform: process.platform, homeDir: join(base, 'other-home') }
  try {
    await mkdir(managed)
    await writeFile(personal, 'important')
    await assert.rejects(() => deleteStorageDirectory(base, { ...unixDirs, modelsDir: base },
      join(base, 'userData'), options), /ancestor|another configured|approved/i)
    assert.equal(await readFile(personal, 'utf8'), 'important')
    await deleteStorageDirectory(managed, unixDirs, join(base, 'userData'), options)
    await assert.rejects(() => access(managed))
    assert.equal(await readFile(personal, 'utf8'), 'important')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('real move does not overwrite destination files or erase unrelated data', async () => {
  const base = await mkdtemp(join(tmpdir(), 'modly-real-move-'))
  const source = join(base, 'models')
  const destination = join(base, 'migrated', 'models')
  const unixDirs = {
    modelsDir: source, workspaceDir: join(base, 'workspace'),
    workflowsDir: join(base, 'workflows'), extensionsDir: join(base, 'extensions'),
    dependenciesDir: join(base, 'dependencies'), agentDir: join(base, 'agent'),
  }
  const options = { platform: process.platform, homeDir: join(base, 'other-home') }
  try {
    await mkdir(source)
    await mkdir(destination, { recursive: true })
    await writeFile(join(source, 'asset.glb'), 'model')
    await writeFile(join(destination, 'personal.txt'), 'preserve')
    await assert.rejects(() => moveStorageDirectory(source, destination, unixDirs,
      join(base, 'userData'), options), /empty/i)
    assert.equal(await readFile(join(destination, 'personal.txt'), 'utf8'), 'preserve')
    assert.equal(await readFile(join(source, 'asset.glb'), 'utf8'), 'model')
    await rm(destination, { recursive: true })
    await moveStorageDirectory(source, destination, unixDirs, join(base, 'userData'), options)
    assert.equal(await readFile(join(destination, 'asset.glb'), 'utf8'), 'model')
    await assert.rejects(() => access(source))
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

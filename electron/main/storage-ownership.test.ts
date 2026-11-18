// #351: Modly must never delete or move what it did not create.
import assert from 'node:assert/strict'
import test from 'node:test'
import { access, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  STORAGE_MARKER,
  claimStorageDirectory,
  deleteStorageDirectory,
  isModlyOwnedRoot,
  listStorageEntries,
  moveStorageDirectory,
  validateStorageLocation,
} from './storage-directory-guard'

async function fixture(prefix: string) {
  const base = await mkdtemp(join(await realpath(tmpdir()), prefix))
  const dirs = {
    modelsDir: join(base, 'models'), workspaceDir: join(base, 'workspace'),
    workflowsDir: join(base, 'workflows'), extensionsDir: join(base, 'extensions'),
    dependenciesDir: join(base, 'dependencies'), agentDir: join(base, 'agent'),
  }
  const options = { platform: process.platform, homeDir: join(base, 'home'), knownModelIds: ['triposg', 'trellis2'] }
  return { base, dirs, options, userData: join(base, 'userData') }
}

test('#351: deleting a personal folder used as models folder keeps the personal files', async () => {
  const { base, dirs, options, userData } = await fixture('modly-351-')
  // The user had pointed Modly at a folder full of their own files.
  const drive = join(base, 'drive')
  const cfg = { ...dirs, modelsDir: drive }
  try {
    await mkdir(join(drive, 'Photos 2015'), { recursive: true })
    await writeFile(join(drive, 'Photos 2015', 'wedding.jpg'), 'irreplaceable')
    await writeFile(join(drive, 'thesis.docx'), 'ten years of work')
    await mkdir(join(drive, 'triposg', 'model'), { recursive: true })
    await writeFile(join(drive, 'triposg', 'model', 'weights.safetensors'), 'w')

    assert.deepEqual(await listStorageEntries('models', drive, cfg, options),
      { modly: ['triposg'], other: ['Photos 2015', 'thesis.docx'] })
    const result = await deleteStorageDirectory(drive, cfg, userData, options)
    assert.deepEqual(result, { removed: ['triposg'], kept: ['Photos 2015', 'thesis.docx'] })
    assert.equal(await readFile(join(drive, 'Photos 2015', 'wedding.jpg'), 'utf8'), 'irreplaceable')
    assert.equal(await readFile(join(drive, 'thesis.docx'), 'utf8'), 'ten years of work')
    await assert.rejects(() => access(join(drive, 'triposg')))
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('#351: moving a personal folder used as models folder moves only the models', async () => {
  const { base, dirs, options, userData } = await fixture('modly-351-move-')
  const drive = join(base, 'drive')
  const cfg = { ...dirs, modelsDir: drive }
  const dest = join(base, 'new-models')
  try {
    await mkdir(join(drive, 'trellis2'), { recursive: true })
    await writeFile(join(drive, 'trellis2', 'w.bin'), 'w')
    await writeFile(join(drive, 'thesis.docx'), 'ten years of work')
    const result = await moveStorageDirectory(drive, dest, cfg, userData, options)
    assert.deepEqual(result, { moved: ['trellis2'], kept: ['thesis.docx'] })
    assert.equal(await readFile(join(dest, 'trellis2', 'w.bin'), 'utf8'), 'w')
    assert.deepEqual((await readdir(dest)).sort(), [STORAGE_MARKER, 'trellis2'])
    assert.deepEqual(await readdir(drive), ['thesis.docx'])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('a folder Modly created (marker) is deleted entirely, folder included', async () => {
  const { base, dirs, options, userData } = await fixture('modly-owned-')
  const custom = join(base, 'my-workspace')
  const cfg = { ...dirs, workspaceDir: custom }
  try {
    await claimStorageDirectory(custom, userData, options)
    await mkdir(join(custom, 'My collection'))
    await writeFile(join(custom, 'My collection', 'a.glb'), 'mesh')
    assert.equal(await isModlyOwnedRoot('workspace', custom, cfg, options), true)
    const result = await deleteStorageDirectory(custom, cfg, userData, options)
    assert.deepEqual(result, { removed: ['My collection'], kept: [] })
    await assert.rejects(() => access(custom))
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('a workspace Modly did not create is never emptied', async () => {
  const { base, dirs, options, userData } = await fixture('modly-foreign-ws-')
  const docs = join(base, 'Documents')
  const cfg = { ...dirs, workspaceDir: docs }
  try {
    await mkdir(join(docs, 'Taxes'), { recursive: true })
    await writeFile(join(docs, 'Taxes', '2024.pdf'), 'keep')
    assert.equal(await isModlyOwnedRoot('workspace', docs, cfg, options), false)
    const result = await deleteStorageDirectory(docs, cfg, userData, options)
    assert.deepEqual(result, { removed: [], kept: ['Taxes'] })
    assert.equal(await readFile(join(docs, 'Taxes', '2024.pdf'), 'utf8'), 'keep')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('the first-run layout (<base>/workspace beside <base>/extensions) counts as Modly\'s', async () => {
  const { base, dirs, options } = await fixture('modly-layout-')
  try {
    assert.equal(await isModlyOwnedRoot('workspace', dirs.workspaceDir, dirs, options), true)
    assert.equal(await isModlyOwnedRoot('workflows', dirs.workflowsDir, dirs, options), true)
    // The same name elsewhere is not enough.
    assert.equal(await isModlyOwnedRoot('workspace', join(base, 'other', 'workspace'), dirs, options), false)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('a link named like an extension is not taken for a model folder', async (t) => {
  const { base, dirs, options } = await fixture('modly-link-')
  const drive = join(base, 'drive')
  try {
    await mkdir(join(base, 'precious'), { recursive: true })
    await mkdir(drive)
    try {
      await symlink(join(base, 'precious'), join(drive, 'triposg'), 'junction')
    } catch {
      t.skip('cannot create links here')
      return
    }
    assert.deepEqual(await listStorageEntries('models', drive, { ...dirs, modelsDir: drive }, options),
      { modly: [], other: ['triposg'] })
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('deleting a Modly folder removes a link inside it, never what the link points to', async (t) => {
  const { base, dirs, options, userData } = await fixture('modly-link-delete-')
  const custom = join(base, 'my-workspace')
  const cfg = { ...dirs, workspaceDir: custom }
  try {
    await claimStorageDirectory(custom, userData, options)
    await mkdir(join(base, 'precious'))
    await writeFile(join(base, 'precious', 'keep.txt'), 'keep')
    try {
      await symlink(join(base, 'precious'), join(custom, 'shortcut'), 'junction')
    } catch {
      t.skip('cannot create links here')
      return
    }
    await deleteStorageDirectory(custom, cfg, userData, options)
    await assert.rejects(() => access(custom))
    assert.equal(await readFile(join(base, 'precious', 'keep.txt'), 'utf8'), 'keep')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('claimStorageDirectory marks only new or empty folders and refuses unsafe ones', async () => {
  const { base, userData, options } = await fixture('modly-claim-')
  try {
    const fresh = join(base, 'fresh', 'models')
    await claimStorageDirectory(fresh, userData, options)
    assert.deepEqual(await readdir(fresh), [STORAGE_MARKER])

    const full = join(base, 'full')
    await mkdir(full)
    await writeFile(join(full, 'mine.txt'), 'x')
    await claimStorageDirectory(full, userData, options)
    assert.deepEqual(await readdir(full), ['mine.txt'])

    await assert.rejects(() => claimStorageDirectory(options.homeDir, userData, options), /ancestor/)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('validateStorageLocation refuses drive roots, system folders and home', () => {
  const home = 'C:\\Users\\Tester'
  const userData = 'C:\\Users\\Tester\\AppData\\Roaming\\Modly'
  const opts = { platform: 'win32' as const, homeDir: home, appDir: 'C:\\Program Files\\Modly\\resources\\app.asar' }
  for (const bad of ['E:\\', 'C:\\Windows', 'C:\\Users', home, 'C:\\Users\\Tester\\AppData']) {
    assert.throws(() => validateStorageLocation(bad, userData, opts), undefined, bad)
  }
  assert.equal(validateStorageLocation('E:\\.Modly', userData, opts), 'E:\\.Modly')
  assert.equal(validateStorageLocation('D:\\Models', userData, opts), 'D:\\Models')
})

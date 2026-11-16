import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

function loadModule() {
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-child-env-test-')), 'child-env.cjs')
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve('electron/main/child-env.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return require(outfile)
}

test('pythonChildEnv strips vars that redirect to the user\'s Python', () => {
  const { pythonChildEnv } = loadModule()
  const env = pythonChildEnv({ HOME: '/home/u', PYTHONPATH: '/x', VIRTUAL_ENV: '/venv', PIP_USER: '1', CONDA_PREFIX: '/c' })
  assert.deepEqual(env, { HOME: '/home/u' })
})

test('extensionChildEnv drops AppImage mount entries from library and binary paths (#236)', () => {
  const { extensionChildEnv } = loadModule()
  const mount = '/tmp/.mount_Modly-AbC123'
  const env = extensionChildEnv({
    APPDIR: mount,
    APPIMAGE: '/home/u/Modly.AppImage',
    LD_LIBRARY_PATH: `${mount}/usr/lib:${mount}:/usr/local/cuda/lib64`,
    LD_PRELOAD: `${mount}/usr/lib/libfoo.so /usr/lib/libbar.so`,
    PATH: `${mount}/usr/bin:/usr/local/bin:/usr/bin`,
  })
  assert.equal(env.LD_LIBRARY_PATH, '/usr/local/cuda/lib64')
  assert.equal(env.LD_PRELOAD, '/usr/lib/libbar.so')
  assert.equal(env.PATH, '/usr/local/bin:/usr/bin')
  // The AppImage identity vars themselves are harmless and kept
  assert.equal(env.APPDIR, mount)
})

test('extensionChildEnv removes a path var left empty, and keeps look-alike siblings', () => {
  const { extensionChildEnv } = loadModule()
  const mount = '/tmp/.mount_Modly-AbC123/'
  const env = extensionChildEnv({
    APPDIR: mount,
    LD_LIBRARY_PATH: '/tmp/.mount_Modly-AbC123/usr/lib',
    PATH: '/tmp/.mount_Modly-AbC123-other/bin:/usr/bin',
  })
  assert.equal('LD_LIBRARY_PATH' in env, false)
  assert.equal(env.PATH, '/tmp/.mount_Modly-AbC123-other/bin:/usr/bin')
})

test('extensionChildEnv leaves paths alone outside an AppImage', () => {
  const { extensionChildEnv } = loadModule()
  const input = { LD_LIBRARY_PATH: '/opt/lib', PATH: '/usr/bin' }
  assert.deepEqual(extensionChildEnv(input), input)
  // The caller's env object is not mutated
  const appEnv = { APPDIR: '/tmp/.mount_x', LD_LIBRARY_PATH: '/tmp/.mount_x/usr/lib' }
  extensionChildEnv(appEnv)
  assert.equal(appEnv.LD_LIBRARY_PATH, '/tmp/.mount_x/usr/lib')
})

test('pythonChildEnv keeps AppImage paths, for processes that relaunch the bundled Electron', () => {
  const { pythonChildEnv } = loadModule()
  const env = pythonChildEnv({ APPDIR: '/tmp/.mount_x', LD_LIBRARY_PATH: '/tmp/.mount_x/usr/lib', PYTHONPATH: '/x' })
  assert.deepEqual(env, { APPDIR: '/tmp/.mount_x', LD_LIBRARY_PATH: '/tmp/.mount_x/usr/lib' })
})

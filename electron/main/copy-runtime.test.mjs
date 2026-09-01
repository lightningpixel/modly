/**
 * Guards the symlink property that makes the AppImage's "stable" Python copy
 * actually stable. Getting this wrong is silent at copy time and only breaks on
 * the *next* launch, once the source mount is gone — so it needs a test that
 * checks the links rather than the copy succeeding.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import {
  mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readlinkSync, rmSync, existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, isAbsolute } from 'node:path'

function loadModule() {
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-copy-test-')), 'copy-runtime.cjs')
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve('electron/main/copy-runtime.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return require(outfile)
}

const { copyRuntimeTree } = loadModule()

// makeRuntime() below needs symlinkSync, which on Windows requires Developer
// Mode (or elevation) — and the AppImage failure mode this file guards is
// Linux-only anyway.
const symlinkOpts = {
  skip: process.platform === 'win32' && 'symlinks require Developer Mode on Windows',
}

/** Builds a miniature of the bundled runtime: a real binary plus relative links. */
function makeRuntime(root) {
  mkdirSync(join(root, 'bin'), { recursive: true })
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(join(root, 'bin', 'python3.11'), '#!/bin/sh\n', 'utf8')
  symlinkSync('python3.11', join(root, 'bin', 'python3'))
  symlinkSync('python3.11', join(root, 'bin', 'python'))
  writeFileSync(join(root, 'lib', 'libpython3.11.so.1.0'), '', 'utf8')
  symlinkSync('libpython3.11.so.1.0', join(root, 'lib', 'libpython3.11.so'))
}

test('copyRuntimeTree keeps relative symlinks relative', symlinkOpts, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'modly-runtime-'))
  const source = join(dir, 'mount', 'python-embed')
  const dest   = join(dir, 'stable', 'python-embed')
  makeRuntime(source)

  await copyRuntimeTree(source, dest)

  for (const link of ['bin/python3', 'bin/python', 'lib/libpython3.11.so']) {
    const target = readlinkSync(join(dest, link))
    assert.ok(
      !isAbsolute(target),
      `${link} was rewritten to an absolute path (${target}); it would point back at the source mount`,
    )
    assert.ok(!target.includes(source), `${link} still references the source tree`)
  }

  rmSync(dir, { recursive: true, force: true })
})

test('the copy survives the source being deleted', symlinkOpts, async () => {
  // This is the actual failure mode: the AppImage mount disappears between
  // launches, and every venv built from the copy dies with it.
  const dir = mkdtempSync(join(tmpdir(), 'modly-runtime-'))
  const source = join(dir, 'mount', 'python-embed')
  const dest   = join(dir, 'stable', 'python-embed')
  makeRuntime(source)

  await copyRuntimeTree(source, dest)
  rmSync(join(dir, 'mount'), { recursive: true, force: true })

  // existsSync follows symlinks, so this is false for a dangling link — exactly
  // the check generator_registry.py's _venv_python(...).exists() performs.
  assert.ok(existsSync(join(dest, 'bin', 'python3')), 'bin/python3 is dangling after the source went away')
  assert.ok(existsSync(join(dest, 'lib', 'libpython3.11.so')), 'libpython3.11.so is dangling')
})

test('copyRuntimeTree copies regular files and directory structure', symlinkOpts, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'modly-runtime-'))
  const source = join(dir, 'mount', 'python-embed')
  const dest   = join(dir, 'stable', 'python-embed')
  makeRuntime(source)

  await copyRuntimeTree(source, dest)

  assert.ok(existsSync(join(dest, 'bin', 'python3.11')))
  assert.ok(existsSync(join(dest, 'lib', 'libpython3.11.so.1.0')))

  rmSync(dir, { recursive: true, force: true })
})

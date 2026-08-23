import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

function loadModule() {
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-links-test-')), 'external-links.cjs')
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve('electron/main/external-links.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return require(outfile)
}

const { isSafeExternalUrl } = loadModule()

test('web and mail links open', () => {
  for (const url of [
    'https://github.com/lightningpixel/modly',
    'http://127.0.0.1:8765/workspace/a.glb',
    'mailto:someone@example.com',
  ]) {
    assert.equal(isSafeExternalUrl(url), true, url)
  }
})

test('a file URL never opens - openExternal would run what it points at', () => {
  for (const url of [
    'file:///C:/Windows/System32/calc.exe',
    'file:///tmp/payload.sh',
    'FILE:///C:/payload.exe',
  ]) {
    assert.equal(isSafeExternalUrl(url), false, url)
  }
})

test('script and foreign schemes are refused', () => {
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'ms-msdt:/id PCWDiagnostic',
    'smb://attacker.example/share',
    'vscode://file/C:/x',
  ]) {
    assert.equal(isSafeExternalUrl(url), false, url)
  }
})

test('non-URLs and non-strings are refused', () => {
  for (const value of ['', 'not a url', 'C:\\Windows\\calc.exe', null, undefined, 42, {}]) {
    assert.equal(isSafeExternalUrl(value), false, String(value))
  }
})

test('an absurdly long URL is refused rather than parsed', () => {
  assert.equal(isSafeExternalUrl('https://example.com/' + 'a'.repeat(4000)), false)
})

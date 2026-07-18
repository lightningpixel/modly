import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

function loadModule() {
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-modelutils-test-')), 'utils.cjs')
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve('src/areas/models/utils.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return require(outfile)
}

const { formatModelName } = loadModule()

test('formatModelName turns a hyphenated id into a Title-cased label', () => {
  assert.equal(formatModelName('trellis'), 'Trellis')
  assert.equal(formatModelName('stable-fast-3d'), 'Stable Fast 3d')
  assert.equal(formatModelName('hunyuan-3d-2'), 'Hunyuan 3d 2')
})

test('formatModelName only capitalizes word-initial chars (digits left as-is)', () => {
  // \b\w upper-cases the first char of each space-separated word; the "d" after
  // a digit is mid-word and stays lower-case.
  assert.equal(formatModelName('a-b-c'), 'A B C')
  assert.equal(formatModelName(''), '')
})

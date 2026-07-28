import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

function loadModule() {
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-thin-suggestion-test-')), 'suggestion.cjs')
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve('src/areas/generate/thinPartSuggestion.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return require(outfile)
}

test('the known squid false-positive band stays quiet', () => {
  const { getThinPartSuggestion } = loadModule()
  assert.equal(getThinPartSuggestion(0.955102, '1024'), null)
  assert.equal(getThinPartSuggestion(0.969999, '1024'), null)
})

test('the confirmed fan band proposes Careful without applying it', () => {
  const { getThinPartSuggestion } = loadModule()
  const currentParams = { pipeline_type: '1024', faces: 30_000, seed: 7 }
  const suggestion = getThinPartSuggestion(0.972787, currentParams.pipeline_type)
  assert.equal(suggestion.proposedSetting, '1024_cascade')
  assert.deepEqual(currentParams, { pipeline_type: '1024', faces: 30_000, seed: 7 })
})

test('accepting changes only study time and leaves file weight alone', () => {
  const { applyThinPartSuggestion } = loadModule()
  const currentParams = { pipeline_type: '1024', faces: 30_000, seed: 7 }
  const accepted = applyThinPartSuggestion(currentParams)
  assert.deepEqual(accepted, { pipeline_type: '1024_cascade', faces: 30_000, seed: 7 })
  assert.deepEqual(currentParams, { pipeline_type: '1024', faces: 30_000, seed: 7 })
})

test('already-careful settings do not prompt again', () => {
  const { getThinPartSuggestion } = loadModule()
  assert.equal(getThinPartSuggestion(1, '1024_cascade'), null)
  assert.equal(getThinPartSuggestion(1, '1536_cascade'), null)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Bundle the pure vramFit helper (no React deps) into CJS — same approach as
// autoWire.test.mjs / preflight.test.mjs.
function loadModule() {
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-vramfit-test-')), 'vramFit.cjs')
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve('src/shared/components/ui/vramFit.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return require(outfile)
}

const { vramFit } = loadModule()

test('returns null when the estimate or VRAM is unknown', () => {
  assert.equal(vramFit(undefined, 12), null)
  assert.equal(vramFit(4200, undefined), null)
  assert.equal(vramFit(4200, null), null)
  assert.equal(vramFit(0, 12), null)
})

test('"Fits" when the model sits at or under 90% of VRAM', () => {
  // 12 GB → 12288 MB; 90% = 11059 MB
  assert.equal(vramFit(4200, 12).label, 'Fits')
  assert.equal(vramFit(11059, 12).label, 'Fits')
})

test('"Tight" between 90% and 100% of VRAM', () => {
  assert.equal(vramFit(11060, 12).label, 'Tight')
  assert.equal(vramFit(12288, 12).label, 'Tight')
})

test('"Won\'t fit" above 100% of VRAM', () => {
  assert.equal(vramFit(13500, 12).label, "Won't fit")
  assert.equal(vramFit(12289, 12).label, "Won't fit")
})

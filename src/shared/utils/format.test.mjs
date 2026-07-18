import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// format.ts has no imports — bundle it straight to CJS and require.
function loadModule() {
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-format-test-')), 'format.cjs')
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve('src/shared/utils/format.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return require(outfile)
}

const { formatBytes, formatPoly, formatTime, formatDate } = loadModule()

// ─── formatBytes ───────────────────────────────────────────────────────────────

test('formatBytes picks the GB/MB/KB tier and rounds', () => {
  assert.equal(formatBytes(1.2e9), '1.2 GB')
  assert.equal(formatBytes(1e9), '1.0 GB')      // exact GB boundary
  assert.equal(formatBytes(5e8), '500 MB')
  assert.equal(formatBytes(1e6), '1 MB')        // exact MB boundary
  assert.equal(formatBytes(128e3), '128 KB')
  assert.equal(formatBytes(0), '0 KB')
})

// ─── formatPoly ────────────────────────────────────────────────────────────────

test('formatPoly abbreviates millions/thousands and leaves small counts raw', () => {
  assert.equal(formatPoly(1_500_000), '1.5M')
  assert.equal(formatPoly(1_000_000), '1.0M')   // exact M boundary
  assert.equal(formatPoly(10_500), '10.5k')
  assert.equal(formatPoly(1_000), '1.0k')       // exact k boundary
  assert.equal(formatPoly(999), '999')          // just below k
  assert.equal(formatPoly(0), '0')
})

// ─── formatTime / formatDate (locale/TZ-robust: assert shape, not exact text) ───

test('formatTime returns an hour:minute-ish string', () => {
  assert.match(formatTime(Date.parse('2025-03-08T14:32:00')), /\d/)
})

test('formatDate labels today and yesterday, and shows the year for old dates', () => {
  const now = Date.now()
  assert.equal(formatDate(now), 'Today')
  assert.equal(formatDate(now - 24 * 60 * 60 * 1000), 'Yesterday')

  const old = new Date()
  old.setFullYear(old.getFullYear() - 2)
  assert.match(formatDate(old.getTime()), new RegExp(String(old.getFullYear())))
})

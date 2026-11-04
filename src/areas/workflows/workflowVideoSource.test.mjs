import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const outfile = join(mkdtempSync(join(tmpdir(), 'modly-video-source-')), 'video.cjs')
writeFileSync(outfile, buildSync({ entryPoints: [resolve('src/areas/workflows/workflowVideoSource.ts')], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text)
const { normalizeVideoSource } = createRequire(import.meta.url)(outfile)

test('Load Video accepts durable workspace video paths only', () => {
  assert.deepEqual(normalizeVideoSource('Workflows/Videos/clip.mp4', '/workspace'), {
    workspacePath: 'Workflows/Videos/clip.mp4', absolutePath: '/workspace/Workflows/Videos/clip.mp4',
  })
  for (const value of ['../clip.mp4', '/tmp/clip.mp4', 'C:/clip.mp4', 'Workflows/%2e%2e/clip.mp4', 'Workflows/clip.exe']) {
    assert.equal(normalizeVideoSource(value, '/workspace'), undefined, value)
  }
})

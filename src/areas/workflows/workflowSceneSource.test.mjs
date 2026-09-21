import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const outfile = join(mkdtempSync(join(tmpdir(), 'modly-scene-source-')), 'scene.cjs')
writeFileSync(outfile, buildSync({ entryPoints: [resolve('src/areas/workflows/workflowSceneSource.ts')], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text)
const { resolveSceneSourceManifest } = createRequire(import.meta.url)(outfile)
const encoded = Buffer.from(JSON.stringify({ schema: 'modly.scene-manifest.v1', sceneRoot: '.', assets: [] })).toString('base64')

test('Load Scene resolves directory and manifest without image bytes', async () => {
  for (const scenePath of ['Workflows/room', 'Workflows/room/scene-manifest.json']) {
    const result = await resolveSceneSourceManifest({ scenePath, workspaceDir: '/workspace', readFileBase64: async () => encoded })
    assert.equal(result.ok, true)
    assert.equal(result.manifestWorkspacePath, 'Workflows/room/scene-manifest.json')
  }
})

test('Load Scene refuses unsafe paths before reading', async () => {
  let reads = 0
  for (const scenePath of ['../outside', '/etc/passwd', 'C:/outside', 'Workflows/%2e%2e', 'Workflows/room/']) {
    const result = await resolveSceneSourceManifest({ scenePath, workspaceDir: '/workspace', readFileBase64: async () => { reads++; return encoded } })
    assert.equal(result.ok, false, scenePath)
  }
  assert.equal(reads, 0)
})

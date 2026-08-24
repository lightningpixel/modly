import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

function loadModule() {
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-ext-store-test-')), 'extensionsStore.cjs')
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve('src/shared/stores/extensionsStore.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return require(outfile)
}

test('extension list keeps an interrupted model in the model store with recovery metadata', () => {
  const { partitionExtensionsByType } = loadModule()
  const pendingModel = {
    type: 'model',
    id: 'pixal3d',
    name: 'Pixal3D',
    trusted: false,
    builtin: false,
    nodes: [{ id: 'generate' }],
    corrupted: true,
    manifestError: 'incomplete',
  }
  const processExtension = {
    type: 'process',
    id: 'mesh-tool',
    name: 'Mesh Tool',
    trusted: false,
    builtin: false,
    entry: 'processor.js',
    nodes: [{ id: 'simplify' }],
  }

  const result = partitionExtensionsByType([pendingModel, processExtension])

  assert.deepEqual(result.modelExtensions, [pendingModel])
  assert.deepEqual(result.processExtensions, [processExtension])
})

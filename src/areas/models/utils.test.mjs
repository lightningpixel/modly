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

const {
  deleteModelsThenUninstallExtension,
  finishExtensionRepair,
  formatModelName,
  isExtensionRepairable,
} = loadModule()

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

test('only model extensions with a usable manifest expose Repair', () => {
  const model = {
    type: 'model',
    id: 'pixal3d',
    name: 'Pixal3D',
    trusted: false,
    builtin: false,
    nodes: [],
  }

  assert.equal(isExtensionRepairable(model), true)
  assert.equal(isExtensionRepairable({
    ...model,
    corrupted: true,
    manifestError: 'incomplete',
  }), true)
  assert.equal(isExtensionRepairable({
    ...model,
    corrupted: true,
    manifestError: 'invalid',
  }), false)
  assert.equal(isExtensionRepairable({
    ...model,
    builtin: true,
    corrupted: true,
    manifestError: 'incomplete',
  }), false)
  assert.equal(isExtensionRepairable({
    ...model,
    type: 'process',
    entry: 'processor.js',
  }), false)
})

test('Repair completion refreshes extension state even when setup fails', async () => {
  let refreshCount = 0
  const error = await finishExtensionRepair(
    { success: false, error: 'setup failed' },
    async () => {
      refreshCount += 1
    },
  )

  assert.equal(refreshCount, 1)
  assert.equal(error, 'setup failed')
})

test('failed selected-weight deletion aborts extension uninstall and preserves its error', async () => {
  const deleteCalls = []
  let uninstallCalls = 0

  const result = await deleteModelsThenUninstallExtension(
    'pixal3d',
    new Set([
      'pixal3d/generate',
      'pixal3d/refine',
      'pixal3d/export',
    ]),
    async (modelId) => {
      deleteCalls.push(modelId)
      return modelId === 'pixal3d/refine'
        ? { success: false, error: 'Model weights are locked.' }
        : { success: true }
    },
    async () => {
      uninstallCalls += 1
      return { success: true }
    },
  )

  assert.deepEqual(deleteCalls, ['pixal3d/generate', 'pixal3d/refine'])
  assert.equal(uninstallCalls, 0)
  assert.deepEqual(result, { success: false, error: 'Model weights are locked.' })
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

function loadModule() {
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-ext-test-')), 'extension-install-utils.cjs')
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve('electron/main/extension-install-utils.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return require(outfile)
}

test('validateInstallManifest accepts legacy flat model manifests', () => {
  const mod = loadModule()

  const validated = mod.validateInstallManifest(
    { id: 'legacy-model', generator_class: 'Generator' },
    {
      hasEntryFile: () => false,
      hasGeneratorFile: () => true,
    },
    'repository',
  )

  assert.equal(validated.id, 'legacy-model')
  assert.equal(validated.isProcess, false)
  assert.equal(validated.hasNodes, false)
})

test('validateInstallManifest still rejects missing process entry files', () => {
  const mod = loadModule()

  assert.throws(
    () => mod.validateInstallManifest(
      { id: 'proc', type: 'process', entry: 'processor.py' },
      {
        hasEntryFile: () => false,
        hasGeneratorFile: () => false,
      },
      'selected folder',
    ),
    /entry file "processor\.py" missing from selected folder/,
  )
})

test('python process setup failures are treated as fatal', () => {
  const mod = loadModule()

  assert.equal(mod.isSetupFailureFatal({ isProcess: true, isPythonProcess: true }), true)
  assert.equal(mod.isSetupFailureFatal({ isProcess: true, isPythonProcess: false }), false)
  assert.equal(mod.isSetupFailureFatal({ isProcess: false, isPythonProcess: false }), true)
})

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

test('extension updates reject model/process type changes that would leave stale registration', () => {
  const mod = loadModule()

  assert.doesNotThrow(() => mod.assertCompatibleExtensionUpdateType(
    { id: 'pixal3d' },
    { id: 'pixal3d', type: 'model' },
  ))
  assert.doesNotThrow(() => mod.assertCompatibleExtensionUpdateType(
    { id: 'mesh-tool', type: 'process' },
    { id: 'mesh-tool', type: 'process' },
  ))
  assert.throws(
    () => mod.assertCompatibleExtensionUpdateType(
      { id: 'pixal3d', type: 'model' },
      { id: 'pixal3d', type: 'process' },
    ),
    /Uninstall the existing extension first/,
  )
})

test('existing extension replacement fails closed on unreadable or invalid manifests', () => {
  const mod = loadModule()
  const nextManifest = {
    id: 'pixal3d',
    type: 'model',
    generator_class: 'Generator',
  }
  const files = {
    hasEntryFile: () => false,
    hasGeneratorFile: () => true,
  }

  assert.throws(
    () => mod.validateExistingExtensionReplacement(
      '{broken json',
      nextManifest,
      files,
      'existing extension folder',
    ),
    /manifest\.json is unreadable or invalid.*Uninstall it first/,
  )
  assert.throws(
    () => mod.validateExistingExtensionReplacement(
      JSON.stringify({ id: 'pixal3d', type: 'model' }),
      nextManifest,
      { ...files, hasGeneratorFile: () => false },
      'existing extension folder',
    ),
    /referenced runtime files are invalid.*Uninstall it first.*generator\.py missing/,
  )
  assert.throws(
    () => mod.validateExistingExtensionReplacement(
      JSON.stringify({
        id: 'another-extension',
        type: 'model',
        generator_class: 'Generator',
      }),
      nextManifest,
      files,
      'existing extension folder',
    ),
    /existing manifest identifies "another-extension".*Uninstall it first/,
  )
})

test('existing extension replacement accepts a validated type-compatible manifest', () => {
  const mod = loadModule()

  assert.deepEqual(
    mod.validateExistingExtensionReplacement(
      JSON.stringify({
        id: 'pixal3d',
        type: 'model',
        generator_class: 'OldGenerator',
      }),
      {
        id: 'pixal3d',
        type: 'model',
        generator_class: 'NewGenerator',
      },
      {
        hasEntryFile: () => false,
        hasGeneratorFile: () => true,
      },
      'existing extension folder',
    ),
    {
      id: 'pixal3d',
      isProcess: false,
      isPythonProcess: false,
      entryFile: 'processor.js',
      hasNodes: false,
    },
  )
})

test('interrupted list entries preserve safe manifest metadata while becoming corrupted', () => {
  const mod = loadModule()
  const extension = {
    type: 'process',
    id: 'mesh-tool',
    name: 'Mesh Tool',
    entry: 'processor.js',
    nodes: [{ id: 'simplify' }],
  }

  assert.deepEqual(
    mod.markExtensionInstallationInterrupted(extension, true),
    {
      ...extension,
      corrupted: true,
      manifestError: 'incomplete',
    },
  )
  assert.equal(mod.markExtensionInstallationInterrupted(extension, false), extension)
})

test('expectedModelIds derives composite IDs and preserves legacy flat IDs', () => {
  const mod = loadModule()

  assert.deepEqual(
    mod.expectedModelIds({
      id: 'pixal3d',
      type: 'model',
      nodes: [{ id: 'generate' }, { id: 'preview' }, { id: 'generate' }],
    }),
    ['pixal3d/generate', 'pixal3d/preview'],
  )
  assert.deepEqual(mod.expectedModelIds({ id: 'legacy-model' }), ['legacy-model'])
  assert.deepEqual(
    mod.expectedModelIds({ id: 'mesh-process', type: 'process', nodes: [{ id: 'run' }] }),
    [],
  )
})

test('validateExtensionReloadPayload accepts a complete compatible response', () => {
  const mod = loadModule()
  const payload = {
    reloaded: true,
    models: ['other/generate', 'pixal3d/generate'],
    errors: { 'other/broken': 'unrelated failure' },
  }

  assert.deepEqual(
    mod.validateExtensionReloadPayload(payload, 'pixal3d', ['pixal3d/generate']),
    payload,
  )
})

test('validateExtensionReloadPayload rejects missing expected model IDs', () => {
  const mod = loadModule()

  assert.throws(
    () => mod.validateExtensionReloadPayload(
      { reloaded: true, models: ['other/generate'], errors: {} },
      'pixal3d',
      ['pixal3d/generate'],
    ),
    /missing model ID pixal3d\/generate/,
  )
})

test('validateExtensionReloadPayload rejects extension and node errors', () => {
  const mod = loadModule()

  assert.throws(
    () => mod.validateExtensionReloadPayload(
      { reloaded: true, models: [], errors: { pixal3d: 'manifest invalid' } },
      'pixal3d',
      ['pixal3d/generate'],
    ),
    /pixal3d: manifest invalid/,
  )
  assert.throws(
    () => mod.validateExtensionReloadPayload(
      { reloaded: true, models: [], errors: { 'pixal3d/generate': 'venv not found' } },
      'pixal3d',
      ['pixal3d/generate'],
    ),
    /pixal3d\/generate: venv not found/,
  )
})

test('validateExtensionReloadPayload rejects malformed responses', () => {
  const mod = loadModule()
  const malformed = [
    null,
    {},
    { reloaded: false, models: [], errors: {} },
    { reloaded: true, models: 'pixal3d/generate', errors: {} },
    { reloaded: true, models: [], errors: [] },
    { reloaded: true, models: [], errors: { pixal3d: 123 } },
  ]

  for (const payload of malformed) {
    assert.throws(
      () => mod.validateExtensionReloadPayload(payload, 'pixal3d', ['pixal3d/generate']),
      /malformed response/,
    )
  }
})

test('validateExtensionQuarantinePayload requires target model IDs to be absent', () => {
  const mod = loadModule()
  const quarantined = {
    reloaded: true,
    models: ['other/generate'],
    errors: { 'pixal3d/generate': 'interrupted runtime registration' },
  }

  assert.deepEqual(
    mod.validateExtensionQuarantinePayload(
      quarantined,
      'pixal3d',
      ['pixal3d/generate'],
    ),
    quarantined,
  )
  assert.throws(
    () => mod.validateExtensionQuarantinePayload(
      {
        reloaded: true,
        models: ['pixal3d/generate'],
        errors: {},
      },
      'pixal3d',
      ['pixal3d/generate'],
    ),
    /Runtime quarantine failed.*pixal3d\/generate/,
  )
})

test('incompleteInstallRecoveryAction chooses restore, removal, or no-op', () => {
  const mod = loadModule()

  assert.equal(mod.incompleteInstallRecoveryAction({
    destinationExists: true,
    destinationIncomplete: true,
    backupExists: true,
  }), 'restore-backup')
  assert.equal(mod.incompleteInstallRecoveryAction({
    destinationExists: true,
    destinationIncomplete: true,
    backupExists: false,
  }), 'remove-incomplete')
  assert.equal(mod.incompleteInstallRecoveryAction({
    destinationExists: false,
    destinationIncomplete: false,
    backupExists: true,
  }), 'restore-backup')
  assert.equal(mod.incompleteInstallRecoveryAction({
    destinationExists: true,
    destinationIncomplete: false,
    backupExists: true,
  }), 'none')
})

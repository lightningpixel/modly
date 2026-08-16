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
  EXTENSION_REPOSITORY_REQUIREMENTS,
  extensionRemovalCopy,
  formatModelName,
  getLocalSourcePath,
  localExtensionSetupMessage,
  supportsExtensionRepair,
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

const baseExtension = {
  id: 'example',
  name: 'Example',
  trusted: false,
  builtin: false,
  nodes: [],
}

test('Repair policy accepts supported Python setup and rejects JS, built-in, and corrupted processes', () => {
  assert.equal(supportsExtensionRepair({ ...baseExtension, type: 'model' }), true)
  assert.equal(supportsExtensionRepair({ ...baseExtension, type: 'process', entry: 'processor.py', repairable: true }), true)
  assert.equal(supportsExtensionRepair({ ...baseExtension, type: 'process', entry: 'processor.py', repairable: false }), false)
  assert.equal(supportsExtensionRepair({ ...baseExtension, type: 'process', entry: 'processor.js', repairable: true }), false)
  assert.equal(supportsExtensionRepair({ ...baseExtension, type: 'process', entry: 'processor.py', repairable: true, builtin: true }), false)
  assert.equal(supportsExtensionRepair({ ...baseExtension, type: 'process', entry: 'processor.py', repairable: true, corrupted: true }), false)
})

test('local-link guidance directs supported Python processes to Repair without claiming setup ran', () => {
  const python = {
    ...baseExtension,
    type: 'process',
    entry: 'processor.py',
    repairable: true,
    source: 'local:///home/jane doe/process',
  }
  const js = {
    ...baseExtension,
    type: 'process',
    entry: 'processor.js',
    repairable: false,
    source: 'local://C:\\Users\\Jane Doe\\process',
  }

  assert.match(localExtensionSetupMessage(python), /linked.*without running setup/i)
  assert.match(localExtensionSetupMessage(python), /Repair/)
  assert.match(localExtensionSetupMessage(js), /dependencies and assets were not installed/i)
  assert.doesNotMatch(localExtensionSetupMessage(js), /Repair/)
  assert.equal(localExtensionSetupMessage({ ...python, source: 'https://github.com/example/process' }), null)
})

test('local paths and unlink confirmation remain truthful on Windows and Linux', () => {
  const windows = { ...baseExtension, type: 'process', entry: 'processor.py', source: 'local://C:\\Users\\Jane Doe\\process' }
  const linux = { ...baseExtension, type: 'process', entry: 'processor.py', source: 'local:///home/jane doe/process' }

  assert.equal(getLocalSourcePath(windows), 'C:\\Users\\Jane Doe\\process')
  assert.equal(getLocalSourcePath(linux), '/home/jane doe/process')
  assert.deepEqual(extensionRemovalCopy(windows), {
    title: 'Unlink “Example”?',
    body: 'Modly will remove its link. The source folder and files will remain on disk.',
    action: 'Unlink',
  })
  assert.deepEqual(extensionRemovalCopy({ ...linux, type: 'model' }, 2), {
    title: 'Unlink “Example”?',
    body: 'Modly will remove its link and 2 selected model weights. The source folder and files will remain on disk.',
    action: 'Unlink',
  })
  assert.deepEqual(extensionRemovalCopy({ ...baseExtension, type: 'model' }), {
    title: 'Uninstall “Example”?',
    body: 'The extension folder will be permanently deleted.',
    action: 'Uninstall',
  })
})

test('repository requirements describe both model and process extension roots', () => {
  assert.match(EXTENSION_REPOSITORY_REQUIREMENTS, /manifest\.json/)
  assert.match(EXTENSION_REPOSITORY_REQUIREMENTS, /generator\.py.*model/i)
  assert.match(EXTENSION_REPOSITORY_REQUIREMENTS, /declared entry.*process/i)
})

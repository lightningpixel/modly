import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// paramPicker.ts only type-imports from electron.d, so esbuild erases it.
function loadModule() {
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-parampicker-test-')), 'paramPicker.cjs')
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve('src/shared/utils/paramPicker.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return require(outfile)
}

const { resolvePickerIntent, openParamPicker, PICKER_LABELS } = loadModule()

/** Records which dialog was opened; each returns a path unique to that dialog. */
function fakeFs() {
  const calls = []
  return {
    calls,
    selectDirectory: () => { calls.push('selectDirectory'); return Promise.resolve('C:\\picked\\folder') },
    selectImage:     () => { calls.push('selectImage');     return Promise.resolve('C:\\picked\\front.png') },
    selectMeshFile:  () => { calls.push('selectMeshFile');  return Promise.resolve('C:\\picked\\model.glb') },
    selectTextFile:  () => { calls.push('selectTextFile');  return Promise.resolve('C:\\picked\\notes.txt') },
  }
}

const stringParam = (extra) => ({ id: 'front_image_path', label: 'Front image', type: 'string', default: '', ...extra })

// ─── resolvePickerIntent ───────────────────────────────────────────────────────

test('resolvePickerIntent honors pickerIntent and its snake_case alias', () => {
  assert.equal(resolvePickerIntent(stringParam({ pickerIntent: 'image' })), 'image')
  assert.equal(resolvePickerIntent(stringParam({ pickerIntent: 'mesh' })), 'mesh')
  assert.equal(resolvePickerIntent(stringParam({ pickerIntent: 'text' })), 'text')
  assert.equal(resolvePickerIntent(stringParam({ picker_intent: 'image' })), 'image')
})

test('resolvePickerIntent falls back to the folder picker when unset or unknown', () => {
  assert.equal(resolvePickerIntent(stringParam()), 'folder')                          // pre-existing manifests
  assert.equal(resolvePickerIntent(stringParam({ pickerIntent: 'folder' })), 'folder')
  assert.equal(resolvePickerIntent(stringParam({ pickerIntent: 'hologram' })), 'folder') // newer manifest, older app
  assert.equal(resolvePickerIntent(undefined), 'folder')
})

// ─── openParamPicker ───────────────────────────────────────────────────────────

test('openParamPicker opens the image dialog for pickerIntent: image — issue #155', async () => {
  const fs = fakeFs()
  const picked = await openParamPicker(stringParam({ pickerIntent: 'image' }), fs)

  assert.deepEqual(fs.calls, ['selectImage'])          // and *not* selectDirectory
  assert.equal(picked, 'C:\\picked\\front.png')
})

test('openParamPicker routes mesh/text intents to their existing dialogs', async () => {
  const mesh = fakeFs()
  assert.equal(await openParamPicker(stringParam({ pickerIntent: 'mesh' }), mesh), 'C:\\picked\\model.glb')
  assert.deepEqual(mesh.calls, ['selectMeshFile'])

  const text = fakeFs()
  assert.equal(await openParamPicker(stringParam({ picker_intent: 'text' }), text), 'C:\\picked\\notes.txt')
  assert.deepEqual(text.calls, ['selectTextFile'])
})

test('openParamPicker keeps the folder dialog when no intent is declared', async () => {
  const fs = fakeFs()
  assert.equal(await openParamPicker(stringParam(), fs), 'C:\\picked\\folder')
  assert.deepEqual(fs.calls, ['selectDirectory'])
})

test('PICKER_LABELS names every intent, so the browse button always has an accessible name', () => {
  for (const intent of ['folder', 'image', 'mesh', 'text']) {
    assert.equal(typeof PICKER_LABELS[intent], 'string')
    assert.ok(PICKER_LABELS[intent].length > 0)
  }
})

// ─── Call sites ────────────────────────────────────────────────────────────────
// The bug in #155 was not in a resolver (there wasn't one) — it was the string
// param's browse button calling selectDirectory() unconditionally. There is no
// DOM harness in this repo, so guard the wiring at the source level instead.

for (const file of [
  'src/areas/workflows/nodes/ExtensionNode.tsx',
  'src/areas/generate/components/WorkflowPanel.tsx',
]) {
  test(`${file} routes its string param browse button through openParamPicker`, () => {
    const src = readFileSync(resolve(file), 'utf8')
    assert.match(src, /openParamPicker\(param, window\.electron\.fs\)/)
    assert.doesNotMatch(src, /const p = await window\.electron\.fs\.selectDirectory\(\)/)
  })
}

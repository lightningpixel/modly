import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// slotInputs.ts has no runtime imports, so esbuild bundles it standalone.
function loadModule() {
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-slotinputs-test-')), 'slotInputs.cjs')
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve('src/areas/workflows/slotInputs.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return require(outfile)
}

const { assignSlotFilePaths } = loadModule()

test('a mesh slot becomes the mesh path', () => {
  const r = assignSlotFilePaths(['mesh', 'image'], ['a.glb', 'b.png'])
  assert.equal(r.nodeInputMeshPath, 'a.glb')
  assert.equal(r.nodeInputPath, 'b.png')
  assert.deepEqual(r.extraImagePaths, [])
})

test('the first image slot is the primary path and later images are extras', () => {
  const r = assignSlotFilePaths(['image', 'image', 'image'], ['1.png', '2.png', '3.png'])
  assert.equal(r.nodeInputPath, '1.png')
  assert.deepEqual(r.extraImagePaths, ['2.png', '3.png'])
  assert.equal(r.nodeInputMeshPath, undefined)
})

test('an audio slot becomes the primary path', () => {
  // Regression: audio slots were resolved and then dropped, so a multi-input
  // node such as [audio, text] failed with "needs an incoming audio connection".
  const r = assignSlotFilePaths(['audio', 'text'], ['song.wav', undefined])
  assert.equal(r.nodeInputPath, 'song.wav')
  assert.equal(r.nodeInputMeshPath, undefined)
  assert.deepEqual(r.extraImagePaths, [])
})

test('a video slot in an inputs array becomes the primary path', () => {
  const r = assignSlotFilePaths(['video', 'text'], ['clip.mp4', undefined])
  assert.equal(r.nodeInputPath, 'clip.mp4')
  assert.equal(r.nodeInputMeshPath, undefined)
  assert.deepEqual(r.extraImagePaths, [])
})

test('text slots never claim a file path, and empty slots are skipped', () => {
  const r = assignSlotFilePaths(['text', 'image'], ['leaked.png', undefined])
  assert.equal(r.nodeInputPath, undefined)
  assert.equal(r.nodeInputMeshPath, undefined)
  assert.deepEqual(r.extraImagePaths, [])
})

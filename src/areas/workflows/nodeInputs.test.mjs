import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// nodeInputs.ts pulls in nodeBehaviors.ts, which only type-imports from
// electron.d — esbuild erases those, so the bundle is dependency-free.
function loadModule() {
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-nodeinputs-test-')), 'nodeInputs.cjs')
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve('src/areas/workflows/nodeInputs.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return require(outfile)
}

const { resolveNodeInputs, extraImageParams, mainText, missingInput, slotInputType } = loadModule()

// ─── Fixtures ────────────────────────────────────────────────────────────────

const edge = (source, targetHandle) => ({ source, targetHandle })

/** Every source id maps to the output declared here; anything else is undefined. */
const sources = (map) => (id) => map[id]

// ─── Single-input nodes ──────────────────────────────────────────────────────

test('a single-input node takes the last file edge, ignoring handles', () => {
  const inputs = resolveNodeInputs(['image'], [edge('a'), edge('b')], sources({
    a: { filePath: '/first.png' },
    b: { filePath: '/second.png' },
  }))
  assert.equal(inputs.filePath, '/second.png')
  assert.deepEqual(inputs.texts, [])
  assert.deepEqual(inputs.extraImages, [])
  assert.equal(inputs.meshPath, undefined)
})

test('an extension declaring no inputs at all still resolves its edge', () => {
  const inputs = resolveNodeInputs(undefined, [edge('a')], sources({ a: { filePath: '/mesh.glb' } }))
  assert.equal(inputs.filePath, '/mesh.glb')
})

test('a blank text does not count as an incoming text', () => {
  const inputs = resolveNodeInputs(['text'], [edge('a')], sources({ a: { text: '   ' } }))
  assert.equal(inputs.text, undefined)
})

// ─── Slot resolution on multi-input nodes ────────────────────────────────────

test('slots are read from the target handle, not from edge order', () => {
  // Edges arrive input-1 first: typing them by arrival put the negative prompt
  // in texts[0].
  const inputs = resolveNodeInputs(['text', 'text'], [edge('neg', 'input-1'), edge('pos', 'input-0')], sources({
    pos: { text: 'a red car' },
    neg: { text: 'blurry' },
  }))
  assert.deepEqual(inputs.texts, ['a red car', 'blurry'])
  assert.equal(mainText(inputs), 'a red car')
})

test('an untagged edge addresses slot 0 — the agent builder wires its chain that way', () => {
  const inputs = resolveNodeInputs(['text', 'text'], [edge('pos')], sources({ pos: { text: 'a red car' } }))
  assert.deepEqual(inputs.texts, ['a red car'])
  assert.equal(mainText(inputs), 'a red car')
})

test('an untagged positive prompt still wins over a negative one on input-1', () => {
  // The bug the whole rule exists for: mainText fell through to `text`, which is
  // whichever text edge came last, so the negative prompt drove the generator.
  const inputs = resolveNodeInputs(['text', 'text'], [edge('pos'), edge('neg', 'input-1')], sources({
    pos: { text: 'a red car' },
    neg: { text: 'blurry' },
  }))
  assert.equal(inputs.text, 'blurry')          // last edge wins, as before
  assert.equal(mainText(inputs), 'a red car')  // but the slot decides
})

test('a handle naming no numeric slot is dropped rather than landing on slot 0', () => {
  const inputs = resolveNodeInputs(['text', 'text'], [edge('junk', 'input-abc')], sources({
    junk: { text: 'nowhere' },
  }))
  assert.deepEqual(inputs.texts, [])
  assert.equal(mainText(inputs), undefined)
})

test('a slot past the declared inputs does not write a path', () => {
  const inputs = resolveNodeInputs(['image', 'image'], [edge('far', 'input-7')], sources({
    far: { filePath: '/far.png' },
  }))
  assert.equal(inputs.filePath, undefined)
  assert.deepEqual(inputs.extraImages, [])
})

test('an edge whose source produced nothing is skipped', () => {
  const inputs = resolveNodeInputs(['image', 'image'], [edge('missing', 'input-0'), edge('b', 'input-1')], sources({
    b: { filePath: '/b.png' },
  }))
  assert.equal(inputs.filePath, '/b.png')
})

// ─── Typing slots by their declared input ────────────────────────────────────

test('two mesh slots both survive, lowest one as the primary', () => {
  // Only the last mesh slot used to survive: meshPath was overwritten at every
  // mesh slot, so wiring a second mesh node reached the extension as nothing.
  // modly-combine 1.1.0 errors with "No secondary meshes provided" on this.
  const inputs = resolveNodeInputs(['mesh', 'mesh'], [edge('b', 'input-1'), edge('a', 'input-0')], sources({
    a: { filePath: '/a.glb' },
    b: { filePath: '/b.glb' },
  }))
  assert.equal(inputs.meshPath, '/a.glb')
  assert.deepEqual(inputs.meshFiles, ['/a.glb', '/b.glb'])
})

test('the same mesh wired into two slots is kept twice, on purpose', () => {
  // Duplicate-and-translate: the extension removes one occurrence as primary.
  const inputs = resolveNodeInputs(['mesh', 'mesh'], [edge('a', 'input-0'), edge('a2', 'input-1')], sources({
    a:  { filePath: '/a.glb' },
    a2: { filePath: '/a.glb' },
  }))
  assert.deepEqual(inputs.meshFiles, ['/a.glb', '/a.glb'])
})

test('a gap in the mesh slots does not shift the primary', () => {
  const inputs = resolveNodeInputs(['mesh', 'mesh', 'mesh'], [edge('c', 'input-2')], sources({
    c: { filePath: '/c.glb' },
  }))
  assert.equal(inputs.meshPath, '/c.glb')
  assert.deepEqual(inputs.meshFiles, ['/c.glb'])
})

test('a single-input node reports no mesh files', () => {
  const inputs = resolveNodeInputs(['mesh'], [edge('a')], sources({ a: { filePath: '/a.glb' } }))
  assert.deepEqual(inputs.meshFiles, [])
  assert.equal(inputs.filePath, '/a.glb')
})

test('a mesh slot resolves into meshPath, leaving filePath to the image', () => {
  const inputs = resolveNodeInputs(['mesh', 'image'], [edge('m', 'input-0'), edge('i', 'input-1')], sources({
    m: { filePath: '/model.glb' },
    i: { filePath: '/ref.png' },
  }))
  assert.equal(inputs.meshPath, '/model.glb')
  assert.equal(inputs.filePath, '/ref.png')
  assert.deepEqual(inputs.extraImages, [])
})

test('images past the first ride along in extraImages, in slot order', () => {
  const inputs = resolveNodeInputs(
    ['image', 'image', 'image'],
    [edge('c', 'input-2'), edge('a', 'input-0'), edge('b', 'input-1')],
    sources({ a: { filePath: '/a.png' }, b: { filePath: '/b.png' }, c: { filePath: '/c.png' } }),
  )
  assert.equal(inputs.filePath, '/a.png')
  assert.deepEqual(inputs.extraImages, ['/b.png', '/c.png'])
})

test('a declared slot that is neither mesh nor image contributes no path', () => {
  const inputs = resolveNodeInputs(['audio', 'image'], [edge('s', 'input-0'), edge('i', 'input-1')], sources({
    s: { filePath: '/sound.wav' },
    i: { filePath: '/ref.png' },
  }))
  assert.equal(inputs.filePath, '/ref.png')
  assert.deepEqual(inputs.extraImages, [])
})

// ─── extra_image_paths overlay ───────────────────────────────────────────────

test('a mesh plus images sends every image in the overlay, the first included', () => {
  // The mesh takes the filePath slot in the call, so an image left there would
  // never reach the extension.
  const inputs = resolveNodeInputs(
    ['mesh', 'image', 'image'],
    [edge('m', 'input-0'), edge('a', 'input-1'), edge('b', 'input-2')],
    sources({ m: { filePath: '/model.glb' }, a: { filePath: '/a.png' }, b: { filePath: '/b.png' } }),
  )
  assert.deepEqual(extraImageParams(inputs), { extra_image_paths: ['/a.png', '/b.png'] })
})

test('images without a mesh send only the surplus ones', () => {
  const inputs = resolveNodeInputs(['image', 'image'], [edge('a', 'input-0'), edge('b', 'input-1')], sources({
    a: { filePath: '/a.png' },
    b: { filePath: '/b.png' },
  }))
  assert.deepEqual(extraImageParams(inputs), { extra_image_paths: ['/b.png'] })
})

test('a plain node adds no overlay at all, so declared params stay untouched', () => {
  const inputs = resolveNodeInputs(['image'], [edge('a')], sources({ a: { filePath: '/a.png' } }))
  assert.deepEqual(extraImageParams(inputs), {})
})

test('a mesh alone adds no overlay — there is no image to route', () => {
  const inputs = resolveNodeInputs(['mesh', 'image'], [edge('m', 'input-0')], sources({
    m: { filePath: '/model.glb' },
  }))
  assert.equal(inputs.meshPath, '/model.glb')
  assert.deepEqual(extraImageParams(inputs), {})
})

// ─── mainText ────────────────────────────────────────────────────────────────

test('mainText falls back to the last text edge on a single-input node', () => {
  const inputs = resolveNodeInputs(['text'], [edge('a')], sources({ a: { text: 'hello' } }))
  assert.equal(mainText(inputs), 'hello')
})

test('mainText is undefined when nothing text-like came in', () => {
  const inputs = resolveNodeInputs(['image'], [edge('a')], sources({ a: { filePath: '/a.png' } }))
  assert.equal(mainText(inputs), undefined)
})

// ─── Missing-connection guard ────────────────────────────────────────────────

test('a multi-input node wired with only its mesh is accepted', () => {
  // It used to be refused for want of the very connection it had: the mesh had
  // resolved into meshPath, and the guard only ever looked at filePath.
  const inputs = resolveNodeInputs(['mesh', 'image'], [edge('m', 'input-0')], sources({
    m: { filePath: '/model.glb' },
  }))
  assert.equal(missingInput('mesh', inputs), undefined)
})

test('a mesh node with nothing wired is refused', () => {
  const inputs = resolveNodeInputs(['mesh'], [], sources({}))
  assert.equal(missingInput('mesh', inputs), 'mesh')
})

test('a single-input mesh node still passes on filePath alone', () => {
  const inputs = resolveNodeInputs(['mesh'], [edge('m')], sources({ m: { filePath: '/model.glb' } }))
  assert.equal(missingInput('mesh', inputs), undefined)
})

test('an image node is not satisfied by a mesh sitting in meshPath', () => {
  const inputs = resolveNodeInputs(['mesh', 'image'], [edge('m', 'input-0')], sources({
    m: { filePath: '/model.glb' },
  }))
  assert.equal(missingInput('image', inputs), 'image')
})

test('audio and text report their own missing connection', () => {
  const empty = resolveNodeInputs(['audio'], [], sources({}))
  assert.equal(missingInput('audio', empty), 'audio')
  assert.equal(missingInput('text', empty), 'text')

  const withText = resolveNodeInputs(['text'], [edge('t')], sources({ t: { text: 'hi' } }))
  assert.equal(missingInput('text', withText), undefined)
})

test('an extension declaring no input type is never refused', () => {
  const inputs = resolveNodeInputs(undefined, [], sources({}))
  assert.equal(missingInput(undefined, inputs), undefined)
})

// ─── The type a given handle is checked against ──────────────────────────────

test('a single-input extension answers with its declared input, handle or not', () => {
  const ext = { input: 'mesh' }
  assert.equal(slotInputType(ext, 'input-0'), 'mesh')
  assert.equal(slotInputType(ext, undefined), 'mesh')
  assert.equal(slotInputType(ext, 'anything'), 'mesh')
})

test('a multi-input extension answers with the slot the handle names', () => {
  const ext = { input: 'mesh', inputs: ['mesh', 'image'] }
  assert.equal(slotInputType(ext, 'input-0'), 'mesh')
  assert.equal(slotInputType(ext, 'input-1'), 'image')
})

test('an untagged handle reads as slot 0, the way the runner places it', () => {
  // It used to fall back to the legacy `input`, which can disagree with inputs[0].
  const ext = { input: 'mesh', inputs: ['image', 'mesh'] }
  assert.equal(slotInputType(ext, undefined), 'image')
  assert.equal(slotInputType(ext, null), 'image')
})

test('a handle naming no numeric slot falls back instead of being parsed loosely', () => {
  // parseInt('1x') is 1; edgeSlot refuses it, so the editor and the runner agree.
  const ext = { input: 'mesh', inputs: ['image', 'mesh'] }
  assert.equal(slotInputType(ext, 'input-1x'), 'mesh')
  assert.equal(slotInputType(ext, 'input-abc'), 'mesh')
})

test('a slot past the declared inputs falls back to the legacy input', () => {
  const ext = { input: 'mesh', inputs: ['image', 'mesh'] }
  assert.equal(slotInputType(ext, 'input-9'), 'mesh')
})

test('no extension at all yields no type', () => {
  assert.equal(slotInputType(undefined, 'input-0'), undefined)
})

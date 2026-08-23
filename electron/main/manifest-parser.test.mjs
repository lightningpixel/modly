import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

function loadModule() {
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-manifest-test-')), 'manifest-parser.cjs')
  const result = buildSync({
    entryPoints: [resolve('electron/main/manifest-parser.ts')],
    bundle: true, platform: 'node', format: 'cjs', write: false,
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return createRequire(import.meta.url)(outfile)
}

const { parseExtensionManifest, isTrustedSource } = loadModule()

const parse = (manifest, warn = () => {}) =>
  parseExtensionManifest(manifest, 'fallback-id', new Set(), false, warn)

const oneNode = (node = {}, top = {}) => parse({
  id: 'pack', name: 'Pack', type: 'process', entry: 'processor.js',
  nodes: [{ id: 'gen', name: 'Gen', ...node }],
  ...top,
}).nodes[0]

// ─── Declared VRAM ───────────────────────────────────────────────────────────

test('a declared VRAM cost reaches the app', () => {
  assert.equal(oneNode({ vram_gb: 12 }).vramGb, 12)
})

test('a manifest declaring none is unchanged', () => {
  const node = oneNode({ description: 'Reduces the triangle count.' })

  assert.equal(node.description, 'Reduces the triangle count.')
  assert.equal(node.vramGb, undefined)
})

test('a VRAM cost of the wrong type is dropped without taking its neighbours down', () => {
  // Third-party JSON: strings where numbers belong, nulls, objects.
  const node = oneNode({ vram_gb: '12', description: 'Still here.' })

  assert.equal(node.vramGb, undefined)
  assert.equal(node.description, 'Still here.')
  assert.equal(node.name, 'Gen', 'the rest of the node still parsed')
})

test('a VRAM cost of zero or below is treated as undeclared', () => {
  assert.equal(oneNode({ vram_gb: 0 }).vramGb, undefined)
  assert.equal(oneNode({ vram_gb: -3 }).vramGb, undefined)
})

// ─── Inheritance ─────────────────────────────────────────────────────────────

test('vram_gb declared once at the top level covers every node', () => {
  // The shape the Python side already reads (extension_process.py): a
  // single-node extension states its cost once.
  const ext = parse({
    id: 'pack', type: 'model', vram_gb: 24,
    nodes: [{ id: 'a' }, { id: 'b', vram_gb: 8 }],
  })

  assert.equal(ext.nodes[0].vramGb, 24, 'inherited')
  assert.equal(ext.nodes[1].vramGb, 8, 'the node’s own wins')
})

test('a node keeps its own description, else the extension one', () => {
  assert.equal(oneNode({ description: 'Node line.' }, { description: 'Extension line.' }).description, 'Node line.')
  assert.equal(oneNode({}, { description: 'Extension line.' }).description, 'Extension line.')
})

// ─── Port types ──────────────────────────────────────────────────────────────

test('an unknown port type falls back to a safe one and is reported', () => {
  // Left alone it lands as undefined downstream, which preflight reads as a
  // wildcard — one typo would disable every type check on that node.
  const warnings = []
  const node = parseExtensionManifest(
    { id: 'pack', type: 'model', nodes: [{ id: 'gen', input: 'imag', output: 'msh' }] },
    'fallback-id', new Set(), false, (m) => warnings.push(m),
  ).nodes[0]

  assert.equal(node.input, 'image')
  assert.equal(node.output, 'mesh')
  assert.equal(warnings.length, 2)
  assert.match(warnings[0], /pack\/gen input: unknown port type "imag"/)
})

test('the port defaults are image in, mesh out', () => {
  const node = oneNode({})
  assert.equal(node.input, 'image')
  assert.equal(node.output, 'mesh')
})

// ─── Extension shape ─────────────────────────────────────────────────────────

test('a process manifest keeps its entry, a model manifest has none', () => {
  const process = parse({ id: 'p', type: 'process', entry: 'run.js', nodes: [] })
  assert.equal(process.type, 'process')
  assert.equal(process.entry, 'run.js')

  const model = parse({ id: 'm', type: 'model', nodes: [] })
  assert.equal(model.type, 'model')
  assert.equal(model.entry, undefined)
})

test('an author given as an object is read from its name', () => {
  assert.equal(parse({ id: 'p', type: 'model', author: { name: 'Ada' }, nodes: [] }).author, 'Ada')
  assert.equal(parse({ id: 'p', type: 'model', author: 'Ada', nodes: [] }).author, 'Ada')
})

test('only a repo on the trusted list is trusted', () => {
  assert.equal(isTrustedSource(undefined, new Set(['https://github.com/x/y'])), false)
  assert.equal(isTrustedSource('https://github.com/X/Y/', new Set(['https://github.com/x/y'])), true)
  assert.equal(isTrustedSource('https://github.com/other/repo', new Set(['https://github.com/x/y'])), false)
})

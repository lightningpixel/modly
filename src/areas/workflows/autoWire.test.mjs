import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Bundle autoWire.ts (and its real dependencies) into CJS — same approach as
// preflight.test.mjs: @shared/* imports are type-only and erased by esbuild.
function loadModule() {
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-autowire-test-')), 'autoWire.cjs')
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve('src/areas/workflows/autoWire.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return require(outfile)
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

function ext(overrides = {}) {
  return {
    id: 'pack/process-node',
    extensionId: 'pack',
    extensionName: 'Pack',
    extensionAuthor: 'tester',
    nodeId: 'process-node',
    name: 'Process Node',
    description: '',
    input: 'image',
    output: 'mesh',
    params: [],
    builtin: false,
    type: 'process',
    ...overrides,
  }
}

function wf(nodes, edges = []) {
  return { id: 'wf', name: 'wf', description: '', nodes, edges, createdAt: '', updatedAt: '' }
}

const imageNode = (id = 'img') => ({ id, type: 'imageNode', position: { x: 0, y: 0 }, data: {} })
const meshNode = (id = 'mesh') => ({ id, type: 'meshNode', position: { x: 0, y: 0 }, data: { params: {} } })
const textNode = (id = 'txt') => ({ id, type: 'textNode', position: { x: 0, y: 0 }, data: { params: {} } })
const waitNode = (id = 'wait') => ({ id, type: 'waitNode', position: { x: 200, y: 0 }, data: {} })
const extNode = (id, extensionId) => ({ id, type: 'extensionNode', position: { x: 400, y: 0 }, data: { extensionId } })

// ─── Tests ───────────────────────────────────────────────────────────────────

test('fully wired workflow is returned unchanged', () => {
  const { autoWireWorkflow } = loadModule()
  const workflow = wf(
    [imageNode('img'), extNode('proc', 'pack/process-node')],
    [{ id: 'e1', source: 'img', target: 'proc' }],
  )

  const { workflow: out, added } = autoWireWorkflow(workflow, [ext()])
  assert.deepEqual(added, [])
  assert.equal(out.edges.length, 1)
  assert.equal(out.nodes.length, 2)
})

test('missing image input of a mesh+image texture node is wired from the existing Image node', () => {
  const { autoWireWorkflow } = loadModule()
  const texture = ext({ id: 'pack/texture', nodeId: 'texture', name: 'Texture Mesh', input: 'mesh', inputs: ['mesh', 'image'], output: 'mesh' })
  const workflow = wf(
    [imageNode('img'), meshNode('mesh'), extNode('tex', 'pack/texture')],
    [{ id: 'e1', source: 'mesh', target: 'tex' }],
  )

  const { workflow: out, added } = autoWireWorkflow(workflow, [texture])
  assert.equal(added.length, 1)
  assert.match(added[0], /Image → Texture Mesh \(image\)/)
  const newEdge = out.edges.find((e) => e.source === 'img' && e.target === 'tex')
  assert.ok(newEdge, 'expected an img → tex edge')
  assert.equal(newEdge.targetHandle, 'input-1')
  // Without the editor's edge type the repaired connection renders as a plain
  // React Flow edge, unlike every other one in the graph.
  assert.equal(newEdge.type, 'workflowEdge')
})

test('creates a source node when no producer of the missing type exists', () => {
  const { autoWireWorkflow } = loadModule()
  const texture = ext({ id: 'pack/texture', nodeId: 'texture', name: 'Texture Mesh', input: 'mesh', inputs: ['mesh', 'image'], output: 'mesh' })
  const workflow = wf(
    [meshNode('mesh'), extNode('tex', 'pack/texture')],
    [{ id: 'e1', source: 'mesh', target: 'tex' }],
  )

  const { workflow: out, added } = autoWireWorkflow(workflow, [texture])
  assert.equal(added.length, 1)
  const created = out.nodes.find((n) => n.type === 'imageNode')
  assert.ok(created, 'expected a new Image node')
  assert.ok(out.edges.some((e) => e.source === created.id && e.target === 'tex'))
})

test('never wires from a downstream node (no cycles)', () => {
  const { autoWireWorkflow } = loadModule()
  // proc outputs image, but it is downstream of tex — a fresh Image node must be created instead
  const texture = ext({ id: 'pack/texture', nodeId: 'texture', name: 'Texture Mesh', input: 'mesh', inputs: ['mesh', 'image'], output: 'mesh' })
  const imgProducer = ext({ id: 'pack/render', nodeId: 'render', name: 'Render', input: 'mesh', output: 'image' })
  const workflow = wf(
    [meshNode('mesh'), extNode('tex', 'pack/texture'), { ...extNode('render', 'pack/render'), position: { x: 800, y: 0 } }],
    [
      { id: 'e1', source: 'mesh', target: 'tex' },
      { id: 'e2', source: 'tex', target: 'render' },
    ],
  )

  const { workflow: out } = autoWireWorkflow(workflow, [texture, imgProducer])
  assert.ok(!out.edges.some((e) => e.source === 'render' && e.target === 'tex'), 'must not create a cycle')
  assert.ok(out.nodes.some((n) => n.type === 'imageNode'), 'expected a new Image node instead')
})

test('a node missing two input types at once gets both wired to distinct handles, and the created nodes do not overlap', () => {
  const { autoWireWorkflow } = loadModule()
  const texture = ext({ id: 'pack/texture', nodeId: 'texture', name: 'Texture Mesh', input: 'mesh', inputs: ['mesh', 'image'], output: 'mesh' })
  const workflow = wf([extNode('tex', 'pack/texture')], [])

  const { workflow: out, added } = autoWireWorkflow(workflow, [texture])
  assert.equal(added.length, 2)

  const meshEdge  = out.edges.find((e) => e.target === 'tex' && e.targetHandle === 'input-0')
  const imageEdge = out.edges.find((e) => e.target === 'tex' && e.targetHandle === 'input-1')
  assert.ok(meshEdge, 'expected a mesh source wired to input-0')
  assert.ok(imageEdge, 'expected an image source wired to input-1')

  const meshSrc  = out.nodes.find((n) => n.id === meshEdge.source)
  const imageSrc = out.nodes.find((n) => n.id === imageEdge.source)
  assert.equal(meshSrc.type, 'meshNode')
  assert.equal(imageSrc.type, 'imageNode')
  assert.notEqual(meshSrc.position.y, imageSrc.position.y, 'created nodes must not stack on top of each other')
})

test('creates and wires a Text node when a text input is missing', () => {
  const { autoWireWorkflow } = loadModule()
  const summarize = ext({ id: 'pack/summarize', nodeId: 'summarize', name: 'Summarize', input: 'text', output: 'text' })
  const workflow = wf([extNode('sum', 'pack/summarize')], [])

  const { workflow: out, added } = autoWireWorkflow(workflow, [summarize])
  assert.equal(added.length, 1)
  const created = out.nodes.find((n) => n.type === 'textNode')
  assert.ok(created, 'expected a new Text node')
  assert.ok(out.edges.some((e) => e.source === created.id && e.target === 'sum'))
})

test('resolves a required type through a passthrough (Wait) node instead of only direct producers', () => {
  const { autoWireWorkflow } = loadModule()
  const producer = ext({ id: 'pack/gen', nodeId: 'gen', name: 'Generate Text', input: 'image', output: 'text' })
  const consumer = ext({ id: 'pack/proc', nodeId: 'proc', name: 'Process Text', input: 'text', output: 'text' })
  const workflow = wf(
    [imageNode('img'), extNode('gen', 'pack/gen'), waitNode('wait'), { ...extNode('proc', 'pack/proc'), position: { x: 800, y: 0 } }],
    [
      { id: 'e1', source: 'img', target: 'gen' },
      { id: 'e2', source: 'gen', target: 'wait' },
    ],
  )

  const { workflow: out, added } = autoWireWorkflow(workflow, [producer, consumer])
  assert.equal(added.length, 1, 'proc should be wired without creating a redundant Text node')
  assert.equal(out.nodes.length, workflow.nodes.length, 'no new node should have been created')
  const newEdge = out.edges.find((e) => e.target === 'proc')
  assert.ok(['gen', 'wait'].includes(newEdge.source), 'expected proc to be wired from the resolved text producer')
})

test('prefers the dedicated input node over another producer of the same type', () => {
  const { autoWireWorkflow } = loadModule()
  const otherGen = ext({ id: 'pack/other-gen', nodeId: 'other-gen', name: 'Other Text Gen', input: 'image', output: 'text' })
  const consumer = ext({ id: 'pack/proc', nodeId: 'proc', name: 'Process Text', input: 'text', output: 'text' })
  const workflow = wf(
    [imageNode('img'), extNode('other', 'pack/other-gen'), textNode('txt'), extNode('proc', 'pack/proc')],
    [{ id: 'e1', source: 'img', target: 'other' }],
  )

  const { workflow: out, added } = autoWireWorkflow(workflow, [otherGen, consumer])
  assert.equal(added.length, 1)
  const newEdge = out.edges.find((e) => e.target === 'proc')
  assert.equal(newEdge.source, 'txt', 'the dedicated Text node should win over another text producer')
  assert.equal(out.nodes.length, workflow.nodes.length, 'no new node should have been created')
})

test('a required type with no known source node spec (e.g. audio) is skipped without throwing', () => {
  const { autoWireWorkflow } = loadModule()
  const listener = ext({ id: 'pack/listen', nodeId: 'listen', name: 'Listen', input: 'audio', output: 'text' })
  const workflow = wf([extNode('lis', 'pack/listen')], [])

  const { workflow: out, added } = autoWireWorkflow(workflow, [listener])
  assert.deepEqual(added, [])
  assert.equal(out.nodes.length, 1)
  assert.equal(out.edges.length, 0)
})

test('a node requiring the same type twice gets both slots wired', () => {
  const { autoWireWorkflow } = loadModule()
  // `inputs: ['image', 'image']` — wiring used to dedupe required TYPES, so only
  // input-0 was connected while preflight (which checks per SLOT) kept reporting
  // input-1 missing: an agent-driven run stayed blocked with nothing left to fix.
  const compare = ext({ id: 'pack/compare', nodeId: 'compare', name: 'Compare Images', input: 'image', inputs: ['image', 'image'], output: 'text' })
  const workflow = wf([imageNode('img'), extNode('cmp', 'pack/compare')], [])

  const { workflow: out, added } = autoWireWorkflow(workflow, [compare])
  assert.equal(added.length, 2)
  assert.ok(out.edges.some((e) => e.target === 'cmp' && e.targetHandle === 'input-0'))
  assert.ok(out.edges.some((e) => e.target === 'cmp' && e.targetHandle === 'input-1'))
  // Two slots want two pictures: the existing Image node takes one and a second
  // is created, rather than feeding the same image to both.
  assert.equal(out.nodes.filter((n) => n.type === 'imageNode').length, 2)
  const sources = out.edges.filter((e) => e.target === 'cmp').map((e) => e.source)
  assert.equal(new Set(sources).size, 2)
})

test('a model-provider edge does not count as a satisfied data input', () => {
  const { autoWireWorkflow } = loadModule()
  // An LLM node wired to an `llm-model` param outputs 'text', so before the
  // isLlmPortHandle filter autowire considered the text input satisfied and
  // skipped it — while preflight kept reporting it missing.
  const cad = ext({ id: 'pack/cad', nodeId: 'cad', name: 'Text to CAD', input: 'text', output: 'mesh' })
  const llm = { id: 'llm', type: 'llmNode', position: { x: 200, y: 200 }, data: { params: { model: 'ready-7b' } } }
  const workflow = wf(
    [llm, extNode('cad', 'pack/cad')],
    [{ id: 'e1', source: 'llm', target: 'cad', sourceHandle: 'llm', targetHandle: 'llm-model_variant' }],
  )

  const { workflow: out, added } = autoWireWorkflow(workflow, [cad])
  assert.equal(added.length, 1, 'the text input must still be wired')
  assert.ok(out.edges.some((e) => e.target === 'cad' && e.targetHandle === 'input-0'))
  // The provider edge is untouched.
  assert.ok(out.edges.some((e) => e.id === 'e1' && e.targetHandle === 'llm-model_variant'))
})

test('a slot fed by the wrong type with no correct producer is left alone (no invented input node)', () => {
  const { autoWireWorkflow } = loadModule()
  // The real regression: Image wired straight into a mesh step. Creating a
  // "Load 3D Mesh (current)" here added a second, worse error and the run could
  // never start — the pipeline is missing a generator, not a connection.
  const optimize = ext({ id: 'pack/optimize', nodeId: 'optimize', name: 'Optimize Mesh', input: 'mesh', output: 'mesh' })
  const workflow = wf(
    [imageNode('img'), extNode('opt', 'pack/optimize')],
    [{ id: 'e1', source: 'img', target: 'opt' }],
  )

  const { workflow: out, added } = autoWireWorkflow(workflow, [optimize])
  assert.deepEqual(added, [])
  assert.equal(out.nodes.length, 2, 'no node may be created')
  assert.deepEqual(out.edges.map((e) => e.id), ['e1'], 'the existing edge stays for preflight to report')
})

test('a slot fed by the wrong type is rewired when a correct producer already exists', () => {
  const { autoWireWorkflow } = loadModule()
  const generate = ext({ id: 'pack/generate', nodeId: 'generate', name: 'Trellis GGUF', input: 'image', output: 'mesh', type: 'model' })
  const optimize = ext({ id: 'pack/optimize', nodeId: 'optimize', name: 'Optimize Mesh', input: 'mesh', output: 'mesh' })
  const workflow = wf(
    [imageNode('img'), extNode('gen', 'pack/generate'), { ...extNode('opt', 'pack/optimize'), position: { x: 800, y: 0 } }],
    [
      { id: 'e1', source: 'img', target: 'gen' },
      { id: 'e2', source: 'img', target: 'opt' },   // wrong type on opt's only slot
    ],
  )

  const { workflow: out, added } = autoWireWorkflow(workflow, [generate, optimize])
  assert.equal(added.length, 1)
  assert.match(added[0], /Trellis GGUF → Optimize Mesh \(mesh, replacing Image\)/)
  assert.ok(!out.edges.some((e) => e.id === 'e2'), 'the mis-typed edge is dropped')
  assert.ok(out.edges.some((e) => e.source === 'gen' && e.target === 'opt' && e.targetHandle === 'input-0'))
  assert.ok(out.edges.some((e) => e.id === 'e1'), 'unrelated edges are untouched')
})

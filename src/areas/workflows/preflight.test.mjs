import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Bundle preflight.ts (and its real dependency mockExtensions.ts) into CJS.
// All @shared/* imports in those files are type-only, so esbuild erases them
// and no path-alias resolution is required.
function loadModule() {
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-preflight-test-')), 'preflight.cjs')
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve('src/areas/workflows/preflight.ts')],
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

// Carries a file: an Image node with nothing chosen is an issue of its own now,
// and every graph below is meant to test something else.
const imageNode = (id = 'img') => ({ id, type: 'imageNode', position: { x: 0, y: 0 }, data: { params: { filePath: 'C:/tmp/in.png' } } })
const textNode = (id = 'txt') => ({ id, type: 'textNode', position: { x: 0, y: 0 }, data: {} })

// ─── Tests ───────────────────────────────────────────────────────────────────

test('valid graph (image → extension expecting image) produces no issues', () => {
  const { validateWorkflowPreflight } = loadModule()
  const extensions = [ext()]
  const workflow = wf(
    [imageNode('img'), { id: 'proc', type: 'extensionNode', position: { x: 0, y: 0 }, data: { extensionId: 'pack/process-node' } }],
    [{ id: 'e1', source: 'img', target: 'proc' }],
  )

  assert.deepEqual(validateWorkflowPreflight(workflow, extensions), [])
})

test('extension node with no matching incoming connection is flagged', () => {
  const { validateWorkflowPreflight } = loadModule()
  const extensions = [ext()]
  const workflow = wf(
    [{ id: 'proc', type: 'extensionNode', position: { x: 0, y: 0 }, data: { extensionId: 'pack/process-node' } }],
    [],
  )

  const issues = validateWorkflowPreflight(workflow, extensions)
  assert.equal(issues.length, 1)
  assert.equal(issues[0].key, 'proc:missing:image')
  assert.match(issues[0].message, /needs an incoming image connection/)
})

test('type mismatch on an incoming edge is flagged', () => {
  const { validateWorkflowPreflight } = loadModule()
  const extensions = [ext()] // expects image
  const workflow = wf(
    [textNode('txt'), { id: 'proc', type: 'extensionNode', position: { x: 0, y: 0 }, data: { extensionId: 'pack/process-node' } }],
    [{ id: 'e1', source: 'txt', target: 'proc' }],
  )

  const issues = validateWorkflowPreflight(workflow, extensions)
  // missing required image input AND a text→image type mismatch
  assert.ok(issues.some((i) => i.key === 'proc:missing:image'))
  assert.ok(issues.some((i) => i.key === 'proc:type:e1' && /outputs text/.test(i.message)))
})

test('unknown extension id is reported as unavailable', () => {
  const { validateWorkflowPreflight } = loadModule()
  const workflow = wf(
    [{ id: 'proc', type: 'extensionNode', position: { x: 0, y: 0 }, data: { extensionId: 'ghost/node' } }],
    [],
  )

  const issues = validateWorkflowPreflight(workflow, [])
  assert.equal(issues.length, 1)
  assert.equal(issues[0].key, 'proc:missing-extension')
  assert.match(issues[0].message, /unavailable/)
})

// The panel's image rescues a model step only — the runner takes the strict
// path for a process step.
const modelExt   = () => ext({ id: 'gen/generate',  nodeId: 'generate', name: 'Generate', type: 'model',   input: 'image', output: 'mesh' })
const processExt = () => ext({ id: 'proc/pixelate', nodeId: 'pixelate', name: 'Pixelate', type: 'process', input: 'image', output: 'image' })
const step = (id, extensionId) => ({ id, type: 'extensionNode', position: { x: 0, y: 0 }, data: { extensionId } })
const noImageIssue = (issues) => issues.find((i) => i.key === 'img:no-image-file')

test('an Image node feeding a model step flags, unless the panel has one selected', () => {
  const { validateWorkflowPreflight } = loadModule()
  const workflow = wf(
    [
      { id: 'img', type: 'imageNode', position: { x: 0, y: 0 }, data: { params: {} } },
      step('gen', 'gen/generate'),
    ],
    [{ id: 'e1', source: 'img', target: 'gen' }],
  )
  const exts = [modelExt()]

  const bare = noImageIssue(validateWorkflowPreflight(workflow, exts))
  assert.ok(bare)
  assert.equal(bare.nodeId, 'img')
  assert.match(bare.message, /needs a file selected/)
  // Only wiring is auto-repairable; a file is the user's to pick.
  assert.equal(bare.autoWirable, undefined)

  // The runner falls back to the panel's image, a blob dropped on it, or an
  // image attached to the chat turn — the caller folds all three into one flag.
  assert.equal(noImageIssue(validateWorkflowPreflight(workflow, exts, { hasFallbackImage: true })), undefined)
})

test('a process step is not rescued by the panel image', () => {
  const { validateWorkflowPreflight } = loadModule()
  // Real graph: "Mesh -> Pixel Art Sprites" wires an Image node straight into
  // sprite-pipeline/pixelate, and the runner throws however full the panel is.
  const workflow = wf(
    [
      { id: 'img', type: 'imageNode', position: { x: 0, y: 0 }, data: { params: {} } },
      step('px', 'proc/pixelate'),
    ],
    [{ id: 'e1', source: 'img', target: 'px' }],
  )
  assert.ok(noImageIssue(validateWorkflowPreflight(workflow, [processExt()], { hasFallbackImage: true })))
})

test('one process consumer among model ones is enough to flag', () => {
  const { validateWorkflowPreflight } = loadModule()
  const workflow = wf(
    [
      { id: 'img', type: 'imageNode', position: { x: 0, y: 0 }, data: { params: {} } },
      step('gen', 'gen/generate'),
      step('px',  'proc/pixelate'),
    ],
    [
      { id: 'e1', source: 'img', target: 'gen' },
      { id: 'e2', source: 'img', target: 'px' },
    ],
  )
  assert.ok(noImageIssue(validateWorkflowPreflight(workflow, [modelExt(), processExt()], { hasFallbackImage: true })))
})

test('a consumer behind a Wait node is still seen', () => {
  const { validateWorkflowPreflight } = loadModule()
  const workflow = wf(
    [
      { id: 'img',  type: 'imageNode', position: { x: 0, y: 0 }, data: { params: {} } },
      { id: 'wait', type: 'waitNode',  position: { x: 0, y: 0 }, data: {} },
      step('px', 'proc/pixelate'),
    ],
    [
      { id: 'e1', source: 'img',  target: 'wait' },
      { id: 'e2', source: 'wait', target: 'px' },
    ],
  )
  assert.ok(noImageIssue(validateWorkflowPreflight(workflow, [processExt()], { hasFallbackImage: true })))
})

test('a cycle between consumers terminates', () => {
  const { validateWorkflowPreflight } = loadModule()
  const workflow = wf(
    [
      { id: 'img',  type: 'imageNode', position: { x: 0, y: 0 }, data: { params: {} } },
      { id: 'w1', type: 'waitNode', position: { x: 0, y: 0 }, data: {} },
      { id: 'w2', type: 'waitNode', position: { x: 0, y: 0 }, data: {} },
    ],
    [
      { id: 'e1', source: 'img', target: 'w1' },
      { id: 'e2', source: 'w1',  target: 'w2' },
      { id: 'e3', source: 'w2',  target: 'w1' },
    ],
  )
  assert.equal(noImageIssue(validateWorkflowPreflight(workflow, [])), undefined)
})

test('an Image node feeding only a preview is left alone', () => {
  const { validateWorkflowPreflight } = loadModule()
  // Nothing executes it, so no run can fail on it.
  const workflow = wf(
    [
      { id: 'img',  type: 'imageNode',   position: { x: 0, y: 0 }, data: { params: {} } },
      { id: 'prev', type: 'previewNode', position: { x: 0, y: 0 }, data: {} },
    ],
    [{ id: 'e1', source: 'img', target: 'prev' }],
  )
  assert.equal(noImageIssue(validateWorkflowPreflight(workflow, [])), undefined)
})

test('whitespace is not a file, an actual path is', () => {
  const { validateWorkflowPreflight } = loadModule()
  const build = (params) => wf(
    [
      { id: 'img', type: 'imageNode', position: { x: 0, y: 0 }, data: { params } },
      step('px', 'proc/pixelate'),
    ],
    [{ id: 'e1', source: 'img', target: 'px' }],
  )
  const flagged = (params) => !!noImageIssue(validateWorkflowPreflight(build(params), [processExt()]))
  assert.equal(flagged({ filePath: 'C:/tmp/in.png' }), false)
  assert.equal(flagged({ filePath: '   ' }), true)
  assert.equal(flagged({ filePath: '' }), true)
  assert.equal(flagged({}), true)
})

test('an Image node wired to nothing is left alone', () => {
  const { validateWorkflowPreflight } = loadModule()
  // Nothing consumes it, so no run can fail on it — blocking here would stop a
  // graph that works.
  const stray = wf([{ id: 'img', type: 'imageNode', position: { x: 0, y: 0 }, data: { params: {} } }])
  assert.deepEqual(validateWorkflowPreflight(stray, []), [])
})

test('a missing connection is auto-wirable; an unpicked file is not', () => {
  const { validateWorkflowPreflight } = loadModule()
  // `px` consumes the Image node, so its unset file counts; `proc` is fed by
  // nothing, so its missing edge counts too. One graph, one issue of each kind.
  const workflow = wf(
    [
      { id: 'img', type: 'imageNode', position: { x: 0, y: 0 }, data: { params: {} } },
      step('px', 'proc/pixelate'),
      { id: 'proc', type: 'extensionNode', position: { x: 0, y: 0 }, data: { extensionId: 'pack/process-node' } },
    ],
    [{ id: 'e1', source: 'img', target: 'px' }],
  )

  const issues = validateWorkflowPreflight(workflow, [ext(), processExt()])
  const missing = issues.find((i) => i.key === 'proc:missing:image')
  const noFile  = issues.find((i) => i.key === 'img:no-image-file')
  assert.equal(missing.autoWirable, true)
  assert.equal(noFile.autoWirable, undefined)
})

test('meshNode set to current scene flags when no mesh is loaded', () => {
  const { validateWorkflowPreflight } = loadModule()
  const workflow = wf([
    { id: 'mesh', type: 'meshNode', position: { x: 0, y: 0 }, data: { params: { source: 'current' } } },
  ])

  const without = validateWorkflowPreflight(workflow, [], { currentMeshUrl: null })
  assert.equal(without.length, 1)
  assert.equal(without[0].key, 'mesh:current-mesh')

  const withMesh = validateWorkflowPreflight(workflow, [], { currentMeshUrl: '/tmp/mesh.glb' })
  assert.deepEqual(withMesh, [])
})

// ─── LLM model params & provider ports ───────────────────────────────────────

const LLM_MODELS = [
  { id: 'ready-7b',  name: 'Ready 7B',  downloaded: true },
  { id: 'absent-7b', name: 'Absent 7B', downloaded: false },
]

const llmExt = (paramOverrides = {}) => ext({
  input: 'text',
  params: [{ id: 'model_variant', label: 'Model', type: 'llm-model', default: 'ready-7b', ...paramOverrides }],
})

const extNode = (id = 'proc') =>
  ({ id, type: 'extensionNode', position: { x: 0, y: 0 }, data: { extensionId: 'pack/process-node', params: {} } })

test('llm-model param pointing at a downloaded model produces no issue', () => {
  const { validateWorkflowPreflight } = loadModule()
  const workflow = wf([textNode('txt'), extNode('proc')], [{ id: 'e1', source: 'txt', target: 'proc' }])

  assert.deepEqual(validateWorkflowPreflight(workflow, [llmExt()], { llmModels: LLM_MODELS }), [])
})

test('llm-model param whose model is not downloaded is flagged', () => {
  const { validateWorkflowPreflight } = loadModule()
  const workflow = wf([textNode('txt'), extNode('proc')], [{ id: 'e1', source: 'txt', target: 'proc' }])

  const issues = validateWorkflowPreflight(workflow, [llmExt({ default: 'absent-7b' })], { llmModels: LLM_MODELS })
  assert.equal(issues.length, 1)
  assert.equal(issues[0].key, 'proc:llm-model:model_variant')
  assert.match(issues[0].message, /Absent 7B.*isn't downloaded/)
})

test('llm-model param pointing at an unknown model is flagged', () => {
  const { validateWorkflowPreflight } = loadModule()
  const workflow = wf([textNode('txt'), extNode('proc')], [{ id: 'e1', source: 'txt', target: 'proc' }])

  const issues = validateWorkflowPreflight(workflow, [llmExt({ default: 'hallucinated' })], { llmModels: LLM_MODELS })
  assert.equal(issues.length, 1)
  assert.match(issues[0].message, /unknown model "hallucinated"/)
})

test('llm-model check is skipped while the model library is unknown', () => {
  const { validateWorkflowPreflight } = loadModule()
  const workflow = wf([textNode('txt'), extNode('proc')], [{ id: 'e1', source: 'txt', target: 'proc' }])

  assert.deepEqual(validateWorkflowPreflight(workflow, [llmExt({ default: 'absent-7b' })], {}), [])
})

test('multi-input extension requires every declared input type', () => {
  const { validateWorkflowPreflight } = loadModule()
  const extensions = [ext({ inputs: ['image', 'text'] })]
  const workflow = wf(
    [imageNode('img'), { id: 'proc', type: 'extensionNode', position: { x: 0, y: 0 }, data: { extensionId: 'pack/process-node' } }],
    [{ id: 'e1', source: 'img', target: 'proc' }],
  )

  const issues = validateWorkflowPreflight(workflow, extensions)
  // image satisfied, text still missing
  assert.ok(!issues.some((i) => i.key === 'proc:missing:image'))
  assert.ok(issues.some((i) => i.key === 'proc:missing:text'))
})

test('an extension declaring the same input type twice needs one edge per slot', () => {
  const { validateWorkflowPreflight } = loadModule()
  // Positive + negative prompt: two text inputs. De-duplicating the required
  // types made a single text edge look like both were satisfied, so a run
  // started with slot 1 empty and the extension silently got one prompt.
  const extensions = [ext({ inputs: ['text', 'text'] })]
  const proc = { id: 'proc', type: 'extensionNode', position: { x: 0, y: 0 }, data: { extensionId: 'pack/process-node' } }

  const onlyFirst = wf(
    [textNode('t1'), proc],
    [{ id: 'e1', source: 't1', target: 'proc', targetHandle: 'input-0' }],
  )
  const issues = validateWorkflowPreflight(onlyFirst, extensions)
  assert.ok(!issues.some((i) => i.key === 'proc:missing:0:text'))
  assert.ok(issues.some((i) => i.key === 'proc:missing:1:text'), 'slot 1 must still be reported')

  const both = wf(
    [textNode('t1'), textNode('t2'), proc],
    [
      { id: 'e1', source: 't1', target: 'proc', targetHandle: 'input-0' },
      { id: 'e2', source: 't2', target: 'proc', targetHandle: 'input-1' },
    ],
  )
  assert.equal(validateWorkflowPreflight(both, extensions).length, 0)
})

// ─── VRAM ────────────────────────────────────────────────────────────────────

/** A one-step graph whose extension declares `vramGb`, fed a valid image. */
const vramGraph = (vramGb) => ({
  workflow: wf(
    [imageNode('img'), { id: 'proc', type: 'extensionNode', position: { x: 0, y: 0 }, data: { extensionId: 'pack/process-node' } }],
    [{ id: 'e1', source: 'img', target: 'proc' }],
  ),
  extensions: [ext(vramGb === undefined ? {} : { vramGb })],
})

test('a step declaring more VRAM than the card is warned about, not blocked', () => {
  const { validateWorkflowPreflight, blockingIssues } = loadModule()
  const { workflow, extensions } = vramGraph(16)

  const issues = validateWorkflowPreflight(workflow, extensions, { vramGb: 12 })
  assert.equal(issues.length, 1)
  assert.equal(issues[0].key, 'proc:vram')
  assert.equal(issues[0].severity, 'warning')
  assert.match(issues[0].message, /16 GB of VRAM.*has 12 GB/)
  // The whole point: the Run button stays available.
  assert.deepEqual(blockingIssues(issues), [])
})

test('a step that fits, or a number nobody declared, says nothing', () => {
  const { validateWorkflowPreflight } = loadModule()
  const fits = vramGraph(8)
  assert.deepEqual(validateWorkflowPreflight(fits.workflow, fits.extensions, { vramGb: 12 }), [])

  // Exactly the card's size is not "more than" it.
  const exact = vramGraph(12)
  assert.deepEqual(validateWorkflowPreflight(exact.workflow, exact.extensions, { vramGb: 12 }), [])

  // Card unmeasurable (no NVIDIA GPU), and manifest silent: both stay quiet.
  const heavy = vramGraph(16)
  assert.deepEqual(validateWorkflowPreflight(heavy.workflow, heavy.extensions, {}), [])
  assert.deepEqual(validateWorkflowPreflight(heavy.workflow, heavy.extensions, { vramGb: 0 }), [])
  const undeclared = vramGraph(undefined)
  assert.deepEqual(validateWorkflowPreflight(undeclared.workflow, undeclared.extensions, { vramGb: 4 }), [])
})

test('blockingIssues keeps everything that did not opt out', () => {
  const { validateWorkflowPreflight, blockingIssues } = loadModule()
  // A missing input (blocking, no severity set) alongside the VRAM warning.
  const workflow = wf([{ id: 'proc', type: 'extensionNode', position: { x: 0, y: 0 }, data: { extensionId: 'pack/process-node' } }])
  const issues = validateWorkflowPreflight(workflow, [ext({ vramGb: 16 })], { vramGb: 12 })

  assert.equal(issues.length, 2)
  assert.deepEqual(blockingIssues(issues).map((i) => i.key), ['proc:missing:image'])
})

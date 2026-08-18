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

const imageNode = (id = 'img') => ({ id, type: 'imageNode', position: { x: 0, y: 0 }, data: {} })
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

const llmNode = (id = 'llm', params = {}) =>
  ({ id, type: 'llmNode', position: { x: 0, y: 0 }, data: { params } })

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

test('a wired provider owns the model check, reported once on the LLM node', () => {
  const { validateWorkflowPreflight } = loadModule()
  const workflow = wf(
    [textNode('txt'), extNode('proc'), llmNode('llm', { model: 'absent-7b' })],
    [
      { id: 'e1', source: 'txt', target: 'proc' },
      { id: 'e2', source: 'llm', target: 'proc', sourceHandle: 'llm', targetHandle: 'llm-model_variant' },
    ],
  )

  const issues = validateWorkflowPreflight(workflow, [llmExt()], { llmModels: LLM_MODELS })
  assert.equal(issues.length, 1)
  assert.equal(issues[0].key, 'llm:llm-model')
  assert.match(issues[0].message, /Absent 7B.*isn't downloaded/)
})

test('a wired provider suppresses the consumer param check even when it would fail', () => {
  const { validateWorkflowPreflight } = loadModule()
  const workflow = wf(
    [textNode('txt'), extNode('proc'), llmNode('llm', { model: 'ready-7b' })],
    [
      { id: 'e1', source: 'txt', target: 'proc' },
      { id: 'e2', source: 'llm', target: 'proc', sourceHandle: 'llm', targetHandle: 'llm-model_variant' },
    ],
  )

  // The param default is a bad id, but the connection is what actually runs.
  const issues = validateWorkflowPreflight(workflow, [llmExt({ default: 'hallucinated' })], { llmModels: LLM_MODELS })
  assert.deepEqual(issues, [])
})

test('a provider-only LLM node needs no prompt', () => {
  const { validateWorkflowPreflight } = loadModule()
  const workflow = wf(
    [textNode('txt'), extNode('proc'), llmNode('llm', { model: 'ready-7b' })],
    [
      { id: 'e1', source: 'txt', target: 'proc' },
      { id: 'e2', source: 'llm', target: 'proc', sourceHandle: 'llm', targetHandle: 'llm-model_variant' },
    ],
  )

  assert.deepEqual(validateWorkflowPreflight(workflow, [llmExt()], { llmModels: LLM_MODELS }), [])
})

test('an LLM node producing text still needs a prompt', () => {
  const { validateWorkflowPreflight } = loadModule()
  const workflow = wf(
    [llmNode('llm'), extNode('proc')],
    [{ id: 'e1', source: 'llm', target: 'proc' }],
  )

  const issues = validateWorkflowPreflight(workflow, [llmExt()], { llmModels: LLM_MODELS })
  assert.ok(issues.some((i) => i.key === 'llm:llm-no-prompt'))
})

test('a model-provider edge does not count as a data input', () => {
  const { validateWorkflowPreflight } = loadModule()
  const workflow = wf(
    [extNode('proc'), llmNode('llm', { model: 'ready-7b' })],
    [{ id: 'e2', source: 'llm', target: 'proc', sourceHandle: 'llm', targetHandle: 'llm-model_variant' }],
  )

  // The provider link must not satisfy the required text input…
  const issues = validateWorkflowPreflight(workflow, [llmExt()], { llmModels: LLM_MODELS })
  assert.ok(issues.some((i) => i.key === 'proc:missing:text'))
  // …nor be reported as a type mismatch.
  assert.ok(!issues.some((i) => i.key.startsWith('proc:type:')))
})

test('an LLM node with no model is checked against the agent fallback', () => {
  const { validateWorkflowPreflight } = loadModule()
  const workflow = wf([textNode('txt'), llmNode('llm')], [{ id: 'e1', source: 'txt', target: 'llm' }])

  // Fresh install: the agent default is a catalog id that isn't downloaded yet.
  const issues = validateWorkflowPreflight(workflow, [], {
    llmModels: LLM_MODELS, defaultLlmModel: 'absent-7b',
  })
  assert.equal(issues.length, 1)
  assert.equal(issues[0].key, 'llm:llm-model')
  assert.match(issues[0].message, /Absent 7B.*isn't downloaded/)

  // Same graph, a usable fallback → nothing to report.
  assert.deepEqual(
    validateWorkflowPreflight(workflow, [], { llmModels: LLM_MODELS, defaultLlmModel: 'ready-7b' }),
    [],
  )
})

test('a provider-only LLM node is still checked against the agent fallback', () => {
  const { validateWorkflowPreflight } = loadModule()
  const workflow = wf(
    [textNode('txt'), extNode('proc'), llmNode('llm')],
    [
      { id: 'e1', source: 'txt', target: 'proc' },
      { id: 'e2', source: 'llm', target: 'proc', sourceHandle: 'llm', targetHandle: 'llm-model_variant' },
    ],
  )

  // The consumer check is suppressed by the wire, so the provider's fallback is
  // the only thing standing between the user and a mid-run failure.
  const issues = validateWorkflowPreflight(workflow, [llmExt()], {
    llmModels: LLM_MODELS, defaultLlmModel: 'absent-7b',
  })
  assert.equal(issues.length, 1)
  assert.equal(issues[0].key, 'llm:llm-model')
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

import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Bundle the store with its real zustand dependency; the only other import is a
// type-only one (electron.d) which esbuild erases. The store reads the global
// `window.electron.workflows.*` bridge, which we stub per test.
function loadStore() {
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-wfstore-test-')), 'workflowsStore.cjs')
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve('src/shared/stores/workflowsStore.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return require(outfile).useWorkflowsStore
}

function stubBridge(workflows = {}) {
  globalThis.window = { electron: { workflows } }
}

const migrated = (id, over = {}) => ({
  id, name: id.toUpperCase(), description: '', nodes: [], edges: [],
  createdAt: '', updatedAt: '', ...over,
})

const legacyBlocks = (id) => ({
  id, name: id.toUpperCase(), description: '', input: 'image',
  blocks: [{ id: `${id}-blk`, extension: 'pack/x', enabled: true, params: {} }],
  createdAt: '', updatedAt: '',
})

// ─── load(): dedupe + migrate ──────────────────────────────────────────────────

test('load dedupes workflows that share an id, keeping the first', async () => {
  const useStore = loadStore()
  stubBridge({
    list: async () => [migrated('a', { name: 'FIRST' }), migrated('a', { name: 'SECOND' }), migrated('b')],
  })

  await useStore.getState().load()
  const { workflows, loading } = useStore.getState()

  assert.equal(loading, false)
  assert.deepEqual(workflows.map((w) => w.id), ['a', 'b'])
  assert.equal(workflows[0].name, 'FIRST') // the duplicate is dropped, first wins
})

test('load migrates legacy block-format workflows into nodes + edges', async () => {
  const useStore = loadStore()
  stubBridge({ list: async () => [legacyBlocks('w')] })

  await useStore.getState().load()
  const wf = useStore.getState().workflows[0]

  assert.deepEqual(wf.nodes.map((n) => n.type), ['inputNode', 'extensionNode'])
  assert.equal(wf.nodes[0].id, 'input-w')
  assert.equal(wf.nodes[1].id, 'w-blk')
  assert.equal(wf.edges.length, 1)
  assert.deepEqual({ source: wf.edges[0].source, target: wf.edges[0].target }, { source: 'input-w', target: 'w-blk' })
})

test('load drops a node type the app no longer ships, and its edges with it', async () => {
  // The LLM node shipped, then was withdrawn. React Flow has no component left
  // for it: left in place it sits there as a ghost the runner skips and preflight
  // cannot type — silently, on a graph the user built.
  const useStore = loadStore()
  stubBridge({
    list: async () => [migrated('w', {
      nodes: [
        { id: 'txt', type: 'textNode',      position: { x: 0, y: 0 }, data: { params: {} } },
        { id: 'llm', type: 'llmNode',       position: { x: 1, y: 0 }, data: { params: { model: 'qwen3-4b' } } },
        { id: 'cad', type: 'extensionNode', position: { x: 2, y: 0 }, data: { extensionId: 'pack/cad', params: {} } },
      ],
      edges: [
        { id: 'e1', source: 'txt', target: 'llm', targetHandle: 'input-0' },
        { id: 'e2', source: 'llm', target: 'cad', targetHandle: 'input-0' },
      ],
    })],
  })

  await useStore.getState().load()
  const wf = useStore.getState().workflows[0]

  assert.deepEqual(wf.nodes.map((n) => n.id), ['txt', 'cad'])
  // Both edges touched the removed node, so neither can survive — sanitizeEdges
  // drops a dangling endpoint on its own.
  assert.deepEqual(wf.edges, [])
})

test('a workflow without a retired node is passed through untouched', async () => {
  const useStore = loadStore()
  const nodes = [
    { id: 'img', type: 'imageNode',     position: { x: 0, y: 0 }, data: { params: {} } },
    { id: 'gen', type: 'extensionNode', position: { x: 1, y: 0 }, data: { extensionId: 'pack/gen', params: {} } },
  ]
  const edges = [{ id: 'e1', source: 'img', sourceHandle: 'output', target: 'gen', targetHandle: 'input-0' }]
  stubBridge({ list: async () => [migrated('w', { nodes, edges })] })

  await useStore.getState().load()
  const wf = useStore.getState().workflows[0]

  assert.deepEqual(wf.nodes.map((n) => n.id), ['img', 'gen'])
  assert.equal(wf.edges.length, 1)
})

test('load flips loading back to false when the bridge throws', async () => {
  const useStore = loadStore()
  stubBridge({ list: async () => { throw new Error('disk error') } })

  await useStore.getState().load()
  assert.equal(useStore.getState().loading, false)
})

// ─── save(): insert vs update ──────────────────────────────────────────────────

test('save inserts a new workflow at the front, updates an existing one in place', async () => {
  const useStore = loadStore()
  stubBridge({ save: async () => ({ success: true }) })
  useStore.setState({ workflows: [migrated('a'), migrated('b')] })

  await useStore.getState().save(migrated('c'))
  assert.deepEqual(useStore.getState().workflows.map((w) => w.id), ['c', 'a', 'b'])

  await useStore.getState().save(migrated('b', { name: 'B2' }))
  const wf = useStore.getState().workflows.find((w) => w.id === 'b')
  assert.equal(wf.name, 'B2')
  assert.equal(useStore.getState().workflows.length, 3) // no duplicate
})

test('save does not touch state when the bridge reports failure', async () => {
  const useStore = loadStore()
  stubBridge({ save: async () => ({ success: false, error: 'nope' }) })
  useStore.setState({ workflows: [migrated('a')] })

  const result = await useStore.getState().save(migrated('z'))
  assert.equal(result.success, false)
  assert.deepEqual(useStore.getState().workflows.map((w) => w.id), ['a'])
})

// ─── remove(): filter + active reset ────────────────────────────────────────────

test('remove drops the workflow and clears activeId when it was the active one', async () => {
  const useStore = loadStore()
  stubBridge({ delete: async () => ({ success: true }) })
  useStore.setState({ workflows: [migrated('a'), migrated('b')], activeId: 'a' })

  await useStore.getState().remove('a')
  assert.deepEqual(useStore.getState().workflows.map((w) => w.id), ['b'])
  assert.equal(useStore.getState().activeId, null)
})

test('remove keeps activeId when a different workflow is deleted', async () => {
  const useStore = loadStore()
  stubBridge({ delete: async () => ({ success: true }) })
  useStore.setState({ workflows: [migrated('a'), migrated('b')], activeId: 'b' })

  await useStore.getState().remove('a')
  assert.equal(useStore.getState().activeId, 'b')
})

// ─── importFile() + setActive() ────────────────────────────────────────────────

test('importFile migrates, moves the workflow to the front, and makes it active', async () => {
  const useStore = loadStore()
  stubBridge({ import: async () => ({ success: true, workflow: legacyBlocks('imp') }) })
  useStore.setState({ workflows: [migrated('a')], activeId: 'a' })

  await useStore.getState().importFile()
  const { workflows, activeId } = useStore.getState()

  assert.deepEqual(workflows.map((w) => w.id), ['imp', 'a'])
  assert.equal(activeId, 'imp')
  assert.deepEqual(workflows[0].nodes.map((n) => n.type), ['inputNode', 'extensionNode'])
})

test('setActive updates only activeId', () => {
  const useStore = loadStore()
  stubBridge()
  useStore.setState({ workflows: [migrated('a')], activeId: null })

  useStore.getState().setActive('a')
  assert.equal(useStore.getState().activeId, 'a')
})

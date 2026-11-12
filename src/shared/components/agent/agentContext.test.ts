import assert from 'node:assert/strict'
import test from 'node:test'

import { assembleAgentContext, buildAgentContext } from './agentContext'
import type { AgentContextInputs } from './agentContext'
import type { ModelExtension, ProcessExtension } from '../../types/electron.d'
import { useAppStore } from '../../stores/appStore'
import { useNavStore } from '../../stores/navStore'
import { PAGES } from '../../pages/pageRegistry'
import { useWorkflowsStore } from '../../stores/workflowsStore'
import { useExtensionsStore } from '../../stores/extensionsStore'

const node = (id: string, input: string, output: string) => ({ id, name: id.toUpperCase(), input, output, paramsSchema: [] })

const modelExt = {
  type: 'model', id: 'triposr', name: 'TripoSR', trusted: true, builtin: false, nodes: [node('main', 'image', 'mesh')],
} as unknown as ModelExtension
const processExt = {
  type: 'process', id: 'mesh-ops', name: 'Mesh Ops', trusted: true, builtin: true, entry: 'x', nodes: [node('decimate', 'mesh', 'mesh')],
} as unknown as ProcessExtension
const STORAGE = { modelsDir: 'M', workspaceDir: 'W', workflowsDir: 'F', extensionsDir: 'E' }

const PAGE_LIST = [{ id: 'generate', label: 'Generate' }, { id: 'models', label: 'Extensions' }]

const inputs = (over: Partial<AgentContextInputs> = {}): AgentContextInputs => ({
  page: 'models',
  pages: PAGE_LIST,
  currentMeshUrl: '/workspace/Default/mesh.glb',
  meshTriangles: 1200,
  workflows: [{ id: 'wf1', name: 'Turntable' }],
  modelExtensions: [modelExt],
  processExtensions: [processExt],
  models: [{ id: 'triposr/main', name: 'TripoSR' }],
  storage: STORAGE,
  ui: { uiScale: 'large', useAtkinsonFont: true, showRamIndicator: false },
  ...over,
})

test('the context carries the page, mesh, workflows, extensions, models, storage and UI options', () => {
  assert.deepEqual(assembleAgentContext(inputs()), {
    page: 'models',
    pages: PAGE_LIST,
    currentMeshPath: 'Default/mesh.glb',
    meshTriangles: 1200,
    workflows: [{ id: 'wf1', name: 'Turntable' }],
    extensions: [
      { id: 'mesh-ops/decimate', name: 'DECIMATE', input: 'mesh', output: 'mesh' },
      { id: 'triposr/main', name: 'MAIN', input: 'image', output: 'mesh' },
    ],
    models: [{ id: 'triposr/main', name: 'TripoSR' }],
    storage: STORAGE,
    ui: { uiScale: 'large', useAtkinsonFont: true, showRamIndicator: false },
  })
})

test('empty or unreadable parts are left out, as buildContext did', () => {
  const ctx = assembleAgentContext(inputs({
    currentMeshUrl: undefined, meshTriangles: null, workflows: [], modelExtensions: [], processExtensions: [], models: null, storage: null,
  }))
  assert.deepEqual(Object.keys(ctx), ['page', 'pages', 'ui'])
})

test('storage keeps only the four folders, never the HF token', () => {
  const ctx = assembleAgentContext(inputs({ storage: { ...STORAGE, hfToken: 'secret' } as typeof STORAGE }))
  assert.deepEqual(ctx.storage, STORAGE)
})

test('buildAgentContext reads the stores and the async sources', async () => {
  useNavStore.setState({ currentPage: 'workflows' })
  useAppStore.setState({ currentJob: null, meshStats: null, uiScale: 'small', useAtkinsonFont: false, showRamIndicator: true })
  useWorkflowsStore.setState({ workflows: [{ id: 'w', name: 'W', description: '', nodes: [], edges: [], createdAt: '', updatedAt: '' }] })
  useExtensionsStore.setState({ modelExtensions: [modelExt], processExtensions: [] })

  const ctx = await buildAgentContext({
    fetchModels: async () => [{ id: 'triposr/main', name: 'TripoSR' }],
    getStorage: async () => { throw new Error('IPC down') },
  })

  assert.deepEqual(ctx, {
    page: 'workflows',
    // Every registered page, by id and sidebar label.
    pages: PAGES.map((p) => ({ id: p.id, label: p.label })),
    workflows: [{ id: 'w', name: 'W' }],
    extensions: [{ id: 'triposr/main', name: 'MAIN', input: 'image', output: 'mesh' }],
    models: [{ id: 'triposr/main', name: 'TripoSR' }],
    ui: { uiScale: 'small', useAtkinsonFont: false, showRamIndicator: true },
  })
})

import type { ModelExtension, ProcessExtension } from '../../types/electron.d'
import type { Workflow } from '../../types/electron.d'
import type { UiScale } from '../../stores/appStore'
import type { Page } from '../../stores/navStore'
import { useAppStore } from '../../stores/appStore'
import { useExtensionsStore } from '../../stores/extensionsStore'
import { useWorkflowsStore } from '../../stores/workflowsStore'
import { useNavStore } from '../../stores/navStore'
import { buildAllWorkflowExtensions } from '../../../areas/workflows/mockExtensions'

// The `context` object sent with every agent request: what the app shows and
// holds right now, so the agent can act without asking.

export interface AgentContextInputs {
  page: Page
  currentMeshUrl?: string | null
  meshTriangles?: number | null
  workflows: Pick<Workflow, 'id' | 'name'>[]
  modelExtensions: ModelExtension[]
  processExtensions: ProcessExtension[]
  /** Downloaded generation models; null when they could not be read. */
  models: { id: string; name: string }[] | null
  /** Null when the settings could not be read. */
  storage: { modelsDir: string; workspaceDir: string; workflowsDir: string; extensionsDir: string } | null
  ui: { uiScale: UiScale; useAtkinsonFont: boolean; showRamIndicator: boolean }
}

/** Pure assembly of the context from already-read state. */
export function assembleAgentContext(inputs: AgentContextInputs): Record<string, unknown> {
  const ctx: Record<string, unknown> = { page: inputs.page }
  if (inputs.currentMeshUrl) ctx.currentMeshPath = inputs.currentMeshUrl.replace('/workspace/', '')
  if (inputs.meshTriangles)  ctx.meshTriangles   = inputs.meshTriangles
  if (inputs.workflows.length > 0) ctx.workflows = inputs.workflows.map((w) => ({ id: w.id, name: w.name }))
  const extensions = buildAllWorkflowExtensions(inputs.modelExtensions, inputs.processExtensions)
  if (extensions.length > 0) ctx.extensions = extensions.map((e) => ({
    id: e.id, name: e.name, input: e.input, output: e.output,
  }))
  if (inputs.models) ctx.models = inputs.models.map((m) => ({ id: m.id, name: m.name }))
  if (inputs.storage) {
    const { modelsDir, workspaceDir, workflowsDir, extensionsDir } = inputs.storage
    ctx.storage = { modelsDir, workspaceDir, workflowsDir, extensionsDir }
  }
  ctx.ui = { uiScale: inputs.ui.uiScale, useAtkinsonFont: inputs.ui.useAtkinsonFont, showRamIndicator: inputs.ui.showRamIndicator }
  return ctx
}

export interface AgentContextSources {
  /** GET /model/all, filtered to the downloaded ones, as the Generate options list does. */
  fetchModels: () => Promise<{ id: string; name: string }[]>
  getStorage: () => Promise<{ modelsDir: string; workspaceDir: string; workflowsDir: string; extensionsDir: string }>
}

function defaultSources(): AgentContextSources {
  return {
    async fetchModels() {
      const res = await fetch(`${useAppStore.getState().apiUrl}/model/all`)
      if (!res.ok) throw new Error(`API error ${res.status}`)
      const list = await res.json() as { id: string; name?: string; downloaded: boolean }[]
      return list.filter((m) => m.downloaded).map((m) => ({ id: m.id, name: m.name ?? m.id }))
    },
    getStorage: () => window.electron.settings.get(),
  }
}

/** Reads the stores, the downloaded models and the storage folders, then assembles the context. */
export async function buildAgentContext(sources: AgentContextSources = defaultSources()): Promise<Record<string, unknown>> {
  const app = useAppStore.getState()
  const ext = useExtensionsStore.getState()
  const [models, storage] = await Promise.all([
    sources.fetchModels().catch(() => null),
    sources.getStorage().catch(() => null),
  ])
  return assembleAgentContext({
    page: useNavStore.getState().currentPage,
    currentMeshUrl: app.currentJob?.outputUrl,
    meshTriangles: app.meshStats?.triangles,
    workflows: useWorkflowsStore.getState().workflows,
    modelExtensions: ext.modelExtensions,
    processExtensions: ext.processExtensions,
    models,
    storage,
    ui: { uiScale: app.uiScale, useAtkinsonFont: app.useAtkinsonFont, showRamIndicator: app.showRamIndicator },
  })
}

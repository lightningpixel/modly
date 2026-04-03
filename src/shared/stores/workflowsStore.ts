import { create } from 'zustand'
import type { Workflow, WFNode, WFEdge } from '@shared/types/electron.d'

interface WorkflowsStore {
  workflows:   Workflow[]
  loading:     boolean
  activeId:    string | null

  load:          () => Promise<void>
  save:          (workflow: Workflow) => Promise<{ success: boolean; error?: string }>
  remove:        (id: string) => Promise<{ success: boolean; error?: string }>
  importFile:    () => Promise<{ success: boolean; error?: string }>
  exportFile:    (workflow: Workflow) => Promise<{ success: boolean; error?: string }>
  setActive:     (id: string | null) => void
}

// ─── Legacy migration ─────────────────────────────────────────────────────────

interface LegacyBlock {
  id:        string
  extension: string
  enabled:   boolean
  params:    Record<string, unknown>
}

interface LegacyWorkflow {
  id:          string
  name:        string
  description: string
  input?:      'image' | 'text'
  blocks?:     LegacyBlock[]
  nodes?:      WFNode[]
  edges?:      WFEdge[]
  createdAt:   string
  updatedAt:   string
}

function migrateWorkflow(raw: LegacyWorkflow): Workflow {
  // Already migrated
  if (raw.nodes && raw.edges) {
    return { ...raw, nodes: raw.nodes, edges: raw.edges } as Workflow
  }

  // Migrate from old blocks format
  const blocks  = raw.blocks ?? []
  const inputType = raw.input ?? 'image'

  const inputNode: WFNode = {
    id:       'input-' + raw.id,
    type:     'inputNode',
    position: { x: 250, y: 50 },
    data:     { inputType, enabled: true, params: {} },
  }

  const extNodes: WFNode[] = blocks.map((b, i) => ({
    id:       b.id,
    type:     'extensionNode',
    position: { x: 250, y: 150 + i * 220 },
    data:     { extensionId: b.extension, enabled: b.enabled, params: b.params },
  }))

  const allNodes = [inputNode, ...extNodes]

  const edges: WFEdge[] = allNodes.slice(0, -1).map((n, i) => ({
    id:     `e-${n.id}-${allNodes[i + 1].id}`,
    source: n.id,
    target: allNodes[i + 1].id,
  }))

  return {
    id:          raw.id,
    name:        raw.name,
    description: raw.description,
    nodes:       allNodes,
    edges,
    createdAt:   raw.createdAt,
    updatedAt:   raw.updatedAt,
  }
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useWorkflowsStore = create<WorkflowsStore>((set) => ({
  workflows: [],
  loading:   false,
  activeId:  null,

  async load() {
    set({ loading: true })
    try {
      const raw  = await window.electron.workflows.list()
      const list = (raw as LegacyWorkflow[]).map(migrateWorkflow)
      set({ workflows: list, loading: false })
    } catch {
      set({ loading: false })
    }
  },

  async save(workflow) {
    const result = await window.electron.workflows.save(workflow)
    if (result.success) {
      set((s) => {
        const idx = s.workflows.findIndex((w) => w.id === workflow.id)
        if (idx === -1) return { workflows: [workflow, ...s.workflows] }
        const next = [...s.workflows]
        next[idx] = workflow
        return { workflows: next }
      })
    }
    return result
  },

  async remove(id) {
    const result = await window.electron.workflows.delete(id)
    if (result.success) {
      set((s) => ({
        workflows: s.workflows.filter((w) => w.id !== id),
        activeId:  s.activeId === id ? null : s.activeId,
      }))
    }
    return result
  },

  async importFile() {
    const result = await window.electron.workflows.import()
    if (result.success && result.workflow) {
      const wf = migrateWorkflow(result.workflow as LegacyWorkflow)
      set((s) => {
        const filtered = s.workflows.filter((w) => w.id !== wf.id)
        return { workflows: [wf, ...filtered], activeId: wf.id }
      })
    }
    return result
  },

  async exportFile(workflow) {
    return window.electron.workflows.export(workflow)
  },

  setActive(id) {
    set({ activeId: id })
  },
}))

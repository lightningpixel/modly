import { create } from 'zustand'
import type { Workflow, WFNode, WFEdge } from '@shared/types/electron.d'

interface WorkflowsStore {
  workflows:   Workflow[]
  loading:     boolean
  activeId:    string | null
  /** Workflows shown as tabs. Closing a tab only removes it here — the file stays on disk. */
  openIds:     string[]
  /** Folder names for the workflow browser (workflows reference them via their `folder` field) */
  folders:     string[]
  /** Folder name → display color (tab stripes + folder icons) */
  folderColors: Record<string, string>
  /** Folder names pinned to the top of the workflow browser */
  bookmarkedFolders: string[]

  load:          () => Promise<void>
  save:          (workflow: Workflow) => Promise<{ success: boolean; error?: string }>
  remove:        (id: string) => Promise<{ success: boolean; error?: string }>
  importFile:    () => Promise<{ success: boolean; error?: string; workflow?: Workflow }>
  exportFile:    (workflow: Workflow) => Promise<{ success: boolean; error?: string }>
  setActive:     (id: string | null) => void
  /** Add a workflow to the tab bar (if needed) and make it active. */
  openWorkflow:  (id: string) => void
  /** Remove a workflow from the tab bar without deleting it. */
  closeWorkflow: (id: string) => void
  /** Reorder tabs: move dragId to targetId's position. */
  moveOpenTab:   (dragId: string, targetId: string) => void
  /** Create a browser folder (kept even while empty; persisted in localStorage). */
  addFolder:     (name: string) => void
  /** Remove a browser folder name (workflows inside must be moved out first by the caller). */
  removeFolder:  (name: string) => void
  /** Set a folder's display color. */
  setFolderColor: (name: string, color: string) => void
  /** Pin/unpin a folder at the top of the workflow browser. */
  toggleFolderBookmark: (name: string) => void
}

/** Palette for folder colors (tab stripes / folder icons). */
export const FOLDER_COLORS = ['#38bdf8', '#34d399', '#fbbf24', '#f87171', '#a78bfa', '#f472b6', '#94a3b8']

// Empty folders have no workflow referencing them, so their names (and colors)
// are persisted separately in localStorage to survive reloads.
const FOLDERS_KEY = 'modly-workflow-folders'

function readStoredFolders(): { names: string[]; colors: Record<string, string>; bookmarked: string[] } {
  try {
    const raw = JSON.parse(localStorage.getItem(FOLDERS_KEY) ?? '[]')
    // Legacy format: plain array of names
    if (Array.isArray(raw)) {
      return { names: raw.filter((f): f is string => typeof f === 'string'), colors: {}, bookmarked: [] }
    }
    if (raw && typeof raw === 'object') {
      const names      = Array.isArray(raw.names) ? raw.names.filter((f: unknown): f is string => typeof f === 'string') : []
      const colors     = raw.colors && typeof raw.colors === 'object' ? raw.colors as Record<string, string> : {}
      const bookmarked = Array.isArray(raw.bookmarked) ? raw.bookmarked.filter((f: unknown): f is string => typeof f === 'string') : []
      return { names, colors, bookmarked }
    }
    return { names: [], colors: {}, bookmarked: [] }
  } catch {
    return { names: [], colors: {}, bookmarked: [] }
  }
}

function storeFolders(names: string[], colors: Record<string, string>, bookmarked: string[]): void {
  try { localStorage.setItem(FOLDERS_KEY, JSON.stringify({ names, colors, bookmarked })) } catch { /* quota/private mode */ }
}

/** Least-used palette color, so new folders spread across the palette. */
function nextFolderColor(colors: Record<string, string>): string {
  const used = Object.values(colors)
  return [...FOLDER_COLORS].sort((a, b) =>
    used.filter((c) => c === a).length - used.filter((c) => c === b).length,
  )[0]
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

// Source-only nodes have no target handle; sink-only nodes have no source handle.
// An edge into/out of the wrong side can't resolve a handle and makes React Flow
// warn ("Couldn't create edge for target handle id: null") on every render.
export const NODE_TYPES_WITHOUT_TARGET = new Set(['imageNode', 'textNode', 'meshNode', 'inputNode', 'forEachNode'])
export const NODE_TYPES_WITHOUT_SOURCE = new Set(['outputNode', 'previewNode'])

function sanitizeEdges(nodes: WFNode[], edges: WFEdge[]): WFEdge[] {
  const typeOf = new Map(nodes.map((n) => [n.id, n.type]))
  return edges
    .filter((e) => {
      const source = typeOf.get(e.source)
      const target = typeOf.get(e.target)
      if (!source || !target) return false                  // dangling endpoint
      if (NODE_TYPES_WITHOUT_TARGET.has(target)) return false // target can't receive
      if (NODE_TYPES_WITHOUT_SOURCE.has(source)) return false // source can't emit
      return true
    })
    .map((e) => {
      // ExtensionNodes use id'd handles (input-0 / output). Repair edges that lost
      // them (e.g. older palette auto-wiring) so React Flow can place them instead
      // of warning "Couldn't create edge for target handle id: null".
      const patch: Partial<WFEdge> = {}
      if (typeOf.get(e.target) === 'extensionNode' && e.targetHandle == null) patch.targetHandle = 'input-0'
      if (typeOf.get(e.source) === 'extensionNode' && e.sourceHandle == null) patch.sourceHandle = 'output'
      return Object.keys(patch).length ? { ...e, ...patch } : e
    })
}

function migrateWorkflow(raw: LegacyWorkflow): Workflow {
  // Already migrated
  if (raw.nodes && raw.edges) {
    return { ...raw, nodes: raw.nodes, edges: sanitizeEdges(raw.nodes, raw.edges) } as Workflow
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
  openIds:   [],
  folders:           readStoredFolders().names,
  folderColors:      readStoredFolders().colors,
  bookmarkedFolders: readStoredFolders().bookmarked,

  async load() {
    set({ loading: true })
    try {
      const raw  = await window.electron.workflows.list()
      // Dedupe by id: two files on disk can share an internal id (e.g. a copied
      // workflow), which would produce duplicate React keys. Keep the first
      // (the list arrives sorted by updatedAt desc, so the most recent wins).
      const seen = new Set<string>()
      const list: Workflow[] = []
      for (const entry of raw as LegacyWorkflow[]) {
        const wf = migrateWorkflow(entry)
        if (seen.has(wf.id)) continue
        seen.add(wf.id)
        list.push(wf)
      }
      set((s) => {
        // Keep already-open tabs that still exist; on a fresh session open the
        // most recent workflow (the list arrives sorted by updatedAt desc).
        const openIds = s.openIds.length > 0
          ? s.openIds.filter((id) => list.some((w) => w.id === id))
          : (list.length > 0 ? [list[0].id] : [])
        const activeId = s.activeId && openIds.includes(s.activeId) ? s.activeId : (openIds[0] ?? null)
        // Folders referenced by workflows always exist, even if localStorage was cleared
        const folders = [...new Set([...s.folders, ...list.map((w) => w.folder).filter((f): f is string => !!f)])]
        storeFolders(folders, s.folderColors, s.bookmarkedFolders)
        return { workflows: list, loading: false, openIds, activeId, folders }
      })
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
      set((s) => {
        const openIds = s.openIds.filter((x) => x !== id)
        return {
          workflows: s.workflows.filter((w) => w.id !== id),
          openIds,
          activeId:  s.activeId === id ? (openIds[0] ?? null) : s.activeId,
        }
      })
    }
    return result
  },

  async importFile() {
    const result = await window.electron.workflows.import()
    if (result.success && result.workflow) {
      const wf = migrateWorkflow(result.workflow as LegacyWorkflow)
      set((s) => {
        const filtered = s.workflows.filter((w) => w.id !== wf.id)
        return {
          workflows: [wf, ...filtered],
          openIds:   s.openIds.includes(wf.id) ? s.openIds : [...s.openIds, wf.id],
          activeId:  wf.id,
        }
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

  openWorkflow(id) {
    set((s) => ({
      openIds:  s.openIds.includes(id) ? s.openIds : [...s.openIds, id],
      activeId: id,
    }))
  },

  closeWorkflow(id) {
    set((s) => {
      const idx     = s.openIds.indexOf(id)
      const openIds = s.openIds.filter((x) => x !== id)
      // When closing the active tab, activate the nearest remaining neighbour
      const activeId = s.activeId === id
        ? (openIds[Math.min(Math.max(idx, 0), openIds.length - 1)] ?? null)
        : s.activeId
      return { openIds, activeId }
    })
  },

  moveOpenTab(dragId, targetId) {
    set((s) => {
      if (dragId === targetId || !s.openIds.includes(dragId)) return s
      const ids = s.openIds.filter((x) => x !== dragId)
      const idx = ids.indexOf(targetId)
      if (idx === -1) return s
      ids.splice(idx, 0, dragId)
      return { openIds: ids }
    })
  },

  addFolder(name) {
    set((s) => {
      if (s.folders.includes(name)) return s
      const folders      = [...s.folders, name]
      const folderColors = { ...s.folderColors, [name]: nextFolderColor(s.folderColors) }
      storeFolders(folders, folderColors, s.bookmarkedFolders)
      return { folders, folderColors }
    })
  },

  removeFolder(name) {
    set((s) => {
      const folders = s.folders.filter((f) => f !== name)
      const folderColors = { ...s.folderColors }
      delete folderColors[name]
      const bookmarkedFolders = s.bookmarkedFolders.filter((f) => f !== name)
      storeFolders(folders, folderColors, bookmarkedFolders)
      return { folders, folderColors, bookmarkedFolders }
    })
  },

  setFolderColor(name, color) {
    set((s) => {
      const folderColors = { ...s.folderColors, [name]: color }
      storeFolders(s.folders, folderColors, s.bookmarkedFolders)
      return { folderColors }
    })
  },

  toggleFolderBookmark(name) {
    set((s) => {
      const bookmarkedFolders = s.bookmarkedFolders.includes(name)
        ? s.bookmarkedFolders.filter((f) => f !== name)
        : [...s.bookmarkedFolders, name]
      storeFolders(s.folders, s.folderColors, bookmarkedFolders)
      return { bookmarkedFolders }
    })
  },
}))

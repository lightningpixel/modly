import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,

  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Connection,
  type Node,
  type Edge,
  type OnConnectStartParams,
} from '@xyflow/react'
import { useWorkflowsStore } from '@shared/stores/workflowsStore'
import { useExtensionsStore } from '@shared/stores/extensionsStore'
import { useNavStore } from '@shared/stores/navStore'
import { useAppStore } from '@shared/stores/appStore'
import type { Workflow, WFNode, WFEdge, WFNodeData } from '@shared/types/electron.d'
import { buildAllWorkflowExtensions, getWorkflowExtension } from './mockExtensions'
import type { WorkflowExtension } from './mockExtensions'
import { useWorkflowRunStore } from './workflowRunStore'
import { validateWorkflowPreflight } from './preflight'
import ExtensionNode    from './nodes/ExtensionNode'
import ImageNode        from './nodes/ImageNode'
import TextNode         from './nodes/TextNode'
import AddToSceneNode   from './nodes/AddToSceneNode'
import Load3DMeshNode   from './nodes/Load3DMeshNode'
import PreviewImageNode from './nodes/PreviewImageNode'
import WorkflowEdge     from './nodes/WorkflowEdge'

// ─── Constants ────────────────────────────────────────────────────────────────

const DRAG_KEY      = 'modly/extension-id'
const DRAG_NODE_KEY = 'modly/node-type'
const NODE_TYPES = { extensionNode: ExtensionNode, imageNode: ImageNode, textNode: TextNode, outputNode: AddToSceneNode, meshNode: Load3DMeshNode, previewNode: PreviewImageNode }
const EDGE_TYPES = { workflowEdge: WorkflowEdge }

const DEFAULT_EDGE_OPTS = { type: 'workflowEdge' }

// ─── IO badge ─────────────────────────────────────────────────────────────────

const IO_STYLES: Record<'image' | 'text' | 'mesh', string> = {
  image: 'bg-sky-500/15 text-sky-400 border-sky-500/25',
  mesh:  'bg-violet-500/15 text-violet-400 border-violet-500/25',
  text:  'bg-amber-500/15 text-amber-400 border-amber-500/25',
}

function IoBadge({ type }: { type: 'image' | 'text' | 'mesh' }) {
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border ${IO_STYLES[type]}`}>
      {type}
    </span>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function newId(): string { return crypto.randomUUID() }

function newWorkflow(): Workflow {
  const now = new Date().toISOString()
  return { id: newId(), name: 'New Workflow', description: '', nodes: [], edges: [], createdAt: now, updatedAt: now }
}

function newWorkflowFromTemplate(): Workflow {
  const now         = new Date().toISOString()
  const imageNodeId = newId()
  const outputNodeId = newId()
  return {
    id:          newId(),
    name:        'New Workflow',
    description: '',
    nodes: [
      { id: imageNodeId,  type: 'imageNode',  position: { x: 150, y: 180 }, data: { enabled: true, params: {}, showInGenerate: true } },
      { id: outputNodeId, type: 'outputNode', position: { x: 500, y: 180 }, data: { enabled: true, params: {} } },
    ],
    edges: [
      { id: newId(), source: imageNodeId, target: outputNodeId, type: 'workflowEdge' },
    ],
    createdAt: now,
    updatedAt: now,
  }
}

// ─── New workflow modal ───────────────────────────────────────────────────────

function NewWorkflowModal({ onBlank, onTemplate, onClose }: {
  onBlank:    () => void
  onTemplate: () => void
  onClose:    () => void
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        className="w-80 bg-zinc-900 border border-zinc-700/80 rounded-2xl shadow-2xl overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-100">New Workflow</h2>
          <p className="text-[11px] text-zinc-500 mt-0.5">Choose how to start</p>
        </div>

        <div className="p-4 grid grid-cols-2 gap-3">
          {/* Blank */}
          <button
            onClick={onBlank}
            className="flex flex-col items-center gap-3 px-3 py-5 rounded-xl border border-zinc-800 hover:border-zinc-600 hover:bg-zinc-800/40 transition-all"
          >
            <div className="w-10 h-10 rounded-xl bg-zinc-800 border border-zinc-700/60 flex items-center justify-center text-zinc-500">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
              </svg>
            </div>
            <div className="text-center">
              <p className="text-xs font-semibold text-zinc-200">Blank</p>
              <p className="text-[10px] text-zinc-500 mt-0.5 leading-relaxed">Empty canvas</p>
            </div>
          </button>

          {/* Starter template */}
          <button
            onClick={onTemplate}
            className="flex flex-col items-center gap-3 px-3 py-5 rounded-xl border border-zinc-800 hover:border-accent/40 hover:bg-accent/5 transition-all"
          >
            <div className="w-10 h-10 rounded-xl bg-accent/10 border border-accent/25 flex items-center justify-center text-accent-light">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="3" y="3" width="6" height="5" rx="1"/>
                <path d="M9 5.5h6"/>
                <rect x="15" y="3" width="6" height="5" rx="1"/>
              </svg>
            </div>
            <div className="text-center">
              <p className="text-xs font-semibold text-zinc-200">Starter</p>
              <p className="text-[10px] text-zinc-500 mt-0.5 leading-relaxed">Image → Scene</p>
            </div>
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Extensions panel ────────────────────────────────────────────────────────

const PANEL_MIN = 240
const PANEL_MAX = 860

const PANEL_BUILTIN_NODES = [
  { type: 'imageNode',   label: 'Image',         color: '#38bdf8', icon: <><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></> },
  { type: 'textNode',    label: 'Text',           color: '#fbbf24', icon: <><path d="M17 6.1H3M21 12.1H3M15.1 18H3"/></> },
  { type: 'meshNode',    label: 'Load 3D Mesh',   color: '#a78bfa', icon: <><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></> },
  { type: 'outputNode',  label: 'Add to Scene',   color: '#a78bfa', icon: <><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></> },
  { type: 'previewNode', label: 'Preview Views',  color: '#38bdf8', icon: <><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/></> },
]

function ExtGroupHeader({ title, author, expanded, onToggle, count }: { title: string; author?: string; expanded: boolean; onToggle: () => void; count: number }) {
  return (
    <button
      onClick={onToggle}
      className="flex items-center gap-2 w-full px-1 py-1.5 group"
    >
      <svg
        width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
        className="text-zinc-600 group-hover:text-zinc-400 transition-colors shrink-0"
        style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s ease' }}
      >
        <polyline points="9 18 15 12 9 6"/>
      </svg>
      <div className="flex flex-col items-start min-w-0">
        <span className="text-[11px] font-semibold text-zinc-400 group-hover:text-zinc-200 transition-colors truncate leading-tight">{title}</span>
        {author && <span className="text-[9px] text-zinc-600 truncate leading-tight">{author}</span>}
      </div>
      <span className="ml-auto text-[9px] text-zinc-700 shrink-0">{count}</span>
    </button>
  )
}

function ExtensionsPanel({ allExtensions, open }: { allExtensions: WorkflowExtension[]; open: boolean }) {
  const [search, setSearch]       = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [width, setWidth]         = useState(288)
  const dragging = useRef(false)
  const startX   = useRef(0)
  const startW   = useRef(0)

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return
      const delta = startX.current - e.clientX
      setWidth((w) => Math.min(PANEL_MAX, Math.max(PANEL_MIN, startW.current + delta)))
    }
    const onUp = () => { dragging.current = false; document.body.style.cursor = '' }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup',   onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup',   onUp)
    }
  }, [])

  const cols      = width >= 580 ? 3 : width >= 370 ? 2 : 1
  const gridClass = cols === 3 ? 'grid-cols-3' : cols === 2 ? 'grid-cols-2' : 'grid-cols-1'
  const query     = search.trim().toLowerCase()

  const toggleGroup = (id: string) => setCollapsed((c) => ({ ...c, [id]: !c[id] }))
  const isExpanded  = (id: string, hasMatches: boolean) => (query && hasMatches) || !collapsed[id]

  // Base group
  const filteredBuiltinNodes = PANEL_BUILTIN_NODES.filter((n) => !query || n.label.toLowerCase().includes(query))
  const filteredBuiltinExts  = allExtensions.filter((e) => e.builtin && (!query || e.name.toLowerCase().includes(query)))
  const baseCount            = filteredBuiltinNodes.length + filteredBuiltinExts.length
  const baseVisible          = !query || baseCount > 0

  // Non-builtin groups: grouped by extensionId
  const nonBuiltinMap = useMemo(() => {
    const map = new Map<string, { extensionName: string; nodes: WorkflowExtension[] }>()
    for (const ext of allExtensions) {
      if (ext.builtin) continue
      if (!map.has(ext.extensionId)) map.set(ext.extensionId, { extensionName: ext.extensionName, nodes: [] })
      map.get(ext.extensionId)!.nodes.push(ext)
    }
    return map
  }, [allExtensions])

  return (
    <div
      style={{ width: open ? width : 0 }}
      className="flex overflow-hidden border-l border-zinc-800 transition-[width] duration-300 ease-in-out shrink-0"
    >
      <div className="flex shrink-0" style={{ width }}>

        {/* Resize handle */}
        <div
          onMouseDown={(e) => {
            dragging.current = true; startX.current = e.clientX; startW.current = width
            document.body.style.cursor = 'col-resize'; e.preventDefault()
          }}
          className="w-1 shrink-0 hover:bg-zinc-600 active:bg-accent/60 cursor-col-resize transition-colors self-stretch"
        />

        <div className="flex flex-col flex-1 min-w-0 bg-zinc-950/30">

          {/* Header */}
          <div className="px-4 py-3 border-b border-zinc-800">
            <h2 className="text-xs font-semibold text-zinc-300">Extensions</h2>
            <p className="text-[10px] text-zinc-600 mt-0.5">Drag onto canvas</p>
          </div>

          {/* Search */}
          <div className="px-3 pt-2.5 pb-2 border-b border-zinc-800">
            <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-zinc-800/60 border border-zinc-700/60 focus-within:border-zinc-600">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-zinc-500 shrink-0">
                <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
              </svg>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search…"
                className="flex-1 bg-transparent text-[11px] text-zinc-200 placeholder-zinc-600 focus:outline-none min-w-0"
              />
              {search && (
                <button onClick={() => setSearch('')} className="text-zinc-600 hover:text-zinc-400 transition-colors">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
              )}
            </div>
          </div>

          {/* Groups */}
          <div className="flex-1 overflow-y-auto px-3 py-2 flex flex-col gap-0.5">

            {/* ── Base group ── */}
            {baseVisible && (
              <div>
                <ExtGroupHeader
                  title="Base"
                  expanded={isExpanded('base', baseCount > 0)}
                  onToggle={() => toggleGroup('base')}
                  count={baseCount}
                />
                {isExpanded('base', baseCount > 0) && (
                  <div className={`grid ${gridClass} gap-2 mt-1.5 mb-3`}>
                    {filteredBuiltinNodes.map(({ type, label, color, icon }) => (
                      <div
                        key={type}
                        draggable
                        onDragStart={(e) => { e.dataTransfer.setData(DRAG_NODE_KEY, type); e.dataTransfer.effectAllowed = 'copy' }}
                        className="flex flex-col gap-2 px-3 py-3 rounded-lg border border-zinc-800 bg-zinc-900 transition-colors cursor-grab hover:bg-zinc-800/60 hover:border-zinc-700 active:cursor-grabbing"
                      >
                        <div className="flex items-center gap-2">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" className="shrink-0">{icon}</svg>
                          <p className="text-xs font-semibold text-zinc-200 truncate">{label}</p>
                        </div>
                      </div>
                    ))}
                    {filteredBuiltinExts.map((ext) => (
                      <div
                        key={ext.id}
                        draggable
                        onDragStart={(e) => { e.dataTransfer.setData(DRAG_KEY, ext.id); e.dataTransfer.effectAllowed = 'copy' }}
                        className="flex flex-col gap-2 px-3 py-3 rounded-lg border border-zinc-800 bg-zinc-900 transition-colors cursor-grab hover:bg-zinc-800/60 hover:border-zinc-700 active:cursor-grabbing"
                      >
                        <p className="text-xs font-semibold text-zinc-200 truncate">{ext.name}</p>
                        <div className="flex items-center gap-1 mt-auto">
                          <IoBadge type={ext.input} />
                          <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-zinc-600 shrink-0">
                            <path d="M5 12h14M13 6l6 6-6 6"/>
                          </svg>
                          <IoBadge type={ext.output} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ── Non-builtin extension groups ── */}
            {[...nonBuiltinMap.entries()].map(([extId, { extensionName, nodes }]) => {
              const filtered = nodes.filter((e) => !query || e.name.toLowerCase().includes(query))
              if (query && filtered.length === 0) return null
              const displayNodes = query ? filtered : nodes
              const expanded = isExpanded(extId, filtered.length > 0)

              return (
                <div key={extId}>
                  <ExtGroupHeader
                    title={extensionName}
                    author={displayNodes[0]?.extensionAuthor}
                    expanded={expanded}
                    onToggle={() => toggleGroup(extId)}
                    count={displayNodes.length}
                  />
                  {expanded && (
                    <div className={`grid ${gridClass} gap-2 mt-1.5 mb-3`}>
                      {displayNodes.map((ext) => (
                        <div
                          key={ext.id}
                          draggable
                          onDragStart={(e) => { e.dataTransfer.setData(DRAG_KEY, ext.id); e.dataTransfer.effectAllowed = 'copy' }}
                          className="flex flex-col gap-2 px-3 py-3 rounded-lg border border-zinc-800 bg-zinc-900 transition-colors cursor-grab hover:bg-zinc-800/60 hover:border-zinc-700 active:cursor-grabbing"
                        >
                          <p className="text-xs font-semibold text-zinc-200 truncate">{ext.name}</p>
                          {ext.description && cols === 1 && (
                            <p className="text-[10px] text-zinc-500 leading-relaxed line-clamp-2">{ext.description}</p>
                          )}
                          <div className="flex items-center gap-1 mt-auto">
                            <IoBadge type={ext.input} />
                            <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-zinc-600 shrink-0">
                              <path d="M5 12h14M13 6l6 6-6 6"/>
                            </svg>
                            <IoBadge type={ext.output} />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}

            {/* Empty state */}
            {query && baseCount === 0 && [...nonBuiltinMap.values()].every((g) => !g.nodes.some((e) => e.name.toLowerCase().includes(query))) && (
              <p className="text-[11px] text-zinc-600 text-center pt-4">No results for "{query}"</p>
            )}

          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Page ─── toggle button icon ─────────────────────────────────────────────

function PanelToggleIcon({ open }: { open: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      style={{ transition: 'transform 0.3s ease', transform: open ? 'rotate(0deg)' : 'rotate(180deg)' }}>
      <rect x="3" y="3" width="18" height="18" rx="2"/>
      <line x1="15" y1="3" x2="15" y2="21"/>
    </svg>
  )
}

// ─── Node palette (Space to open) ────────────────────────────────────────────

const BUILTIN_NODES = [
  { type: 'imageNode',   label: 'Image',         color: '#38bdf8', description: 'Image input' },
  { type: 'textNode',    label: 'Text',           color: '#fbbf24', description: 'Text input' },
  { type: 'meshNode',    label: 'Load 3D Mesh',   color: '#a78bfa', description: 'Load a 3D mesh file or use current model' },
  { type: 'outputNode',  label: 'Add to Scene',   color: '#a78bfa', description: 'Output node — adds the mesh to the 3D scene' },
  { type: 'previewNode', label: 'Preview Views',  color: '#38bdf8', description: 'Displays multi-view image outputs in a 2×3 grid' },
]

type PaletteItem =
  | { kind: 'node'; data: typeof BUILTIN_NODES[0] }
  | { kind: 'ext';  data: WorkflowExtension }

type PaletteGroup = {
  id:       string
  title:    string
  author?:  string
  expanded: boolean
  items:    Array<PaletteItem & { flatIdx: number }>
}

function NodePalette({
  allExtensions,
  onSelect,
  onClose,
}: {
  allExtensions: WorkflowExtension[]
  onSelect: (type: string, extensionId?: string) => void
  onClose: () => void
}) {
  const [query,       setQuery]       = useState('')
  const [collapsed,   setCollapsed]   = useState<Record<string, boolean>>({})
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const q = query.trim().toLowerCase()

  const nonBuiltinMap = useMemo(() => {
    const map = new Map<string, { extensionName: string; extensionAuthor: string; nodes: WorkflowExtension[] }>()
    for (const ext of allExtensions) {
      if (ext.builtin) continue
      if (!map.has(ext.extensionId)) map.set(ext.extensionId, { extensionName: ext.extensionName, extensionAuthor: ext.extensionAuthor, nodes: [] })
      map.get(ext.extensionId)!.nodes.push(ext)
    }
    return map
  }, [allExtensions])

  const toggleGroup = (id: string) => setCollapsed((c) => ({ ...c, [id]: !c[id] }))
  const isExpanded  = (id: string, hasMatches: boolean) => (!!q && hasMatches) || !collapsed[id]

  // Build groups with pre-assigned flat indices (drives keyboard nav)
  const { groups, totalItems } = useMemo(() => {
    const groups: PaletteGroup[] = []
    let flatIdx = 0

    // Base group
    const filteredBuiltinNodes = BUILTIN_NODES.filter((n) => !q || n.label.toLowerCase().includes(q) || n.description.toLowerCase().includes(q))
    const filteredBuiltinExts  = allExtensions.filter((e) => e.builtin && (!q || e.name.toLowerCase().includes(q) || (e.description ?? '').toLowerCase().includes(q)))
    const baseCount   = filteredBuiltinNodes.length + filteredBuiltinExts.length
    const baseVisible = !q || baseCount > 0
    const baseExp     = isExpanded('base', baseCount > 0)

    if (baseVisible) {
      const items: PaletteGroup['items'] = []
      if (baseExp) {
        filteredBuiltinNodes.forEach((n) => items.push({ kind: 'node', data: n, flatIdx: flatIdx++ }))
        filteredBuiltinExts.forEach((e)  => items.push({ kind: 'ext',  data: e, flatIdx: flatIdx++ }))
      }
      groups.push({ id: 'base', title: 'Base', expanded: baseExp, items })
    }

    // Non-builtin groups
    for (const [extId, { extensionName, extensionAuthor, nodes }] of nonBuiltinMap) {
      const filtered     = nodes.filter((e) => !q || e.name.toLowerCase().includes(q) || (e.description ?? '').toLowerCase().includes(q))
      if (q && filtered.length === 0) continue
      const displayNodes = q ? filtered : nodes
      const expanded     = isExpanded(extId, filtered.length > 0)
      const items: PaletteGroup['items'] = []
      if (expanded) displayNodes.forEach((e) => items.push({ kind: 'ext', data: e, flatIdx: flatIdx++ }))
      groups.push({ id: extId, title: extensionName, author: extensionAuthor || undefined, expanded, items })
    }

    return { groups, totalItems: flatIdx }
  }, [q, allExtensions, nonBuiltinMap, collapsed])

  useEffect(() => { setActiveIndex(0) }, [query])
  useEffect(() => { inputRef.current?.focus() }, [])

  // Flat list for Enter key (derived from groups)
  const flatItems = useMemo(() => groups.flatMap((g) => g.items), [groups])

  const handleKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex((i) => Math.min(i + 1, totalItems - 1)); return }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setActiveIndex((i) => Math.max(i - 1, 0)); return }
    if (e.key === 'Enter') {
      e.preventDefault()
      const item = flatItems[activeIndex]
      if (!item) return
      if (item.kind === 'node') onSelect(item.data.type)
      else onSelect('extensionNode', item.data.id)
    }
  }, [activeIndex, flatItems, totalItems, onSelect, onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/40 backdrop-blur-[2px]" onMouseDown={onClose}>
      <div
        className="w-full max-w-md bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-800">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-zinc-500 shrink-0">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Search nodes and extensions…"
            className="flex-1 bg-transparent text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none"
          />
          <kbd className="text-[10px] text-zinc-600 bg-zinc-800 px-1.5 py-0.5 rounded border border-zinc-700">Esc</kbd>
        </div>

        {/* Groups */}
        <div className="max-h-96 overflow-y-auto py-1.5">
          {groups.map((group) => (
            <div key={group.id}>

              {/* Group header */}
              <button
                onClick={() => toggleGroup(group.id)}
                className="flex items-center gap-2 w-full px-4 py-2 group hover:bg-zinc-800/30 transition-colors"
              >
                <svg
                  width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                  className="text-zinc-600 group-hover:text-zinc-400 transition-colors shrink-0"
                  style={{ transform: group.expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s ease' }}
                >
                  <polyline points="9 18 15 12 9 6"/>
                </svg>
                <div className="flex items-baseline gap-2 min-w-0">
                  <span className="text-[11px] font-semibold text-zinc-400 group-hover:text-zinc-200 transition-colors">{group.title}</span>
                  {group.author && <span className="text-[10px] text-zinc-600 truncate">{group.author}</span>}
                </div>
                <span className="ml-auto text-[10px] text-zinc-700 shrink-0">{group.items.length}</span>
              </button>

              {/* Group items */}
              {group.expanded && group.items.map((item) => {
                const isActive = activeIndex === item.flatIdx
                if (item.kind === 'node') {
                  const n = item.data
                  return (
                    <button
                      key={n.type}
                      onMouseEnter={() => setActiveIndex(item.flatIdx)}
                      onClick={() => onSelect(n.type)}
                      className={`w-full flex items-center gap-3 px-4 pl-9 py-2.5 transition-colors ${isActive ? 'bg-zinc-800' : 'hover:bg-zinc-800/50'}`}
                    >
                      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: n.color }} />
                      <span className="text-sm text-zinc-200">{n.label}</span>
                      <span className="text-xs text-zinc-600 ml-auto">{n.description}</span>
                    </button>
                  )
                }
                const e = item.data
                return (
                  <button
                    key={e.id}
                    onMouseEnter={() => setActiveIndex(item.flatIdx)}
                    onClick={() => onSelect('extensionNode', e.id)}
                    className={`w-full flex items-center gap-3 px-4 pl-9 py-2.5 transition-colors ${isActive ? 'bg-zinc-800' : 'hover:bg-zinc-800/50'}`}
                  >
                    <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-violet-400" />
                    <span className="text-sm text-zinc-200">{e.name}</span>
                    <div className="flex items-center gap-1 ml-auto shrink-0">
                      <span className="text-[10px] text-zinc-500">{e.input}</span>
                      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-zinc-700">
                        <path d="M5 12h14M13 6l6 6-6 6"/>
                      </svg>
                      <span className="text-[10px] text-zinc-500">{e.output}</span>
                    </div>
                  </button>
                )
              })}

            </div>
          ))}

          {totalItems === 0 && groups.length === 0 && (
            <p className="px-4 py-6 text-sm text-zinc-600 text-center">No results for "{query}"</p>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Help modal ───────────────────────────────────────────────────────────────

function HelpModal({ onClose }: { onClose: () => void }) {
  const [helperImg, setHelperImg] = useState<string | null>(null)
  useEffect(() => {
    window.electron.fs.readScreenshotDataUrl('workflow-helper.png').then(setHelperImg).catch(() => {})
  }, [])
  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="absolute inset-0 bg-zinc-950/70 backdrop-blur-sm" />
      <div className="relative w-[520px] max-h-[80vh] rounded-2xl bg-zinc-900 border border-zinc-700/60 shadow-2xl overflow-hidden flex flex-col">

        {/* Header */}
        <div className="sticky top-0 flex items-center justify-between px-5 py-4 border-b border-zinc-800 bg-zinc-900 z-10">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent-light">
                <circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
            </div>
            <h2 className="text-sm font-semibold text-zinc-100">How the workflow system works</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div className="px-5 py-5 flex flex-col gap-5 overflow-y-auto">

          {/* Concept */}
          <section className="flex flex-col gap-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Concept</h3>
            <p className="text-[12px] text-zinc-300 leading-relaxed">
              A workflow is a <span className="text-zinc-100 font-medium">directed graph of nodes</span>. Each node receives data from its inputs (left handle) and produces a result on its output (right handle). Data flows from left to right — you connect nodes by dragging from one handle to another.
            </p>
          </section>

          {/* Example screenshot */}
          {helperImg && (
            <div className="rounded-xl overflow-hidden border border-zinc-800">
              <img src={helperImg} alt="Basic workflow example" className="w-full object-cover" />
              <p className="px-3 py-2 text-[10px] text-zinc-500 bg-zinc-800/50 border-t border-zinc-800">
                Example — Image → AI model → Add to Scene
              </p>
            </div>
          )}

          {/* Node types */}
          <section className="flex flex-col gap-2.5">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Node types</h3>
            <div className="flex flex-col gap-2">

              <div className="flex items-start gap-3 p-3 rounded-xl bg-zinc-800/50 border border-zinc-700/40">
                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border border-sky-500/30 bg-sky-500/10 text-sky-400 shrink-0 mt-0.5">image</span>
                <div>
                  <p className="text-[11px] font-medium text-zinc-200">Image</p>
                  <p className="text-[11px] text-zinc-500 mt-0.5 leading-relaxed">Source node. Pick a local image file — it becomes the input of the first processing node.</p>
                </div>
              </div>

              <div className="flex items-start gap-3 p-3 rounded-xl bg-zinc-800/50 border border-zinc-700/40">
                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border border-amber-500/30 bg-amber-500/10 text-amber-400 shrink-0 mt-0.5">text</span>
                <div>
                  <p className="text-[11px] font-medium text-zinc-200">Text</p>
                  <p className="text-[11px] text-zinc-500 mt-0.5 leading-relaxed">Source node. Pass a text prompt to extensions that accept text input.</p>
                </div>
              </div>

              <div className="flex items-start gap-3 p-3 rounded-xl bg-zinc-800/50 border border-zinc-700/40">
                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border border-violet-500/30 bg-violet-500/10 text-violet-400 shrink-0 mt-0.5">mesh</span>
                <div>
                  <p className="text-[11px] font-medium text-zinc-200">Load 3D Mesh</p>
                  <p className="text-[11px] text-zinc-500 mt-0.5 leading-relaxed">Source node. Load a .glb, .obj, .stl or .ply file from disk, or use the model currently loaded in the 3D viewer.</p>
                </div>
              </div>

              <div className="flex items-start gap-3 p-3 rounded-xl bg-zinc-800/50 border border-zinc-700/40">
                <div className="flex gap-1 shrink-0 mt-0.5">
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border border-sky-500/30 bg-sky-500/10 text-sky-400">image</span>
                  <span className="text-zinc-600 text-[9px] flex items-center">→</span>
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border border-violet-500/30 bg-violet-500/10 text-violet-400">mesh</span>
                </div>
                <div>
                  <p className="text-[11px] font-medium text-zinc-200">Model extension <span className="text-[10px] font-normal text-zinc-500">(AI generator)</span></p>
                  <p className="text-[11px] text-zinc-500 mt-0.5 leading-relaxed">Runs a locally installed AI model to convert an image into a 3D mesh. Requires the model weights to be downloaded first from the <span className="text-zinc-300 font-medium">Extensions</span> page.</p>
                </div>
              </div>

              <div className="flex items-start gap-3 p-3 rounded-xl bg-zinc-800/50 border border-zinc-700/40">
                <div className="flex gap-1 shrink-0 mt-0.5">
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border border-violet-500/30 bg-violet-500/10 text-violet-400">mesh</span>
                  <span className="text-zinc-600 text-[9px] flex items-center">→</span>
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border border-violet-500/30 bg-violet-500/10 text-violet-400">mesh</span>
                </div>
                <div>
                  <p className="text-[11px] font-medium text-zinc-200">Process extension <span className="text-[10px] font-normal text-zinc-500">(mesh processor)</span></p>
                  <p className="text-[11px] text-zinc-500 mt-0.5 leading-relaxed">Transforms a mesh — examples: Optimize Mesh (polygon reduction), Export Mesh (save to file). No GPU required.</p>
                </div>
              </div>

              <div className="flex items-start gap-3 p-3 rounded-xl bg-zinc-800/50 border border-zinc-700/40">
                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border border-violet-500/30 bg-violet-500/10 text-violet-400 shrink-0 mt-0.5">scene</span>
                <div>
                  <p className="text-[11px] font-medium text-zinc-200">Add to Scene</p>
                  <p className="text-[11px] text-zinc-500 mt-0.5 leading-relaxed">Terminal node. Receives the final mesh and loads it directly into the 3D viewer when the workflow completes.</p>
                </div>
              </div>

            </div>
          </section>

          {/* Tips */}
          <section className="flex flex-col gap-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Tips</h3>
            <ul className="flex flex-col gap-1.5">
              {[
                ['Space', 'Open the node palette on the canvas'],
                ['Eye icon', 'Pin a node to the Generate page side panel'],
                ['Drag handle → canvas', 'Auto-opens the palette to connect a new node'],
                ['Right-click a link', 'Delete the connection between two nodes'],
                ['Run', 'Saves & executes the workflow, result goes to the 3D scene'],
              ].map(([key, desc]) => (
                <li key={key} className="flex items-start gap-2 text-[11px] text-zinc-400">
                  <span className="px-1.5 py-px rounded bg-zinc-800 border border-zinc-700 text-zinc-300 font-medium text-[10px] shrink-0 mt-px">{key}</span>
                  <span>{desc}</span>
                </li>
              ))}
            </ul>
          </section>

        </div>
      </div>
    </div>,
    document.body
  )
}

// ─── Connection type helpers ──────────────────────────────────────────────────

function getNodeOutputType(node: Node | undefined, allExts: WorkflowExtension[]): string | undefined {
  if (!node) return undefined
  if (node.type === 'imageNode') return 'image'
  if (node.type === 'meshNode')  return 'mesh'
  if (node.type === 'textNode')  return 'text'
  return allExts.find((e) => e.id === (node.data as WFNodeData)?.extensionId)?.output
}

function getNodeInputType(
  node: Node | undefined,
  targetHandle: string | null | undefined,
  allExts: WorkflowExtension[],
): string | undefined {
  if (!node) return undefined
  if (node.type === 'outputNode')  return 'mesh'
  if (node.type === 'previewNode') return 'image'
  const ext = allExts.find((e) => e.id === (node.data as WFNodeData)?.extensionId)
  if (ext?.inputs && ext.inputs.length > 1 && targetHandle) {
    const idx = parseInt(targetHandle.replace('input-', ''), 10)
    return ext.inputs[isNaN(idx) ? 0 : idx] ?? ext.input
  }
  return ext?.input
}

// ─── Workflow canvas (inner, requires ReactFlowProvider) ──────────────────────

function WorkflowCanvasInner({
  workflow, allExtensions, onSave, onDelete, onExport, panelOpen, onTogglePanel, onNew, onImport,
}: {
  workflow:         Workflow
  allExtensions:    WorkflowExtension[]
  onSave:           (w: Workflow) => void
  onDelete:         () => void
  onExport:         () => void
  panelOpen:        boolean
  onTogglePanel:    () => void
  onNew:            () => void
  onImport:         () => void
}) {
  const { screenToFlowPosition, updateNodeData, getNode } = useReactFlow()
  const { runState, run: runWorkflow, cancel } = useWorkflowRunStore()
  const currentMeshUrl = useAppStore((s) => s.currentJob?.outputUrl)
  const showToast = useAppStore((s) => s.showToast)
  const isRunning = runState.status === 'running'

  const [nodes, setNodes, onNodesChange] = useNodesState(workflow.nodes as Node[])
  const [edges, setEdges, onEdgesChange] = useEdgesState(workflow.edges as Edge[])
  const [name, setName]       = useState(workflow.name)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)

  // Pending connection: set when user drags a handle and releases on empty canvas
  const pendingConnectionRef  = useRef<OnConnectStartParams | null>(null)
  const connectionCompletedRef = useRef(false)
  const [pendingDropPos, setPendingDropPos] = useState<{ x: number; y: number } | null>(null)

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const preflightToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const didMountRef = useRef(false)

  // ─── Undo / Redo ──────────────────────────────────────────────────────────
  type Snapshot = { nodes: Node[]; edges: Edge[]; name: string }
  const historyRef  = useRef<Snapshot[]>([{ nodes: workflow.nodes as Node[], edges: workflow.edges as Edge[], name: workflow.name }])
  const histIdxRef  = useRef(0)
  const [histIdx, setHistIdx] = useState(0)
  const skipPushRef = useRef(true) // skip the initial autosave-triggered push

  // Re-sync when workflow switches
  useEffect(() => {
    setNodes(workflow.nodes as Node[])
    setEdges(workflow.edges as Edge[])
    setName(workflow.name)
    historyRef.current = [{ nodes: workflow.nodes as Node[], edges: workflow.edges as Edge[], name: workflow.name }]
    histIdxRef.current = 0
    setHistIdx(0)
    skipPushRef.current = true
  }, [workflow.id])

  // Auto-save + history push debounced
  useEffect(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      const updated: Workflow = {
        ...workflow,
        name,
        nodes: nodes as WFNode[],
        edges: edges as WFEdge[],
        updatedAt: new Date().toISOString(),
      }
      onSave(updated)

      if (!skipPushRef.current) {
        const next = historyRef.current.slice(0, histIdxRef.current + 1)
        next.push({ nodes, edges, name })
        if (next.length > 50) next.shift()
        historyRef.current = next
        const newIdx = next.length - 1
        histIdxRef.current = newIdx
        setHistIdx(newIdx)
      }
      skipPushRef.current = false
    }, 500)
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current) }
  }, [nodes, edges, name])

  const preflightIssues = useMemo(() => {
    const draft: Workflow = {
      ...workflow,
      name,
      nodes: nodes as WFNode[],
      edges: edges as WFEdge[],
      updatedAt: workflow.updatedAt,
    }
    return validateWorkflowPreflight(draft, allExtensions, { currentMeshUrl })
  }, [workflow, name, nodes, edges, allExtensions, currentMeshUrl])

  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true
      return
    }
    if (preflightToastTimer.current) clearTimeout(preflightToastTimer.current)
    if (preflightIssues.length === 0) return
    preflightToastTimer.current = setTimeout(() => {
      showToast(preflightIssues[0].message)
    }, 250)
    return () => {
      if (preflightToastTimer.current) clearTimeout(preflightToastTimer.current)
    }
  }, [preflightIssues, showToast])

  const undo = useCallback(() => {
    const idx = histIdxRef.current
    if (idx <= 0) return
    const newIdx = idx - 1
    const snap = historyRef.current[newIdx]
    skipPushRef.current = true
    setNodes(snap.nodes)
    setEdges(snap.edges)
    setName(snap.name)
    histIdxRef.current = newIdx
    setHistIdx(newIdx)
  }, [setNodes, setEdges])

  const redo = useCallback(() => {
    const idx = histIdxRef.current
    if (idx >= historyRef.current.length - 1) return
    const newIdx = idx + 1
    const snap = historyRef.current[newIdx]
    skipPushRef.current = true
    setNodes(snap.nodes)
    setEdges(snap.edges)
    setName(snap.name)
    histIdxRef.current = newIdx
    setHistIdx(newIdx)
  }, [setNodes, setEdges])

  const canUndo = histIdx > 0
  const canRedo = histIdx < historyRef.current.length - 1

  const isValidConnection = useCallback((connection: Connection) => {
    const srcType = getNodeOutputType(getNode(connection.source) as Node, allExtensions)
    const tgtType = getNodeInputType(getNode(connection.target) as Node, connection.targetHandle, allExtensions)
    if (!srcType || !tgtType) return true  // unknown type — allow
    return srcType === tgtType
  }, [getNode, allExtensions])

  const onConnectStart = useCallback((_: React.MouseEvent | React.TouchEvent, params: OnConnectStartParams) => {
    pendingConnectionRef.current  = params
    connectionCompletedRef.current = false
  }, [])

  const onConnect = useCallback((params: Connection) => {
    connectionCompletedRef.current = true
    setEdges((eds) => addEdge({ ...params, ...DEFAULT_EDGE_OPTS }, eds))
  }, [setEdges])

  const onConnectEnd = useCallback((event: MouseEvent | TouchEvent) => {
    if (connectionCompletedRef.current || !pendingConnectionRef.current?.nodeId) {
      pendingConnectionRef.current = null
      return
    }
    // Dropped on empty canvas (not on a handle or node body)
    const target = event.target as Element
    if (target.closest('.react-flow__node') || target.closest('.react-flow__handle')) {
      pendingConnectionRef.current = null
      return
    }
    const clientX = 'clientX' in event ? event.clientX : (event as TouchEvent).changedTouches[0].clientX
    const clientY = 'clientY' in event ? event.clientY : (event as TouchEvent).changedTouches[0].clientY
    setPendingDropPos({ x: clientX, y: clientY })
    setPaletteOpen(true)
  }, [])

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy'
  }, [])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const position = screenToFlowPosition({ x: e.clientX, y: e.clientY })

    const nodeType = e.dataTransfer.getData(DRAG_NODE_KEY)
    if (nodeType) {
      setNodes((nds) => [...nds, {
        id: newId(), type: nodeType, position,
        data: { enabled: true, params: {} } as WFNodeData,
      }])
      return
    }

    const extensionId = e.dataTransfer.getData(DRAG_KEY)
    if (!extensionId) return
    setNodes((nds) => [...nds, {
      id: newId(), type: 'extensionNode', position,
      data: { extensionId, enabled: true, params: {} } as WFNodeData,
    }])
  }, [screenToFlowPosition, setNodes])

  // Keyboard shortcuts (Space, Ctrl+Z, Ctrl+Y / Ctrl+Shift+Z)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.code === 'Space') {
        e.preventDefault()
        setPaletteOpen(true)
        return
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') {
        e.preventDefault()
        undo()
        return
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) {
        e.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [undo, redo])

  const addNodeFromPalette = useCallback((type: string, extensionId?: string) => {
    const position = screenToFlowPosition(
      pendingDropPos ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 }
    )
    const newNodeId = newId()
    setNodes((nds) => [...nds, {
      id: newNodeId, type, position,
      data: { extensionId, enabled: true, params: {} } as WFNodeData,
    }])

    // If palette was opened from a connection drag, wire the edge automatically
    const pending = pendingConnectionRef.current
    if (pending?.nodeId) {
      const isSource = pending.handleType === 'source'
      const edge = isSource
        ? { id: newId(), source: pending.nodeId, sourceHandle: pending.handleId ?? undefined, target: newNodeId }
        : { id: newId(), source: newNodeId, target: pending.nodeId, targetHandle: pending.handleId ?? undefined }
      setEdges((eds) => addEdge({ ...edge, ...DEFAULT_EDGE_OPTS }, eds))
    }

    pendingConnectionRef.current = null
    setPendingDropPos(null)
    setPaletteOpen(false)
  }, [screenToFlowPosition, setNodes, setEdges, pendingDropPos])

  const handleRun = useCallback(() => {
    if (isRunning) { cancel(); return }
    if (preflightIssues.length > 0) {
      showToast(preflightIssues[0].message)
      return
    }
    const wf: Workflow = { ...workflow, name, nodes: nodes as WFNode[], edges: edges as WFEdge[], updatedAt: new Date().toISOString() }
    onSave(wf)
    runWorkflow(wf, allExtensions)
  }, [workflow, name, nodes, edges, onSave, allExtensions, isRunning, runWorkflow, cancel, preflightIssues, showToast])

  return (
    <div className="flex flex-col flex-1 overflow-hidden">

      {paletteOpen && (
        <NodePalette
          allExtensions={allExtensions}
          onSelect={addNodeFromPalette}
          onClose={() => {
            pendingConnectionRef.current = null
            setPendingDropPos(null)
            setPaletteOpen(false)
          }}
        />
      )}

      {/* Header toolbar */}
      <div className="flex items-center gap-2 px-5 py-3 border-b border-zinc-800 shrink-0 bg-zinc-950/20">

        {/* New */}
        <button
          onClick={onNew}
          title="New workflow"
          className="flex items-center gap-2 px-3.5 py-2 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 transition-colors shrink-0"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          <span className="text-sm font-medium">New</span>
        </button>

        {/* Import */}
        <button
          onClick={onImport}
          title="Import workflow"
          className="flex items-center gap-2 px-3.5 py-2 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 transition-colors shrink-0"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          <span className="text-sm font-medium">Import</span>
        </button>

        <div className="w-px h-6 bg-zinc-800 mx-0.5 shrink-0" />

        {/* Undo */}
        <button
          onClick={undo}
          disabled={!canUndo}
          title="Undo (Ctrl+Z)"
          className="p-2.5 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-zinc-500 disabled:hover:border-zinc-800"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 7v6h6"/><path d="M3 13A9 9 0 1 0 5.7 6.3"/>
          </svg>
        </button>

        {/* Redo */}
        <button
          onClick={redo}
          disabled={!canRedo}
          title="Redo (Ctrl+Y)"
          className="p-2.5 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-zinc-500 disabled:hover:border-zinc-800"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 7v6h-6"/><path d="M21 13A9 9 0 1 1 18.3 6.3"/>
          </svg>
        </button>

        <div className="w-px h-6 bg-zinc-800 mx-0.5 shrink-0" />

        {/* Name input */}
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          placeholder="Workflow name…"
          className="flex-1 min-w-0 bg-zinc-800 border border-zinc-700/80 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-accent/60"
        />

        <div className="flex-1" />

        <div className="flex items-center gap-1">
          {/* Run / Stop */}
          <button
            onClick={handleRun}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg border transition-colors
              ${isRunning
                ? 'bg-red-500/10 border-red-500/30 text-red-400 hover:bg-red-500/20 hover:border-red-500/50'
                : 'bg-accent/10 border-accent/30 text-accent-light hover:bg-accent/20 hover:border-accent/50'}`}
          >
            {isRunning ? (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>
                <span className="text-sm font-semibold">Stop</span>
              </>
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                <span className="text-sm font-semibold">Run</span>
              </>
            )}
          </button>

          {/* Progress indicator */}
          {isRunning && (
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-zinc-800/60 border border-zinc-700/50 max-w-[180px]">
              <svg className="animate-spin text-accent shrink-0" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
              </svg>
              <span className="text-[11px] text-zinc-400 truncate">{runState.blockStep}</span>
            </div>
          )}

          {/* Export */}
          <button
            onClick={onExport}
            className="p-2.5 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 transition-colors"
            title="Export JSON"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
          </button>

          {/* Delete */}
          <button
            onClick={onDelete}
            className="p-2.5 rounded-lg text-zinc-600 hover:text-red-400 hover:bg-red-950/30 border border-zinc-800 hover:border-red-800/40 transition-colors"
            title="Delete workflow"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
            </svg>
          </button>

          {/* Help */}
          <button
            onClick={() => setHelpOpen(true)}
            title="How workflows work"
            className="p-2.5 rounded-lg text-zinc-600 hover:text-zinc-200 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 transition-colors font-semibold text-sm w-[34px] h-[34px] flex items-center justify-center"
          >
            ?
          </button>
        </div>
      </div>

      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}

      {/* React Flow canvas */}
      <div className="flex-1 relative" onDragOver={onDragOver} onDrop={onDrop}>

        {/* No model node warning */}
        {!nodes.some((n) => n.type === 'extensionNode' && allExtensions.find((e) => e.id === (n.data as WFNodeData).extensionId && e.type === 'model')) && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 pointer-events-none">
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-accent/10 border border-accent/20 text-accent-light whitespace-nowrap">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" className="shrink-0">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
              </svg>
              <span className="text-[10px] font-medium">No AI model node in this workflow — add one from the extensions panel to generate a 3D mesh.</span>
            </div>
          </div>
        )}

        {/* Floating panel toggle — over the canvas, below the header */}
        <button
          onClick={onTogglePanel}
          title={panelOpen ? 'Close extensions panel' : 'Open extensions panel'}
          className="absolute top-3 right-3 z-10 p-2 rounded-lg
                     bg-zinc-800/90 border border-zinc-700 shadow-md
                     text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700 hover:border-zinc-600
                     transition-colors backdrop-blur-sm"
        >
          <PanelToggleIcon open={panelOpen} />
        </button>

        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnectStart={onConnectStart}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          onConnectEnd={onConnectEnd}
          onEdgeContextMenu={(e, edge) => { e.preventDefault(); setEdges((eds) => eds.filter((ed) => ed.id !== edge.id)) }}
          defaultEdgeOptions={DEFAULT_EDGE_OPTS}
          deleteKeyCode="Delete"
          connectionLineStyle={{ stroke: '#71717a', strokeWidth: 1.5 }}
          fitView
          fitViewOptions={{ padding: 0.3 }}
          proOptions={{ hideAttribution: true }}
          className="bg-[#0f0f10]"
        >
          <Background color="#27272a" gap={24} size={1} />
        </ReactFlow>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function WorkflowsPage(): JSX.Element {
  const { workflows, loading, activeId, load, save, remove, importFile, exportFile, setActive } = useWorkflowsStore()
  const { modelExtensions, processExtensions, loadExtensions } = useExtensionsStore()

  const [panelOpen, setPanelOpen] = useState(true)

  const allExtensions = useMemo(
    () => buildAllWorkflowExtensions(modelExtensions, processExtensions),
    [modelExtensions, processExtensions],
  )

  useEffect(() => { load(); loadExtensions() }, [])

  // Auto-select first workflow when none is active or the active id no longer exists
  useEffect(() => {
    if (loading) return
    if (workflows.length === 0) return
    if (activeId && workflows.find((w) => w.id === activeId)) return
    setActive(workflows[0].id)
  }, [workflows, loading, activeId])

  const activeWorkflow = workflows.find((w) => w.id === activeId) ?? null

  async function handleCreateBlank() {
    const wf = newWorkflow()
    await save(wf)
    setActive(wf.id)
  }

  async function handleImport() {
    const result = await importFile()
    if (result.success && result.workflow) setActive((result.workflow as Workflow).id)
  }

  return (
    <div className="flex flex-col flex-1 overflow-hidden">

      {/* Tab bar */}
      {!loading && (
        <div className="flex items-stretch border-b border-zinc-800 bg-zinc-950/30 overflow-x-auto shrink-0 h-9">
          {workflows.map((wf) => (
            <div
              key={wf.id}
              onClick={() => setActive(wf.id)}
              onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); remove(wf.id) } }}
              className={`relative flex items-center gap-1.5 pl-3 pr-1.5 h-full text-[11px] font-medium shrink-0 transition-colors border-b-2 cursor-pointer group
                ${wf.id === activeId
                  ? 'text-zinc-100 border-accent bg-zinc-900/50'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/20 border-transparent'
                }`}
            >
              <span className="truncate max-w-[120px]">{wf.name || 'Untitled'}</span>
              <button
                onClick={(e) => { e.stopPropagation(); remove(wf.id) }}
                title="Close workflow"
                className="shrink-0 flex items-center justify-center w-4 h-4 rounded text-zinc-600 hover:text-zinc-300 hover:bg-zinc-700/60 transition-colors"
              >
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Canvas + extensions panel */}
      <div className="flex flex-1 overflow-hidden">

        {activeWorkflow ? (
          <ReactFlowProvider>
            <WorkflowCanvasInner
              key={activeWorkflow.id}
              workflow={activeWorkflow}
              allExtensions={allExtensions}
              onSave={save}
              onDelete={() => { remove(activeWorkflow.id) }}
              onExport={() => exportFile(activeWorkflow)}
              panelOpen={panelOpen}
              onTogglePanel={() => setPanelOpen((o) => !o)}
              onNew={handleCreateBlank}
              onImport={handleImport}
            />
          </ReactFlowProvider>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center text-zinc-600 gap-3">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
              <rect x="3" y="3" width="6" height="5" rx="1"/><rect x="3" y="11" width="6" height="5" rx="1"/>
              <path d="M9 5.5h3.5a1 1 0 0 1 1 1v5"/><rect x="13" y="9" width="8" height="7" rx="1"/>
            </svg>
            <div className="text-center">
              <p className="text-sm font-medium">No workflows yet</p>
              <p className="text-xs mt-1">Create one to get started</p>
            </div>
            <div className="flex items-center gap-2 mt-2">
              <button onClick={handleCreateBlank} className="px-4 py-2 rounded-lg bg-accent text-white text-xs font-semibold hover:bg-accent/90 transition-colors">
                New Workflow
              </button>
              <button onClick={handleImport} className="px-4 py-2 rounded-lg border border-zinc-700 text-zinc-300 text-xs font-semibold hover:bg-zinc-800 transition-colors">
                Import
              </button>
            </div>
          </div>
        )}

        {/* Extensions panel */}
        <ExtensionsPanel allExtensions={allExtensions} open={panelOpen} />
      </div>
    </div>
  )
}

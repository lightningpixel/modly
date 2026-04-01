import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
} from '@xyflow/react'
import { useWorkflowsStore } from '@shared/stores/workflowsStore'
import { useExtensionsStore } from '@shared/stores/extensionsStore'
import { useNavStore } from '@shared/stores/navStore'
import type { Workflow, WFNode, WFEdge, WFNodeData } from '@shared/types/electron.d'
import { buildAllWorkflowExtensions, getWorkflowExtension } from './mockExtensions'
import type { WorkflowExtension } from './mockExtensions'
import ExtensionNode from './nodes/ExtensionNode'
import ImageNode     from './nodes/ImageNode'
import TextNode      from './nodes/TextNode'
import AddToSceneNode from './nodes/AddToSceneNode'
import WorkflowEdge  from './nodes/WorkflowEdge'

// ─── Constants ────────────────────────────────────────────────────────────────

const DRAG_KEY      = 'modly/extension-id'
const DRAG_NODE_KEY = 'modly/node-type'
const NODE_TYPES = { extensionNode: ExtensionNode, imageNode: ImageNode, textNode: TextNode, outputNode: AddToSceneNode }
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
  const id  = newId()
  return {
    id,
    name:        'New Workflow',
    description: '',
    nodes: [],
    edges:     [],
    createdAt: now,
    updatedAt: now,
  }
}

// ─── Workflow card (sidebar) ──────────────────────────────────────────────────

function WorkflowCard({ workflow, active, onClick }: { workflow: Workflow; active: boolean; onClick: () => void }) {
  const extCount = workflow.nodes.filter((n) => n.type === 'extensionNode').length
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2.5 rounded-lg border transition-all ${
        active
          ? 'bg-accent/10 border-accent/30 text-zinc-100'
          : 'bg-zinc-900/40 border-zinc-800 text-zinc-300 hover:border-zinc-700 hover:bg-zinc-800/40'
      }`}
    >
      <p className="text-xs font-semibold truncate">{workflow.name || 'Untitled'}</p>
      <div className="flex items-center gap-2 mt-0.5">
        <span className="text-[10px] text-zinc-500">{extCount} node{extCount !== 1 ? 's' : ''}</span>
      </div>
    </button>
  )
}

// ─── Extensions panel ────────────────────────────────────────────────────────

const PANEL_MIN = 240
const PANEL_MAX = 860

const PANEL_BUILTIN_NODES = [
  { type: 'imageNode',  label: 'Image',        color: '#38bdf8', icon: <><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></> },
  { type: 'textNode',   label: 'Text',          color: '#fbbf24', icon: <><path d="M17 6.1H3M21 12.1H3M15.1 18H3"/></> },
  { type: 'outputNode', label: 'Add to Scene',  color: '#a78bfa', icon: <><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></> },
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
  { type: 'imageNode',  label: 'Image',        color: '#38bdf8', description: 'Image input' },
  { type: 'textNode',   label: 'Text',          color: '#fbbf24', description: 'Text input' },
  { type: 'outputNode', label: 'Add to Scene',  color: '#a78bfa', description: 'Output node' },
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

// ─── Workflow canvas (inner, requires ReactFlowProvider) ──────────────────────

function WorkflowCanvasInner({
  workflow, allExtensions, onSave, onDelete, onExport, panelOpen, onTogglePanel, onRunInGenerate,
}: {
  workflow:         Workflow
  allExtensions:    WorkflowExtension[]
  onSave:           (w: Workflow) => void
  onDelete:         () => void
  onExport:         () => void
  panelOpen:        boolean
  onTogglePanel:    () => void
  onRunInGenerate:  (wf: Workflow) => void
}) {
  const { screenToFlowPosition, updateNodeData } = useReactFlow()

  const [nodes, setNodes, onNodesChange] = useNodesState(workflow.nodes as Node[])
  const [edges, setEdges, onEdgesChange] = useEdgesState(workflow.edges as Edge[])
  const [name, setName]       = useState(workflow.name)
  const [editingName, setEditingName] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)


  // Re-sync when workflow switches
  useEffect(() => {
    setNodes(workflow.nodes as Node[])
    setEdges(workflow.edges as Edge[])
    setName(workflow.name)
  }, [workflow.id])

  // Auto-save debounced
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
    }, 500)
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current) }
  }, [nodes, edges, name])

  const onConnect = useCallback((params: Connection) => {
    setEdges((eds) => addEdge({ ...params, ...DEFAULT_EDGE_OPTS }, eds))
  }, [setEdges])

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

  // Space → open palette (ignore when typing in an input)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      e.preventDefault()
      setPaletteOpen(true)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const addNodeFromPalette = useCallback((type: string, extensionId?: string) => {
    const position = screenToFlowPosition({
      x: window.innerWidth  / 2,
      y: window.innerHeight / 2,
    })
    setNodes((nds) => [...nds, {
      id: newId(), type, position,
      data: { extensionId, enabled: true, params: {} } as WFNodeData,
    }])
    setPaletteOpen(false)
  }, [screenToFlowPosition, setNodes])

  const handleRun = useCallback(() => {
    const wf: Workflow = { ...workflow, name, nodes: nodes as WFNode[], edges: edges as WFEdge[], updatedAt: new Date().toISOString() }
    onSave(wf)
    onRunInGenerate(wf)
  }, [workflow, name, nodes, edges, onSave, onRunInGenerate])

  return (
    <div className="flex flex-col flex-1 overflow-hidden">

      {paletteOpen && (
        <NodePalette
          allExtensions={allExtensions}
          onSelect={addNodeFromPalette}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      {/* Header toolbar */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-zinc-800 shrink-0 bg-zinc-950/20">
        {editingName ? (
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => setEditingName(false)}
            onKeyDown={(e) => e.key === 'Enter' && setEditingName(false)}
            className="flex-1 bg-transparent border-b border-accent/60 text-sm font-semibold text-zinc-200 focus:outline-none pb-0.5"
          />
        ) : (
          <button onClick={() => setEditingName(true)} className="flex-1 text-left text-sm font-semibold text-zinc-200 hover:text-white truncate">
            {name || 'Untitled'}
          </button>
        )}

        <div className="flex items-center gap-1">
          {/* Run / Cancel */}
          <button
            onClick={handleRun}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border transition-colors
                       bg-accent/10 border-accent/30 text-accent-light hover:bg-accent/20 hover:border-accent/50"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            <span className="text-[11px] font-semibold">Run</span>
          </button>

          {/* Export */}
          <button
            onClick={onExport}
            className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 transition-colors"
            title="Export JSON"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
          </button>

          {/* Delete */}
          <button
            onClick={onDelete}
            className="p-1.5 rounded-lg text-zinc-600 hover:text-red-400 hover:bg-red-950/30 border border-zinc-800 hover:border-red-800/40 transition-colors"
            title="Delete workflow"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
            </svg>
          </button>
        </div>
      </div>

      {/* React Flow canvas */}
      <div className="flex-1 relative" onDragOver={onDragOver} onDrop={onDrop}>

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
          onConnect={onConnect}
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
  const { navigate } = useNavStore()
  const [panelOpen, setPanelOpen] = useState(true)

  const allExtensions = useMemo(
    () => buildAllWorkflowExtensions(modelExtensions, processExtensions),
    [modelExtensions, processExtensions],
  )

  useEffect(() => { load(); loadExtensions() }, [])

  const activeWorkflow = workflows.find((w) => w.id === activeId) ?? null

  async function handleCreate() {
    const wf = newWorkflow()
    await save(wf)
    setActive(wf.id)
  }

  async function handleImport() {
    const result = await importFile()
    if (result.success && result.workflow) setActive((result.workflow as Workflow).id)
  }


  return (
    <div className="flex flex-1 overflow-hidden">

      {/* Left sidebar */}
      <div className="flex flex-col w-52 shrink-0 border-r border-zinc-800 bg-zinc-950/30">
        <div className="flex items-center justify-between px-3 py-3 border-b border-zinc-800">
          <h1 className="text-xs font-semibold text-zinc-300">Workflows</h1>
          <div className="flex items-center gap-1">
            <button onClick={handleImport} title="Import" className="p-1.5 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
              </svg>
            </button>
            <button onClick={handleCreate} title="New workflow" className="p-1.5 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
          {loading ? (
            <p className="text-[11px] text-zinc-600 text-center mt-6">Loading…</p>
          ) : workflows.length === 0 ? (
            <div className="flex flex-col items-center justify-center mt-10 gap-2 text-zinc-600">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25">
                <rect x="3" y="3" width="6" height="5" rx="1"/><rect x="3" y="11" width="6" height="5" rx="1"/>
                <path d="M9 5.5h3.5a1 1 0 0 1 1 1v5"/><rect x="13" y="9" width="8" height="7" rx="1"/>
              </svg>
              <p className="text-xs text-center">No workflows yet.<br />Create one to get started.</p>
            </div>
          ) : workflows.map((wf) => (
            <WorkflowCard key={wf.id} workflow={wf} active={wf.id === activeId} onClick={() => setActive(wf.id)} />
          ))}
        </div>
      </div>

      {/* Center: canvas area */}
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
              onRunInGenerate={(wf) => { save(wf); setActive(wf.id); navigate('generate') }}
            />
          </ReactFlowProvider>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center text-zinc-600 gap-3">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
              <rect x="3" y="3" width="6" height="5" rx="1"/><rect x="3" y="11" width="6" height="5" rx="1"/>
              <path d="M9 5.5h3.5a1 1 0 0 1 1 1v5"/><rect x="13" y="9" width="8" height="7" rx="1"/>
            </svg>
            <div className="text-center">
              <p className="text-sm font-medium">Open a workflow</p>
              <p className="text-xs mt-1">or create a new one</p>
            </div>
            <button onClick={handleCreate} className="mt-2 px-4 py-2 rounded-lg bg-accent text-white text-xs font-semibold hover:bg-accent/90 transition-colors">
              New Workflow
            </button>
          </div>
        )}
      </div>

      {/* Right: Extensions panel */}
      <ExtensionsPanel allExtensions={allExtensions} open={panelOpen} />
    </div>
  )
}

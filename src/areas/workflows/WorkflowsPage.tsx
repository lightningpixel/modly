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
import { useWorkflowsStore, NODE_TYPES_WITHOUT_TARGET, NODE_TYPES_WITHOUT_SOURCE, FOLDER_COLORS } from '@shared/stores/workflowsStore'
import { useExtensionsStore } from '@shared/stores/extensionsStore'
import { useAppStore } from '@shared/stores/appStore'
import { useLlmModels } from '@shared/stores/llmModelsStore'
import type { Workflow, WFNode, WFEdge, WFNodeData } from '@shared/types/electron.d'
import { buildAllWorkflowExtensions } from './mockExtensions'
import type { WorkflowExtension } from './mockExtensions'
import { useWorkflowRunStore } from './workflowRunStore'
import { validateWorkflowPreflight, blockingIssues, getNodeOutputType as preflightOutputType } from './preflight'
import ExtensionNode    from './nodes/ExtensionNode'
import ImageNode        from './nodes/ImageNode'
import TextNode         from './nodes/TextNode'
import AddToSceneNode   from './nodes/AddToSceneNode'
import Load3DMeshNode   from './nodes/Load3DMeshNode'
import PreviewImageNode from './nodes/PreviewImageNode'
import WaitNode         from './nodes/WaitNode'
import WhileNode        from './nodes/WhileNode'
import ForEachNode      from './nodes/ForEachNode'
import WorkflowEdge     from './nodes/WorkflowEdge'

// ─── Constants ────────────────────────────────────────────────────────────────

const DRAG_KEY      = 'modly/extension-id'
const DRAG_NODE_KEY = 'modly/node-type'
const NODE_TYPES = { extensionNode: ExtensionNode, imageNode: ImageNode, textNode: TextNode, outputNode: AddToSceneNode, meshNode: Load3DMeshNode, previewNode: PreviewImageNode, waitNode: WaitNode, whileNode: WhileNode, forEachNode: ForEachNode }

// Loop-container node types: resizable frames whose children form a loop body.
// (For Each iterators are plain source nodes, not containers.)
const CONTAINER_TYPES = new Set(['whileNode'])
const isContainerType = (type: string | undefined): boolean => !!type && CONTAINER_TYPES.has(type)
const EDGE_TYPES = { workflowEdge: WorkflowEdge }

const DEFAULT_EDGE_OPTS = { type: 'workflowEdge' }

// The While container whose bounds contain a flow-space point, if any. Used to
// auto-parent nodes dropped (or created) inside a While so they join its loop body.
function findWhileContainerAt(nodes: Node[], pos: { x: number; y: number }): Node | undefined {
  return nodes.find((n) => {
    if (!isContainerType(n.type)) return false
    const gw = (n.measured?.width  ?? n.width  ?? (n.style?.width  as number)) || 0
    const gh = (n.measured?.height ?? n.height ?? (n.style?.height as number)) || 0
    return pos.x >= n.position.x && pos.x <= n.position.x + gw
        && pos.y >= n.position.y && pos.y <= n.position.y + gh
  })
}

// ─── IO badge ─────────────────────────────────────────────────────────────────

const IO_STYLES: Record<'image' | 'text' | 'mesh' | 'audio', string> = {
  audio: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/25',
  image: 'bg-sky-500/15 text-sky-400 border-sky-500/25',
  mesh:  'bg-violet-500/15 text-violet-400 border-violet-500/25',
  text:  'bg-amber-500/15 text-amber-400 border-amber-500/25',
}

function IoBadge({ type }: { type: 'image' | 'text' | 'mesh' | 'audio' }) {
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border ${IO_STYLES[type]}`}>
      {type}
    </span>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function newId(): string { return crypto.randomUUID() }

// Node clipboard (module-level so Ctrl+C in one workflow tab can be pasted in
// another — the canvas remounts per tab but the module survives).
const _nodeClipboard: { current: { nodes: Node[]; edges: Edge[]; pastes: number } | null } = { current: null }

function newWorkflow(): Workflow {
  const now = new Date().toISOString()
  return { id: newId(), name: 'New Workflow', description: '', nodes: [], edges: [], createdAt: now, updatedAt: now }
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
  { type: 'waitNode',    label: 'Wait',           color: '#71717a', icon: <><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></> },
  { type: 'whileNode',   label: 'While',          color: '#f59e0b', icon: <><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></> },
  { type: 'forEachNode', label: 'For Each', color: '#38bdf8', icon: <><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></> },
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
      setWidth(() => Math.min(PANEL_MAX, Math.max(PANEL_MIN, startW.current + delta)))
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
  { type: 'waitNode',    label: 'Wait',           color: '#71717a', description: 'Pauses the workflow until you click Continue' },
  { type: 'whileNode',   label: 'While',          color: '#f59e0b', description: 'Container: wrap nodes to loop them N times or with Continue/Retry' },
  { type: 'forEachNode', label: 'For Each', color: '#38bdf8', description: 'Iterates a folder (image / text / mesh) alphabetically, one item per run of the downstream nodes' },
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isExpanded only reads `collapsed`, already a dep
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-zinc-950/70 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <div
        className="w-[520px] max-h-[80vh] rounded-2xl bg-zinc-900 border border-zinc-700/60 shadow-2xl overflow-hidden flex flex-col"
        onMouseDown={(e) => e.stopPropagation()}
      >

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
                  <p className="text-[11px] text-zinc-500 mt-0.5 leading-relaxed">Source node. Load a .glb, .obj, .stl, .ply or .splat file from disk, or use the model currently loaded in the 3D viewer.</p>
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

/** Output type of a node, reusing preflight's single source of truth (which
 *  already covers forEachNode — this used to be a partial copy that returned
 *  undefined for it). */
function getNodeOutputType(node: Node | undefined, allExts: WorkflowExtension[]): string | undefined {
  if (!node) return undefined
  return preflightOutputType(node as unknown as WFNode, allExts)
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
  workflow, allExtensions, onSave, panelOpen, onTogglePanel, onOpen, onImport,
}: {
  workflow:         Workflow
  allExtensions:    WorkflowExtension[]
  onSave:           (w: Workflow) => void
  panelOpen:        boolean
  onTogglePanel:    () => void
  onOpen:           () => void
  onImport:         () => void
}) {
  const { screenToFlowPosition, getNode } = useReactFlow()
  const { runState, run: runWorkflow, cancel } = useWorkflowRunStore()
  const currentMeshUrl = useAppStore((s) => s.currentJob?.outputUrl)
  const selectedImagePath = useAppStore((s) => s.selectedImagePath)
  const selectedImageData = useAppStore((s) => s.selectedImageData)
  // Shared local-LLM library, so preflight can catch a model that isn't on disk
  // before the run dies on an HTTP 404 deep inside an extension.
  const { models: llmModels, vramGb } = useLlmModels()
  const showToast = useAppStore((s) => s.showToast)
  const isRunning = runState.status === 'running' || runState.status === 'paused'

  const [nodes, setNodes, onNodesChange] = useNodesState(workflow.nodes as Node[])
  const [edges, setEdges, onEdgesChange] = useEdgesState(workflow.edges as Edge[])
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)

  // Pending connection: set when user drags a handle and releases on empty canvas
  const pendingConnectionRef  = useRef<OnConnectStartParams | null>(null)
  const connectionCompletedRef = useRef(false)
  const [pendingDropPos, setPendingDropPos] = useState<{ x: number; y: number } | null>(null)

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const preflightToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastToastRef        = useRef<string | null>(null)
  const didMountRef = useRef(false)

  // ─── Undo / Redo ──────────────────────────────────────────────────────────
  type Snapshot = { nodes: Node[]; edges: Edge[] }
  const historyRef  = useRef<Snapshot[]>([{ nodes: workflow.nodes as Node[], edges: workflow.edges as Edge[] }])
  const histIdxRef  = useRef(0)
  const [histIdx, setHistIdx] = useState(0)
  const skipPushRef = useRef(true) // skip the initial autosave-triggered push

  // Distinguishes our own autosave echo from an external update (e.g. the
  // agent editing this workflow from the chat) coming back through the store.
  const lastSavedAtRef = useRef<string | null>(null)

  // Re-sync when the workflow switches — or when it was modified externally
  useEffect(() => {
    if (workflow.updatedAt === lastSavedAtRef.current) return
    setNodes(workflow.nodes as Node[])
    setEdges(workflow.edges as Edge[])
    historyRef.current = [{ nodes: workflow.nodes as Node[], edges: workflow.edges as Edge[] }]
    histIdxRef.current = 0
    setHistIdx(0)
    skipPushRef.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-sync on switch or external change; adding nodes/edges would reset the editor on every change
  }, [workflow.id, workflow.updatedAt])

  // Auto-save + history push debounced
  useEffect(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      const updated: Workflow = {
        ...workflow,
        nodes: nodes as WFNode[],
        edges: edges as WFEdge[],
        updatedAt: new Date().toISOString(),
      }
      lastSavedAtRef.current = updated.updatedAt
      onSave(updated)

      if (!skipPushRef.current) {
        const next = historyRef.current.slice(0, histIdxRef.current + 1)
        next.push({ nodes, edges })
        if (next.length > 50) next.shift()
        historyRef.current = next
        const newIdx = next.length - 1
        histIdxRef.current = newIdx
        setHistIdx(newIdx)
      }
      skipPushRef.current = false
    }, 500)
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- debounce on editable state; latest workflow/onSave read in the timeout
  }, [nodes, edges])

  const preflightIssues = useMemo(() => {
    const draft: Workflow = {
      ...workflow,
      nodes: nodes as WFNode[],
      edges: edges as WFEdge[],
      updatedAt: workflow.updatedAt,
    }
    return validateWorkflowPreflight(draft, allExtensions, {
      currentMeshUrl,
      hasFallbackImage: !!selectedImagePath || !!selectedImageData,
      llmModels, vramGb: vramGb ?? undefined,
    })
  }, [workflow, nodes, edges, allExtensions, currentMeshUrl, selectedImagePath, selectedImageData, llmModels, vramGb])

  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true
      return
    }
    if (preflightToastTimer.current) clearTimeout(preflightToastTimer.current)
    if (preflightIssues.length === 0) { lastToastRef.current = null; return }
    // What stops the run comes first: a warning is worth seeing, but never at
    // the expense of the thing the user has to fix.
    const first = blockingIssues(preflightIssues)[0] ?? preflightIssues[0]
    // The array is rebuilt on every edit, so an issue that simply persists — a
    // VRAM warning, a missing input the user has not got to yet — would toast
    // the same sentence again on every keystroke. Say it when it changes.
    if (first.message === lastToastRef.current) return
    preflightToastTimer.current = setTimeout(() => {
      lastToastRef.current = first.message
      showToast(first.message)
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
    histIdxRef.current = newIdx
    setHistIdx(newIdx)
  }, [setNodes, setEdges])

  const canUndo = histIdx > 0
  const canRedo = histIdx < historyRef.current.length - 1

  const isValidConnection = useCallback((connection: Edge | Connection) => {
    const srcType = getNodeOutputType(getNode(connection.source) as Node, allExtensions)
    const tgtType = getNodeInputType(getNode(connection.target) as Node, connection.targetHandle, allExtensions)
    if (srcType && tgtType && srcType !== tgtType) return false  // type mismatch (unknown types allowed)
    // Reject connections that would create a cycle: if the target can already
    // reach the source, adding source→target closes a loop.
    if (connection.source && connection.target) {
      const stack = [connection.target]
      const seen  = new Set<string>()
      while (stack.length > 0) {
        const id = stack.pop()!
        if (id === connection.source) return false
        if (seen.has(id)) continue
        seen.add(id)
        for (const e of edges) if (e.source === id) stack.push(e.target)
      }
    }
    return true
  }, [getNode, allExtensions, edges])

  const onConnectStart = useCallback((_: MouseEvent | TouchEvent, params: OnConnectStartParams) => {
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
    // Dropped on empty canvas — or inside a While body — opens the palette. The
    // While is a giant node, so don't treat its empty body as "dropped on a node";
    // bail only on a real node or a handle.
    const target = event.target as Element
    const nodeEl = target.closest('.react-flow__node')
    const onContainer = !!nodeEl && [...CONTAINER_TYPES].some((t) => nodeEl.classList.contains(`react-flow__node-${t}`))
    if (target.closest('.react-flow__handle') || (nodeEl && !onContainer)) {
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
      const isContainer = isContainerType(nodeType)
      setNodes((nds) => {
        const parent = isContainer ? undefined : findWhileContainerAt(nds, position)
        const node: Node = {
          id: newId(), type: nodeType,
          position: parent ? { x: position.x - parent.position.x, y: position.y - parent.position.y } : position,
          data: { enabled: true, params: {} } as WFNodeData,
          ...(isContainer ? { style: { width: 420, height: 240 }, width: 420, height: 240 } : {}),
          ...(parent ? { parentId: parent.id } : {}),
        }
        // Containers must sit before their future children in the array → prepend.
        return isContainer ? [node, ...nds] : [...nds, node]
      })
      return
    }

    const extensionId = e.dataTransfer.getData(DRAG_KEY)
    if (!extensionId) return
    setNodes((nds) => {
      const parent = findWhileContainerAt(nds, position)
      const node: Node = {
        id: newId(), type: 'extensionNode',
        position: parent ? { x: position.x - parent.position.x, y: position.y - parent.position.y } : position,
        data: { extensionId, enabled: true, params: {} } as WFNodeData,
        ...(parent ? { parentId: parent.id } : {}),
      }
      return [...nds, node]
    })
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

  // Copy/paste selected nodes (Ctrl+C / Ctrl+V) — works across workflow tabs
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey) return

      if (e.key === 'c') {
        const selected = nodes.filter((n) => n.selected)
        if (selected.length === 0) return
        const selIds = new Set(selected.map((n) => n.id))
        const copied = selected.map((n) => {
          // Child copied without its container → detach to absolute coordinates
          if (n.parentId && !selIds.has(n.parentId)) {
            const parent = nodes.find((p) => p.id === n.parentId)
            return {
              ...structuredClone(n),
              parentId: undefined,
              position: { x: n.position.x + (parent?.position.x ?? 0), y: n.position.y + (parent?.position.y ?? 0) },
            }
          }
          return structuredClone(n)
        })
        const copiedEdges = edges
          .filter((ed) => selIds.has(ed.source) && selIds.has(ed.target))
          .map((ed) => structuredClone(ed))
        _nodeClipboard.current = { nodes: copied, edges: copiedEdges, pastes: 0 }
        return
      }

      if (e.key === 'v') {
        const clip = _nodeClipboard.current
        if (!clip || clip.nodes.length === 0) return
        clip.pastes += 1
        const offset = 32 * clip.pastes
        const idMap = new Map(clip.nodes.map((n) => [n.id, newId()]))
        const pasted: Node[] = clip.nodes.map((n) => {
          const keepParent = n.parentId != null && idMap.has(n.parentId)
          return {
            ...structuredClone(n),
            id:       idMap.get(n.id)!,
            parentId: keepParent ? idMap.get(n.parentId!) : undefined,
            // Children keep their parent-relative position; top-level nodes shift
            // a bit more on every paste so repeated pastes don't stack.
            position: keepParent ? n.position : { x: n.position.x + offset, y: n.position.y + offset },
            selected: true,
          }
        })
        const pastedEdges: Edge[] = clip.edges.map((ed) => ({
          ...structuredClone(ed),
          id:     `e-${newId()}`,
          source: idMap.get(ed.source)!,
          target: idMap.get(ed.target)!,
        }))
        setNodes((nds) => [...nds.map((n) => ({ ...n, selected: false })), ...pasted])
        setEdges((eds) => [...eds, ...pastedEdges])
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [nodes, edges, setNodes, setEdges])

  const addNodeFromPalette = useCallback((type: string, extensionId?: string) => {
    const position = screenToFlowPosition(
      pendingDropPos ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 }
    )
    const newNodeId = newId()
    const isContainer = isContainerType(type)
    setNodes((nds) => {
      const parent = isContainer ? undefined : findWhileContainerAt(nds, position)
      const node: Node = {
        id: newNodeId, type,
        position: parent ? { x: position.x - parent.position.x, y: position.y - parent.position.y } : position,
        data: { extensionId, enabled: true, params: {} } as WFNodeData,
        ...(isContainer ? { style: { width: 420, height: 240 }, width: 420, height: 240 } : {}),
        ...(parent ? { parentId: parent.id } : {}),
      }
      // Containers must sit before their future children in the array → prepend.
      return isContainer ? [node, ...nds] : [...nds, node]
    })

    // If palette was opened from a connection drag, wire the edge automatically.
    // ExtensionNodes use id'd handles (input-0 / output), not the default null
    // handle, so the new node's side must reference them or React Flow can't place
    // the edge ("Couldn't create edge for target handle id: null").
    const pending = pendingConnectionRef.current
    if (pending?.nodeId) {
      const isSource = pending.handleType === 'source'
      const isExt = type === 'extensionNode'
      // Skip wiring when the new node can't take the connection: a source-only node
      // (Image/Text/Mesh) as target, or a sink-only node (Add to Scene/Preview) as
      // source — those have no matching handle and would orphan the edge.
      const canWire = isSource ? !NODE_TYPES_WITHOUT_TARGET.has(type) : !NODE_TYPES_WITHOUT_SOURCE.has(type)
      if (canWire) {
        const edge = isSource
          ? { id: newId(), source: pending.nodeId, sourceHandle: pending.handleId ?? undefined, target: newNodeId, targetHandle: isExt ? 'input-0' : undefined }
          : { id: newId(), source: newNodeId, sourceHandle: isExt ? 'output' : undefined, target: pending.nodeId, targetHandle: pending.handleId ?? undefined }
        setEdges((eds) => addEdge({ ...edge, ...DEFAULT_EDGE_OPTS }, eds))
      }
    }

    pendingConnectionRef.current = null
    setPendingDropPos(null)
    setPaletteOpen(false)
  }, [screenToFlowPosition, setNodes, setEdges, pendingDropPos])

  // When a While container is deleted (button or keyboard), detach its children
  // to absolute coordinates so they don't get orphaned to the canvas origin.
  const onNodesDelete = useCallback((deleted: Node[]) => {
    const removedContainers = deleted.filter((n) => isContainerType(n.type))
    if (removedContainers.length === 0) return
    setNodes((nds) => nds.map((n) => {
      const container = removedContainers.find((c) => c.id === n.parentId)
      if (!container) return n
      const { parentId: _p, extent: _ext, ...rest } = n
      return { ...rest, position: { x: container.position.x + n.position.x, y: container.position.y + n.position.y } }
    }))
  }, [setNodes])

  // When a node is dropped, attach/detach it to a While container based on overlap.
  // Children get a parentId + parent-relative position (no extent, so they can be dragged back out).
  const onNodeDragStop = useCallback((_e: unknown, dragged: Node) => {
    if (isContainerType(dragged.type)) return
    setNodes((nds) => {
      const containers = nds.filter((n) => isContainerType(n.type))
      if (containers.length === 0 && !dragged.parentId) return nds

      const parent = dragged.parentId ? nds.find((n) => n.id === dragged.parentId) : undefined
      const absX = (parent?.position.x ?? 0) + dragged.position.x
      const absY = (parent?.position.y ?? 0) + dragged.position.y
      const w = dragged.measured?.width  ?? dragged.width  ?? 200
      const h = dragged.measured?.height ?? dragged.height ?? 80
      const cx = absX + w / 2
      const cy = absY + h / 2

      const container = containers.find((g) => {
        const gw = (g.measured?.width  ?? g.width  ?? (g.style?.width  as number)) || 0
        const gh = (g.measured?.height ?? g.height ?? (g.style?.height as number)) || 0
        return cx >= g.position.x && cx <= g.position.x + gw && cy >= g.position.y && cy <= g.position.y + gh
      })

      const newParentId = container?.id
      if (newParentId === dragged.parentId) return nds   // no change

      const next: Node[] = nds.map((n) => {
        if (n.id !== dragged.id) return n
        if (container) {
          // parentId (no extent) → child moves with the container but can still be dragged out
          return { ...n, parentId: container.id,
                   position: { x: absX - container.position.x, y: absY - container.position.y } }
        }
        const { parentId: _p, extent: _ext, ...rest } = n   // detach
        return { ...rest, position: { x: absX, y: absY } }
      })

      // ReactFlow requires the parent to appear before its child in the array.
      if (newParentId) {
        const cIdx = next.findIndex((n) => n.id === dragged.id)
        const pIdx = next.findIndex((n) => n.id === newParentId)
        if (pIdx > cIdx) {
          const [child] = next.splice(cIdx, 1)
          next.splice(next.findIndex((n) => n.id === newParentId) + 1, 0, child)
        }
      }
      return next
    })
  }, [setNodes])

  const handleRun = useCallback(() => {
    if (isRunning) { cancel(); return }
    // Warnings are surfaced by the toast effect above and deliberately let the
    // run through — only a blocking issue stops it here.
    const blocking = blockingIssues(preflightIssues)
    if (blocking.length > 0) {
      showToast(blocking[0].message)
      return
    }
    const wf: Workflow = { ...workflow, nodes: nodes as WFNode[], edges: edges as WFEdge[], updatedAt: new Date().toISOString() }
    onSave(wf)
    runWorkflow(wf, allExtensions)
  }, [workflow, nodes, edges, onSave, allExtensions, isRunning, runWorkflow, cancel, preflightIssues, showToast])

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

        {/* Open */}
        <button
          onClick={onOpen}
          title="Open workflow"
          className="flex items-center gap-2 px-3.5 py-2 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 transition-colors shrink-0"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
          <span className="text-sm font-medium">Open</span>
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
          onNodeDragStop={onNodeDragStop}
          onNodesDelete={onNodesDelete}
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

// ─── Mini graph preview ───────────────────────────────────────────────────────
// Schematic thumbnail of a workflow's graph for the Open popup cards — plain
// SVG built from stored node positions, no React Flow instance needed.

// Node tint by role, echoing the real canvas: inputs green, processing violet,
// outputs blue, everything else neutral.
const MINI_NODE_TINTS: Record<string, { fill: string; stroke: string }> = {
  imageNode:     { fill: 'rgba(52,211,153,0.22)',  stroke: '#34d399' },
  textNode:      { fill: 'rgba(52,211,153,0.22)',  stroke: '#34d399' },
  meshNode:      { fill: 'rgba(52,211,153,0.22)',  stroke: '#34d399' },
  extensionNode: { fill: 'rgba(167,139,250,0.24)', stroke: '#a78bfa' },
  outputNode:    { fill: 'rgba(56,189,248,0.22)',  stroke: '#38bdf8' },
  previewNode:   { fill: 'rgba(56,189,248,0.22)',  stroke: '#38bdf8' },
}
const MINI_NODE_DEFAULT_TINT = { fill: 'rgba(113,113,122,0.25)', stroke: '#71717a' }

function WorkflowMiniPreview({ wf }: { wf: Workflow }): JSX.Element {
  const VIEW_W = 200
  const VIEW_H = 88
  const PAD = 12

  if (wf.nodes.length === 0) {
    return (
      <div className="flex items-center justify-center w-full h-full text-zinc-700">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="3" y="3" width="7" height="5" rx="1"/><rect x="14" y="16" width="7" height="5" rx="1"/>
          <path d="M10 5.5h5a2 2 0 0 1 2 2V16"/>
        </svg>
      </div>
    )
  }

  // Children of a container store positions relative to their parent
  const byId  = new Map(wf.nodes.map((n) => [n.id, n]))
  const boxes = wf.nodes.map((n) => {
    const parent = n.parentId ? byId.get(n.parentId) : undefined
    return {
      id:   n.id,
      type: n.type,
      x:    n.position.x + (parent?.position.x ?? 0),
      y:    n.position.y + (parent?.position.y ?? 0),
      w:    n.width ?? (n.style?.width  as number | undefined) ?? 150,
      h:    n.height ?? (n.style?.height as number | undefined) ?? 48,
    }
  })
  const boxById = new Map(boxes.map((b) => [b.id, b]))

  const minX  = Math.min(...boxes.map((b) => b.x))
  const minY  = Math.min(...boxes.map((b) => b.y))
  const maxX  = Math.max(...boxes.map((b) => b.x + b.w))
  const maxY  = Math.max(...boxes.map((b) => b.y + b.h))
  // Cap the scale so a near-empty graph doesn't blow one node up to card size
  const scale = Math.min(
    (VIEW_W - PAD * 2) / Math.max(maxX - minX, 1),
    (VIEW_H - PAD * 2) / Math.max(maxY - minY, 1),
    0.5,
  )
  const offX = (VIEW_W - (maxX - minX) * scale) / 2
  const offY = (VIEW_H - (maxY - minY) * scale) / 2
  const tx   = (x: number): number => offX + (x - minX) * scale
  const ty   = (y: number): number => offY + (y - minY) * scale

  // While containers render as dashed outlines behind the flow
  const containers = boxes.filter((b) => b.type === 'whileNode')
  const plain      = boxes.filter((b) => b.type !== 'whileNode')

  return (
    <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="w-full h-full" preserveAspectRatio="xMidYMid meet">
      <defs>
        <pattern id="wf-mini-grid" width="11" height="11" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.8" fill="#27272a" />
        </pattern>
      </defs>
      <rect width={VIEW_W} height={VIEW_H} fill="url(#wf-mini-grid)" />
      {containers.map((b) => (
        <rect
          key={b.id}
          x={tx(b.x)} y={ty(b.y)}
          width={Math.max(b.w * scale, 3)} height={Math.max(b.h * scale, 3)}
          rx="3" fill="rgba(113,113,122,0.06)" stroke="#52525b" strokeWidth="0.75" strokeDasharray="2.5 2"
        />
      ))}
      {wf.edges.map((e) => {
        const s = boxById.get(e.source)
        const t = boxById.get(e.target)
        if (!s || !t) return null
        const x1 = tx(s.x + s.w), y1 = ty(s.y + s.h / 2)
        const x2 = tx(t.x),       y2 = ty(t.y + t.h / 2)
        const d  = Math.max(Math.abs(x2 - x1) * 0.45, 6)
        return (
          <path
            key={e.id}
            d={`M ${x1} ${y1} C ${x1 + d} ${y1}, ${x2 - d} ${y2}, ${x2} ${y2}`}
            fill="none" stroke="#5b5b66" strokeWidth="1" strokeLinecap="round" opacity="0.9"
          />
        )
      })}
      {plain.map((b) => {
        const tint = MINI_NODE_TINTS[b.type] ?? MINI_NODE_DEFAULT_TINT
        return (
          <rect
            key={b.id}
            x={tx(b.x)} y={ty(b.y)}
            width={Math.max(b.w * scale, 3)} height={Math.max(b.h * scale, 3)}
            rx="2" fill={tint.fill} stroke={tint.stroke} strokeWidth="0.75"
          />
        )
      })}
    </svg>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function WorkflowsPage(): JSX.Element {
  const { workflows, loading, activeId, openIds, folders, folderColors, bookmarkedFolders, load, save, remove, importFile, exportFile, setActive, openWorkflow, closeWorkflow, moveOpenTab, addFolder, removeFolder, setFolderColor, toggleFolderBookmark } = useWorkflowsStore()
  const { modelExtensions, processExtensions, loadExtensions } = useExtensionsStore()

  const [panelOpen, setPanelOpen] = useState(true)
  const [tabMenu, setTabMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [renameTarget, setRenameTarget] = useState<{ id: string; value: string } | null>(null)
  const [openListVisible, setOpenListVisible] = useState(false)
  const [openSearch, setOpenSearch] = useState('')
  const [newFolderName, setNewFolderName] = useState<string | null>(null)   // null = input hidden
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set())
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null) // '' = root area
  const [dragOverTab, setDragOverTab] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)     // workflow id pending deletion
  const [colorPickerFolder, setColorPickerFolder] = useState<string | null>(null)

  // Folder color of a workflow, if it lives in a colored folder
  const workflowColor = (wf: Workflow): string | undefined =>
    wf.folder ? folderColors[wf.folder] : undefined

  // Tab of the workflow currently executing (dot indicator), if any
  const runningWorkflowId = useWorkflowRunStore((s) =>
    s.runState.status === 'running' || s.runState.status === 'paused' ? s.activeWorkflowId : null,
  )

  // Close the tab context menu on any outside click (it has no backdrop of its own)
  useEffect(() => {
    if (!tabMenu) return
    const close = (): void => setTabMenu(null)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [tabMenu])

  // Escape closes whichever popup is topmost, regardless of what's focused —
  // relying on a focused element's own onKeyDown would miss presses right after
  // a popup opens (before anything inside it has focus).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (deleteTarget)          { setDeleteTarget(null); return }
      if (renameTarget)          { setRenameTarget(null); return }
      if (newFolderName !== null) { setNewFolderName(null); return }
      if (tabMenu)               { setTabMenu(null); return }
      if (openListVisible)       { setOpenListVisible(false); return }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [deleteTarget, renameTarget, newFolderName, tabMenu, openListVisible])

  // Browser-style tab shortcuts: Ctrl+T new, Ctrl+W close, Ctrl(+Shift)+Tab cycle
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return
      if (e.key === 't' && !e.shiftKey) {
        e.preventDefault()
        handleCreateBlank()
      } else if (e.key === 'w' && !e.shiftKey) {
        e.preventDefault()
        if (activeId) handleCloseTab(activeId)
      } else if (e.key === 'Tab') {
        e.preventDefault()
        if (openIds.length < 2 || !activeId) return
        const idx  = openIds.indexOf(activeId)
        const next = e.shiftKey ? (idx - 1 + openIds.length) % openIds.length : (idx + 1) % openIds.length
        setActive(openIds[next])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- store setters are stable; handleCreateBlank only uses them
  }, [activeId, openIds])

  // Fresh search / closed color picker each time the Open popup opens
  useEffect(() => {
    if (!openListVisible) { setOpenSearch(''); setColorPickerFolder(null) }
  }, [openListVisible])

  const allExtensions = useMemo(
    () => buildAllWorkflowExtensions(modelExtensions, processExtensions),
    [modelExtensions, processExtensions],
  )

  // eslint-disable-next-line react-hooks/exhaustive-deps -- load once on mount
  useEffect(() => { load(); loadExtensions() }, [])

  // Auto-select the first open tab when none is active or the active id is gone
  useEffect(() => {
    if (loading) return
    if (openIds.length === 0) return
    if (activeId && openIds.includes(activeId) && workflows.find((w) => w.id === activeId)) return
    setActive(openIds[0])
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setActive is a stable store setter
  }, [workflows, loading, activeId, openIds])

  const openWorkflows  = openIds.map((id) => workflows.find((w) => w.id === id)).filter((w): w is Workflow => !!w)
  const activeWorkflow = workflows.find((w) => w.id === activeId) ?? null

  async function handleCreateBlank() {
    const wf = newWorkflow()
    await save(wf)
    openWorkflow(wf.id)
  }

  async function handleImport() {
    const result = await importFile()
    if (result.success && result.workflow) openWorkflow((result.workflow as Workflow).id)
  }

  async function handleRename() {
    if (!renameTarget) return
    const wf = workflows.find((w) => w.id === renameTarget.id)
    const trimmed = renameTarget.value.trim()
    if (wf && trimmed && trimmed !== wf.name) {
      await save({ ...wf, name: trimmed, updatedAt: new Date().toISOString() })
    }
    setRenameTarget(null)
  }

  function renderWorkflowCard(wf: Workflow): JSX.Element {
    const isOpen = openIds.includes(wf.id)
    const cardActionCls = 'flex items-center justify-center w-5 h-5 rounded-md bg-zinc-900/70 backdrop-blur-sm text-zinc-500 opacity-0 group-hover:opacity-100 transition-all hover:scale-110'
    return (
      <div
        key={wf.id}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('modly/workflow-id', wf.id)
          e.dataTransfer.effectAllowed = 'move'
        }}
        onClick={() => { openWorkflow(wf.id); setOpenListVisible(false) }}
        className={`group relative flex flex-col rounded-lg overflow-hidden border cursor-pointer transition-colors
          ${isOpen ? 'border-violet-500/50 bg-violet-500/10' : 'border-zinc-800 bg-zinc-950/40 hover:border-zinc-700 hover:bg-zinc-800/40'}`}
      >
        <div className="relative h-[72px] border-b border-zinc-800/60 bg-zinc-950/50">
          {workflowColor(wf) && (
            <div
              className="absolute inset-0 pointer-events-none"
              style={{ background: `radial-gradient(ellipse 90% 110% at 50% 45%, ${workflowColor(wf)}30, ${workflowColor(wf)}08 60%, transparent 80%)` }}
            />
          )}
          <WorkflowMiniPreview wf={wf} />
          <div className="absolute top-1 right-1 flex items-center gap-0.5">
            <button
              onClick={(e) => { e.stopPropagation(); handleToggleBookmark(wf.id) }}
              title={wf.bookmarked ? 'Remove bookmark' : 'Bookmark'}
              className={`flex items-center justify-center w-5 h-5 rounded-md bg-zinc-900/70 backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-all hover:scale-110
                ${wf.bookmarked ? 'text-amber-400 drop-shadow-[0_0_5px_rgba(251,191,36,0.55)]' : 'text-zinc-500 hover:text-amber-300'}`}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill={wf.bookmarked ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
              </svg>
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); handleDuplicate(wf.id) }}
              title="Duplicate"
              className={`${cardActionCls} hover:text-zinc-200 hover:bg-zinc-700/80`}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
              </svg>
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setRenameTarget({ id: wf.id, value: wf.name }) }}
              title="Rename"
              className={`${cardActionCls} hover:text-zinc-200 hover:bg-zinc-700/80`}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
              </svg>
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setDeleteTarget(wf.id) }}
              title="Delete"
              className={`${cardActionCls} hover:text-red-400 hover:bg-red-950/60`}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
              </svg>
            </button>
          </div>
        </div>
        <div className="px-2.5 py-1.5">
          <p className="text-xs font-medium text-zinc-200 truncate">{wf.name || 'Untitled'}</p>
          <p className="text-[10px] text-zinc-600 truncate">{new Date(wf.updatedAt).toLocaleString()}</p>
        </div>
      </div>
    )
  }

  function renderFolder(folder: string): JSX.Element {
    const inFolder  = workflows.filter((w) => w.folder === folder).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    const collapsed = collapsedFolders.has(folder)
    return (
      <div key={folder}>
        <div
          onClick={() => setCollapsedFolders((s) => {
            const next = new Set(s)
            if (next.has(folder)) next.delete(folder); else next.add(folder)
            return next
          })}
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragOverFolder(folder) }}
          onDragLeave={() => setDragOverFolder(null)}
          onDrop={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setDragOverFolder(null)
            const id = e.dataTransfer.getData('modly/workflow-id')
            if (id) handleMoveToFolder(id, folder)
          }}
          className={`group flex items-center gap-2 px-4 py-2 cursor-pointer text-zinc-400 hover:text-zinc-200 transition-colors
            ${dragOverFolder === folder ? 'bg-accent/10 text-accent-light' : ''}`}
        >
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
            className={`shrink-0 transition-transform ${collapsed ? '' : 'rotate-90'}`}>
            <polyline points="9 18 15 12 9 6"/>
          </svg>
          <svg width="12" height="12" viewBox="0 0 24 24" fill={folderColors[folder] ? `${folderColors[folder]}33` : 'none'} stroke={folderColors[folder] ?? 'currentColor'} strokeWidth="2" className="shrink-0">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
          <span className="text-xs font-medium truncate">{folder}</span>
          <span className="text-[10px] text-zinc-600">{inFolder.length}</span>
          <div className="flex-1" />
          <button
            onClick={(e) => { e.stopPropagation(); toggleFolderBookmark(folder) }}
            title={bookmarkedFolders.includes(folder) ? 'Remove bookmark' : 'Bookmark folder'}
            className={`shrink-0 flex items-center justify-center w-5 h-5 rounded-md opacity-0 group-hover:opacity-100 transition-all hover:scale-110 hover:bg-zinc-800
              ${bookmarkedFolders.includes(folder) ? 'text-amber-400 drop-shadow-[0_0_5px_rgba(251,191,36,0.55)]' : 'text-zinc-600 hover:text-amber-300'}`}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill={bookmarkedFolders.includes(folder) ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
            </svg>
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); setColorPickerFolder((cur) => (cur === folder ? null : folder)) }}
            title="Folder color"
            className="shrink-0 flex items-center justify-center w-5 h-5 rounded opacity-0 group-hover:opacity-100 hover:bg-zinc-800 transition-all"
          >
            <span className="w-2.5 h-2.5 rounded-full border border-zinc-600" style={{ background: folderColors[folder] ?? 'transparent' }} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); handleDeleteFolder(folder) }}
            title="Delete folder (workflows move to root)"
            className="shrink-0 flex items-center justify-center w-5 h-5 rounded text-zinc-700 opacity-0 group-hover:opacity-100 hover:text-red-400 hover:bg-red-950/30 transition-all"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
            </svg>
          </button>
        </div>
        {colorPickerFolder === folder && (
          <div className="flex items-center gap-1.5 pl-11 pr-4 py-1.5">
            {FOLDER_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => { setFolderColor(folder, c); setColorPickerFolder(null) }}
                className={`w-4 h-4 rounded-full transition-transform hover:scale-125 ${folderColors[folder] === c ? 'ring-2 ring-zinc-400 ring-offset-1 ring-offset-zinc-900' : ''}`}
                style={{ background: c }}
              />
            ))}
          </div>
        )}
        {!collapsed && inFolder.length > 0 && (
          <div className="grid grid-cols-3 gap-2 pl-8 pr-4 py-1.5">
            {inFolder.map((wf) => renderWorkflowCard(wf))}
          </div>
        )}
        {!collapsed && inFolder.length === 0 && (
          <p className="pl-11 pr-5 py-1.5 text-[10px] text-zinc-700 italic">Empty — drag workflows here</p>
        )}
      </div>
    )
  }

  // Closing the tab of an empty workflow (no nodes) deletes it too — a blank
  // "New Workflow" the user closes is throwaway, don't let them pile up on disk.
  // Reads the store directly so a keyboard shortcut never acts on a stale list.
  function handleCloseTab(id: string) {
    const wf = useWorkflowsStore.getState().workflows.find((w) => w.id === id)
    if (wf && wf.nodes.length === 0) { remove(id); return }
    closeWorkflow(id)
  }

  async function handleToggleBookmark(id: string) {
    const wf = workflows.find((w) => w.id === id)
    if (!wf) return
    // Not an edit — keep updatedAt so the recency sort doesn't reshuffle
    await save({ ...wf, bookmarked: !wf.bookmarked })
  }

  async function handleMoveToFolder(id: string, folder?: string) {
    const wf = workflows.find((w) => w.id === id)
    if (!wf || (wf.folder ?? undefined) === folder) return
    await save({ ...wf, folder })
  }

  async function handleDeleteFolder(name: string) {
    for (const wf of workflows.filter((w) => w.folder === name)) {
      await save({ ...wf, folder: undefined })
    }
    removeFolder(name)
  }

  function handleCreateFolder() {
    const trimmed = (newFolderName ?? '').trim()
    if (trimmed) addFolder(trimmed)
    setNewFolderName(null)
  }

  async function handleDuplicate(id: string) {
    const src = workflows.find((w) => w.id === id)
    if (!src) return
    const now = new Date().toISOString()
    const copy: Workflow = {
      ...structuredClone(src),
      id:         newId(),
      name:       `${src.name || 'Untitled'} copy`,
      bookmarked: undefined,   // a copy isn't the favorite
      createdAt:  now,
      updatedAt:  now,
    }
    await save(copy)
    openWorkflow(copy.id)
  }

  return (
    <div className="flex flex-col flex-1 overflow-hidden">

      {/* Tab bar */}
      {!loading && (
        <div className="flex items-stretch border-b border-zinc-800 bg-zinc-950/30 overflow-x-auto shrink-0 h-9">
          {openWorkflows.map((wf) => (
            <div
              key={wf.id}
              draggable
              onDragStart={(e) => { e.dataTransfer.setData('modly/tab-id', wf.id); e.dataTransfer.effectAllowed = 'move' }}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes('modly/tab-id')) return
                e.preventDefault()
                setDragOverTab(wf.id)
              }}
              onDragLeave={() => setDragOverTab((cur) => (cur === wf.id ? null : cur))}
              onDrop={(e) => {
                e.preventDefault()
                setDragOverTab(null)
                const dragId = e.dataTransfer.getData('modly/tab-id')
                if (dragId) moveOpenTab(dragId, wf.id)
              }}
              onClick={() => setActive(wf.id)}
              onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); handleCloseTab(wf.id) } }}
              onContextMenu={(e) => { e.preventDefault(); setTabMenu({ id: wf.id, x: e.clientX, y: e.clientY }) }}
              className={`relative flex items-center gap-1.5 pl-3 pr-1.5 h-full text-[11px] font-medium shrink-0 transition-colors border-b-2 cursor-pointer group
                ${wf.id === activeId
                  ? 'text-zinc-100 border-accent bg-zinc-900/50'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/20 border-transparent'
                }`}
            >
              {dragOverTab === wf.id && <span className="absolute left-0 top-1 bottom-1 w-0.5 bg-accent rounded" />}
              {/* Folder color dot; doubles as the running indicator (pulses) */}
              {(workflowColor(wf) || runningWorkflowId === wf.id) && (
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${runningWorkflowId === wf.id ? 'animate-pulse' : ''} ${workflowColor(wf) ? '' : 'bg-accent'}`}
                  title={runningWorkflowId === wf.id ? 'Running' : undefined}
                  style={workflowColor(wf) ? { background: workflowColor(wf), boxShadow: `0 0 4px ${workflowColor(wf)}80` } : undefined}
                />
              )}
              <span className="truncate max-w-[120px]">{wf.name || 'Untitled'}</span>
              <button
                onClick={(e) => { e.stopPropagation(); handleCloseTab(wf.id) }}
                title="Close tab"
                className="shrink-0 flex items-center justify-center w-5 h-5 rounded text-zinc-600 hover:text-zinc-300 hover:bg-zinc-700/60 transition-colors"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
          ))}
          <button
            onClick={handleCreateBlank}
            title="New workflow"
            className="shrink-0 flex items-center justify-center w-9 h-full text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/40 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
          </button>
        </div>
      )}

      {/* Tab context menu */}
      {tabMenu && (
        <div
          style={{ left: tabMenu.x, top: tabMenu.y }}
          className="fixed z-50 min-w-[140px] py-1 rounded-lg bg-zinc-900 border border-zinc-700 shadow-xl"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => {
              const wf = workflows.find((w) => w.id === tabMenu.id)
              if (wf) setRenameTarget({ id: wf.id, value: wf.name })
              setTabMenu(null)
            }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 transition-colors"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
              <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
            </svg>
            Rename
          </button>
          <button
            onClick={() => { handleDuplicate(tabMenu.id); setTabMenu(null) }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 transition-colors"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
              <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
            Duplicate
          </button>
          <button
            onClick={() => {
              const wf = workflows.find((w) => w.id === tabMenu.id)
              if (wf) exportFile(wf)
              setTabMenu(null)
            }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 transition-colors"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Export JSON
          </button>
          <div className="my-1 h-px bg-zinc-800" />
          <button
            onClick={() => { setDeleteTarget(tabMenu.id); setTabMenu(null) }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-zinc-400 hover:bg-red-950/40 hover:text-red-400 transition-colors"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
            </svg>
            Delete
          </button>
        </div>
      )}

      {/* Rename popup (above the Open popup, which can trigger it) */}
      {renameTarget && createPortal(
        <div
          className="fixed inset-0 z-[10000] flex items-center justify-center bg-zinc-950/70 backdrop-blur-sm"
          onMouseDown={() => setRenameTarget(null)}
        >
          <div
            className="w-[320px] rounded-2xl bg-zinc-900 border border-zinc-700/60 shadow-2xl p-5"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <p className="text-sm font-semibold text-zinc-200 mb-3">Rename workflow</p>
            <input
              autoFocus
              value={renameTarget.value}
              onChange={(e) => setRenameTarget({ ...renameTarget, value: e.target.value })}
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => { if (e.key === 'Enter') handleRename() }}
              placeholder="Workflow name…"
              className="w-full bg-zinc-800 border border-zinc-700/80 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-accent/60"
            />
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setRenameTarget(null)}
                className="px-3 py-1.5 rounded-md border border-zinc-700 text-zinc-400 text-xs font-medium hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleRename}
                disabled={!renameTarget.value.trim()}
                className="px-3 py-1.5 rounded-md bg-accent text-white text-xs font-semibold hover:bg-accent/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Rename
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* Delete confirmation popup (topmost — reachable from the Open popup) */}
      {deleteTarget && createPortal(
        <div
          className="fixed inset-0 z-[10001] flex items-center justify-center bg-zinc-950/70 backdrop-blur-sm"
          onMouseDown={() => setDeleteTarget(null)}
        >
          <div
            className="w-[320px] rounded-2xl bg-zinc-900 border border-zinc-700/60 shadow-2xl p-5"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <p className="text-sm font-semibold text-zinc-200">Delete workflow?</p>
            <p className="text-xs text-zinc-500 mt-2">
              &ldquo;{workflows.find((w) => w.id === deleteTarget)?.name || 'Untitled'}&rdquo; will be permanently deleted. This cannot be undone.
            </p>
            <div className="flex justify-end gap-2 mt-5">
              <button
                onClick={() => setDeleteTarget(null)}
                className="px-3 py-1.5 rounded-md border border-zinc-700 text-zinc-400 text-xs font-medium hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => { remove(deleteTarget); setDeleteTarget(null) }}
                className="px-3 py-1.5 rounded-md bg-red-600 text-white text-xs font-semibold hover:bg-red-500 transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* Open workflow popup */}
      {openListVisible && createPortal(
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-zinc-950/70 backdrop-blur-sm"
          onMouseDown={() => setOpenListVisible(false)}
        >
          <div
            className="w-[640px] max-w-[92vw] max-h-[70vh] rounded-2xl bg-zinc-900 border border-zinc-700/60 shadow-2xl flex flex-col overflow-hidden"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
              <p className="text-sm font-semibold text-zinc-200">Open workflow</p>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setNewFolderName('')}
                  title="New folder"
                  className="flex items-center justify-center w-6 h-6 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                    <line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>
                  </svg>
                </button>
                <button
                  onClick={() => setOpenListVisible(false)}
                  className="flex items-center justify-center w-6 h-6 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
              </div>
            </div>

            {/* Search */}
            <div className="px-4 py-2 border-b border-zinc-800">
              <div className="flex items-center gap-2 bg-zinc-800 border border-zinc-700/80 rounded-md px-2.5 py-1.5 focus-within:border-accent/60">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-zinc-500">
                  <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
                </svg>
                <input
                  autoFocus
                  value={openSearch}
                  onChange={(e) => setOpenSearch(e.target.value)}
                  placeholder="Search workflows…"
                  className="flex-1 min-w-0 bg-transparent text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none"
                />
                {openSearch && (
                  <button onClick={() => setOpenSearch('')} className="shrink-0 text-zinc-600 hover:text-zinc-300 transition-colors">
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                  </button>
                )}
              </div>
            </div>

            {/* New folder inline input */}
            {newFolderName !== null && (
              <div className="flex items-center gap-2 px-4 py-2 border-b border-zinc-800 bg-zinc-950/40">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-zinc-500">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
                <input
                  autoFocus
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleCreateFolder() }}
                  onBlur={() => setNewFolderName(null)}
                  placeholder="Folder name… (Enter to create)"
                  className="flex-1 min-w-0 bg-zinc-800 border border-zinc-700/80 rounded-md px-2.5 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-accent/60"
                />
              </div>
            )}

            <div
              className="flex-1 overflow-y-auto py-1"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                // Drop on the list background (not a folder) → move back to root
                e.preventDefault()
                setDragOverFolder(null)
                const id = e.dataTransfer.getData('modly/workflow-id')
                if (id) handleMoveToFolder(id, undefined)
              }}
            >
              {workflows.length === 0 && folders.length === 0 && (
                <p className="px-5 py-6 text-center text-xs text-zinc-600 italic">No saved workflows.</p>
              )}

              {/* Search results — flat list across all folders */}
              {openSearch.trim() !== '' && (() => {
                const q = openSearch.trim().toLowerCase()
                const matches = workflows
                  .filter((w) => (w.name || 'Untitled').toLowerCase().includes(q))
                  .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                if (matches.length === 0) {
                  return <p className="px-5 py-6 text-center text-xs text-zinc-600 italic">No workflow matches &ldquo;{openSearch.trim()}&rdquo;.</p>
                }
                return (
                  <div className="grid grid-cols-3 gap-2 px-4 py-2">
                    {matches.map((wf) => renderWorkflowCard(wf))}
                  </div>
                )
              })()}

              {/* Bookmarks — pinned section: starred folders, then starred workflows */}
              {openSearch.trim() === '' && (() => {
                const markedFolders = [...bookmarkedFolders].filter((f) => folders.includes(f)).sort((a, b) => a.localeCompare(b))
                // Starred workflows already shown inside a starred folder aren't repeated
                const marked = workflows
                  .filter((w) => w.bookmarked && !(w.folder && bookmarkedFolders.includes(w.folder)))
                  .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                if (marked.length === 0 && markedFolders.length === 0) return null
                return (
                  <div className="border-b border-zinc-800/60 pb-1 mb-1">
                    <div className="flex items-center gap-2 px-4 py-2 text-amber-400/80">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" className="shrink-0">
                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                      </svg>
                      <span className="text-xs font-medium">Bookmarks</span>
                    </div>
                    {markedFolders.map((folder) => renderFolder(folder))}
                    {marked.length > 0 && (
                      <div className="grid grid-cols-3 gap-2 px-4 py-1.5">
                        {marked.map((wf) => renderWorkflowCard(wf))}
                      </div>
                    )}
                  </div>
                )
              })()}

              {/* Folders (bookmarked ones live in the section above) */}
              {openSearch.trim() === '' && [...folders]
                .filter((f) => !bookmarkedFolders.includes(f))
                .sort((a, b) => a.localeCompare(b))
                .map((folder) => renderFolder(folder))}

              {/* Root workflows */}
              {openSearch.trim() === '' && (() => {
                const root = workflows
                  .filter((w) => !w.folder || !folders.includes(w.folder))
                  .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                if (root.length === 0) return null
                return (
                  <div className="grid grid-cols-3 gap-2 px-4 py-2">
                    {root.map((wf) => renderWorkflowCard(wf))}
                  </div>
                )
              })()}
            </div>
          </div>
        </div>,
        document.body,
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
              panelOpen={panelOpen}
              onTogglePanel={() => setPanelOpen((o) => !o)}
              onOpen={() => setOpenListVisible(true)}
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
              <p className="text-sm font-medium">{workflows.length === 0 ? 'No workflows yet' : 'No workflow open'}</p>
              <p className="text-xs mt-1">{workflows.length === 0 ? 'Create one to get started' : 'Open a saved workflow or create a new one'}</p>
            </div>
            <div className="flex items-center gap-2 mt-2">
              {workflows.length > 0 && (
                <button onClick={() => setOpenListVisible(true)} className="px-4 py-2 rounded-lg bg-accent text-white text-xs font-semibold hover:bg-accent/90 transition-colors">
                  Open
                </button>
              )}
              <button onClick={handleCreateBlank} className={`px-4 py-2 rounded-lg text-xs font-semibold transition-colors ${workflows.length === 0 ? 'bg-accent text-white hover:bg-accent/90' : 'border border-zinc-700 text-zinc-300 hover:bg-zinc-800'}`}>
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

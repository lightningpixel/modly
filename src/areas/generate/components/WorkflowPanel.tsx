import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlowProvider,
  useNodesState, useEdgesState, useReactFlow,
  type Node as FlowNode, type Edge as FlowEdge,
} from '@xyflow/react'
// ReactFlowProvider wraps EmbeddedCanvas so useReactFlow() works in param rows
import { useWorkflowsStore }   from '@shared/stores/workflowsStore'
import { useAppStore }         from '@shared/stores/appStore'
import { useExtensionsStore }  from '@shared/stores/extensionsStore'
import { useNavStore }         from '@shared/stores/navStore'
import { useWorkflowRunStore } from '@areas/workflows/workflowRunStore'
import { buildAllWorkflowExtensions, getWorkflowExtension } from '@areas/workflows/mockExtensions'
import { validateWorkflowPreflight } from '@areas/workflows/preflight'
import type { WorkflowExtension } from '@areas/workflows/mockExtensions'
import type { Workflow, WFNode, WFEdge, ParamSchema } from '@shared/types/electron.d'

// ─── Constants ────────────────────────────────────────────────────────────────

const TYPE_COLOR: Record<string, string> = {
  image: '#38bdf8',
  mesh:  '#a78bfa',
  text:  '#fbbf24',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function topoSortNodes(nodes: Workflow['nodes'], edges: Workflow['edges']): WFNode[] {
  const nodeMap  = new Map(nodes.map((n) => [n.id, n]))
  const inDegree = new Map(nodes.map((n) => [n.id, 0]))
  const adj      = new Map(nodes.map((n) => [n.id, [] as string[]]))
  for (const e of edges) {
    if (!nodeMap.has(e.source) || !nodeMap.has(e.target)) continue
    adj.get(e.source)!.push(e.target)
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1)
  }
  const queue  = nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0)
  const result: WFNode[] = []
  while (queue.length > 0) {
    const node = queue.shift()!
    result.push(node)
    for (const neighbor of adj.get(node.id) ?? []) {
      const deg = (inDegree.get(neighbor) ?? 0) - 1
      inDegree.set(neighbor, deg)
      if (deg === 0) queue.push(nodeMap.get(neighbor)!)
    }
  }
  return result
}

function mimeFromPath(p: string): string {
  const ext = p.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  return 'image/png'
}

// ─── Param field ──────────────────────────────────────────────────────────────

const inputCls = 'w-full bg-zinc-800 border border-zinc-700/80 rounded-md px-2 py-1 text-[11px] text-zinc-200 focus:outline-none focus:border-accent/60'

function IntInput({ value, onChange, className }: { value: number; onChange: (v: number) => void; className: string }) {
  const [text, setText] = useState(String(value))
  const prevValue = useRef(value)
  if (prevValue.current !== value && parseInt(text, 10) !== value) {
    prevValue.current = value
    setText(String(value))
  }
  return (
    <input
      type="text"
      inputMode="numeric"
      value={text}
      onChange={(e) => {
        const raw = e.target.value
        if (raw !== '' && raw !== '-' && !/^-?\d+$/.test(raw)) return
        setText(raw)
        const n = parseInt(raw, 10)
        if (!isNaN(n)) { prevValue.current = n; onChange(n) }
      }}
      className={className}
    />
  )
}

function FloatInput({ value, onChange, className }: { value: number; onChange: (v: number) => void; className: string }) {
  const [text, setText] = useState(String(value))
  const prevValue = useRef(value)
  if (prevValue.current !== value && parseFloat(text.replace(',', '.')) !== value) {
    prevValue.current = value
    setText(String(value))
  }
  return (
    <input
      type="text"
      inputMode="decimal"
      value={text}
      onChange={(e) => {
        const raw = e.target.value.replace(',', '.')
        if (raw !== '' && raw !== '-' && raw !== '.' && !/^-?\d*\.?\d*$/.test(raw)) return
        setText(e.target.value)
        const num = parseFloat(raw)
        if (!isNaN(num)) { prevValue.current = num; onChange(num) }
      }}
      className={className}
    />
  )
}

function ParamField({ param, value, onChange }: {
  param:    ParamSchema
  value:    number | string
  onChange: (v: number | string) => void
}) {
  if (param.type === 'select') {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)} className={inputCls}>
        {param.options?.map((o) => (
          <option key={String(o.value)} value={o.value}>{o.label ?? String(o.value)}</option>
        ))}
      </select>
    )
  }
  if (param.type === 'string') {
    return (
      <div className="flex items-center gap-1">
        <input type="text" value={value as string} placeholder={param.tooltip ?? ''}
          onChange={(e) => onChange(e.target.value)} className={`${inputCls} flex-1`} />
        <button onClick={async () => {
          const p = await window.electron.fs.selectDirectory()
          if (p) onChange(p)
        }} className="shrink-0 flex items-center justify-center w-6 h-6 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-400 hover:text-zinc-200 transition-colors">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
          </svg>
        </button>
      </div>
    )
  }
  if (param.type === 'float') {
    return <FloatInput value={value as number} onChange={(v) => onChange(v)} className={inputCls} />
  }
  // int
  return <IntInput value={value as number} onChange={(v) => onChange(v)} className={inputCls} />
}

// ─── Workflow dropdown ────────────────────────────────────────────────────────

function WorkflowDropdown({ workflows, value, onChange }: {
  workflows: Workflow[]
  value:     string | null
  onChange:  (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const selected        = workflows.find((w) => w.id === value)

  if (workflows.length === 0) {
    return (
      <div className="px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-600 text-xs">
        No workflows yet
      </div>
    )
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`w-full flex items-center justify-between px-3 py-2 rounded-lg bg-zinc-900 border text-left transition-colors ${open ? 'border-zinc-600' : 'border-zinc-800 hover:border-zinc-700'}`}
      >
        <span className="text-xs font-medium text-zinc-200 truncate">
          {selected?.name ?? 'Select a workflow…'}
        </span>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          className={`shrink-0 ml-2 text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      {open && (
        <div className="absolute top-full mt-1 left-0 right-0 z-50 rounded-lg bg-zinc-900 border border-zinc-700 shadow-xl overflow-hidden">
          {workflows.map((wf, i) => (
            <button key={wf.id} onClick={() => { onChange(wf.id); setOpen(false) }}
              className={`w-full flex items-center gap-2 px-3 py-2 text-left text-xs transition-colors
                ${i > 0 ? 'border-t border-zinc-800' : ''}
                ${wf.id === value ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-800/60'}`}>
              <span className="flex-1 truncate">{wf.name}</span>
              <span className="text-[9px] text-zinc-600 shrink-0">
                {wf.nodes.filter((n) => n.type === 'extensionNode').length} nodes
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Node param rows ──────────────────────────────────────────────────────────
// These components receive nodes + onPatch directly from EmbeddedCanvas
// to avoid relying on the React Flow store (which requires a mounted <ReactFlow>).

type PatchFn = (nodeId: string, patch: Record<string, unknown>) => void

function ImageParamRow({ nodeId, nodes, onPatch }: { nodeId: string; nodes: FlowNode[]; onPatch: PatchFn }) {
  const node     = nodes.find((n) => n.id === nodeId)
  const data     = node?.data as { params: Record<string, unknown> } | undefined
  const preview  = data?.params.preview as string | undefined

  const browse = useCallback(async () => {
    const p = await window.electron.fs.selectImage()
    if (!p) return
    const base64 = await window.electron.fs.readFileBase64(p)
    const src = `data:${mimeFromPath(p)};base64,${base64}`
    onPatch(nodeId, { params: { ...(data?.params ?? {}), filePath: p, preview: src } })
  }, [nodeId, data?.params, onPatch])

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/>
          <polyline points="21 15 16 10 5 21"/>
        </svg>
        <span className="text-[11px] font-medium text-zinc-300">Image</span>
      </div>
      {preview ? (
        <button onClick={browse} className="relative w-full aspect-square rounded-lg overflow-hidden border border-zinc-700 group">
          <img src={preview} alt="" className="w-full h-full object-cover" />
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/50 transition-colors flex items-center justify-center">
            <span className="text-[10px] text-white font-medium opacity-0 group-hover:opacity-100 transition-opacity">Change…</span>
          </div>
        </button>
      ) : (
        <button onClick={browse}
          className="w-full aspect-square flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-zinc-700 hover:border-sky-500/50 hover:bg-sky-500/5 transition-colors">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-zinc-600">
            <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/>
            <polyline points="21 15 16 10 5 21"/>
          </svg>
          <span className="text-[10px] text-zinc-500">Browse image…</span>
        </button>
      )}
    </div>
  )
}

function MeshParamRow({ nodeId, nodes, onPatch }: { nodeId: string; nodes: FlowNode[]; onPatch: PatchFn }) {
  const node     = nodes.find((n) => n.id === nodeId)
  const data     = node?.data as { params: Record<string, unknown> } | undefined
  const source   = (data?.params.source as 'file' | 'current' | undefined) ?? 'file'
  const fileName = data?.params.fileName as string | undefined

  const browse = useCallback(async () => {
    const p = await window.electron.fs.selectMeshFile()
    if (!p) return
    const name = p.split(/[\\/]/).pop() ?? p
    onPatch(nodeId, { params: { ...(data?.params ?? {}), filePath: p, fileName: name, source: 'file' } })
  }, [nodeId, data?.params, onPatch])

  const toggleSource = useCallback(() => {
    const next = source === 'file' ? 'current' : 'file'
    onPatch(nodeId, { params: { ...(data?.params ?? {}), source: next } })
  }, [nodeId, data?.params, source, onPatch])

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="2">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
        </svg>
        <span className="text-[11px] font-medium text-zinc-300">Load 3D Mesh</span>
      </div>

      {/* Toggle: use current model */}
      <button onClick={toggleSource} className="flex items-center gap-2 w-full text-left">
        <div className={`w-7 h-4 rounded-full relative shrink-0 transition-colors ${source === 'current' ? 'bg-violet-500' : 'bg-zinc-700'}`}>
          <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${source === 'current' ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
        </div>
        <span className="text-[10px] text-zinc-400">Use current model</span>
      </button>

      {source === 'file' ? (
        fileName ? (
          <button onClick={browse}
            className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 transition-colors group">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="2" className="shrink-0">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
            </svg>
            <span className="text-[10px] text-zinc-300 truncate flex-1 text-left">{fileName}</span>
            <span className="text-[9px] text-zinc-500 group-hover:text-zinc-400 shrink-0">Change…</span>
          </button>
        ) : (
          <button onClick={browse}
            className="w-full flex items-center justify-center gap-2 py-5 rounded-lg border border-dashed border-zinc-700 hover:border-violet-500/50 hover:bg-violet-500/5 transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-zinc-600">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
            </svg>
            <span className="text-[10px] text-zinc-500">Browse mesh…</span>
          </button>
        )
      ) : (
        <div className="px-2.5 py-2 rounded-lg bg-zinc-800/50 border border-zinc-700/40">
          <span className="text-[10px] text-zinc-500">Uses the model currently loaded in the 3D viewer</span>
        </div>
      )}
    </div>
  )
}

function TextParamRow({ nodeId, nodes, onPatch }: { nodeId: string; nodes: FlowNode[]; onPatch: PatchFn }) {
  const node = nodes.find((n) => n.id === nodeId)
  const data = node?.data as { params: Record<string, unknown> } | undefined
  const text = (data?.params.text as string | undefined) ?? ''

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="2">
          <path d="M17 6.1H3M21 12.1H3M15.1 18H3"/>
        </svg>
        <span className="text-[11px] font-medium text-zinc-300">Text</span>
      </div>
      <textarea
        value={text}
        onChange={(e) => onPatch(nodeId, { params: { ...(data?.params ?? {}), text: e.target.value } })}
        placeholder="Enter text…" rows={3}
        className="w-full bg-zinc-800 border border-zinc-700/80 rounded-md px-2.5 py-2 text-[11px] text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-amber-500/40 resize-none leading-relaxed"
      />
    </div>
  )
}

function ExtensionParamRow({ nodeId, ext, nodes, onPatch }: { nodeId: string; ext: WorkflowExtension; nodes: FlowNode[]; onPatch: PatchFn }) {
  const [expanded, setExpanded] = useState(true)
  const node    = nodes.find((n) => n.id === nodeId)
  const data    = node?.data as { enabled: boolean; params: Record<string, unknown> } | undefined
  const enabled = data?.enabled ?? true

  const inputColor  = TYPE_COLOR[ext.input]  ?? '#71717a'
  const outputColor = TYPE_COLOR[ext.output] ?? '#71717a'

  return (
    <div className={`flex flex-col transition-opacity ${enabled ? '' : 'opacity-40'}`}>
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-[11px] font-medium text-zinc-200 truncate">{ext.name}</p>
          <div className="flex items-center gap-1 mt-0.5">
            <span className="text-[9px]" style={{ color: inputColor }}>{ext.input}</span>
            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-zinc-600">
              <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
            </svg>
            <span className="text-[9px]" style={{ color: outputColor }}>{ext.output}</span>
          </div>
        </div>

        {/* Toggle enabled */}
        <button onClick={() => onPatch(nodeId, { enabled: !enabled })}
          className="relative shrink-0" style={{ width: 26, height: 15 }}>
          <span className={`absolute inset-0 rounded-full transition-colors ${enabled ? 'bg-accent/70' : 'bg-zinc-700'}`} />
          <span className={`absolute top-[1.5px] w-3 h-3 rounded-full bg-white shadow transition-all ${enabled ? 'left-[11px]' : 'left-[1.5px]'}`} />
        </button>

        {ext.params.length > 0 && (
          <button onClick={() => setExpanded((v) => !v)}
            className="p-0.5 rounded text-zinc-600 hover:text-zinc-400 transition-colors">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
              className={`transition-transform ${expanded ? 'rotate-180' : ''}`}>
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>
        )}
      </div>

      {expanded && ext.params.length > 0 && (
        <div className="mt-2 flex flex-col gap-2">
          {ext.params.map((param) => {
            const val = ((data?.params[param.id] ?? param.default) as number | string)
            return (
              <div key={param.id} className="flex items-center gap-2">
                <label className="text-[10px] text-zinc-500 w-20 shrink-0 truncate">{param.label}</label>
                <div className="flex-1">
                  <ParamField param={param} value={val}
                    onChange={(v) => onPatch(nodeId, { params: { ...(data?.params ?? {}), [param.id]: v } })} />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Embedded canvas ──────────────────────────────────────────────────────────

function EmbeddedCanvas({ workflow, allExtensions }: {
  workflow:      Workflow
  allExtensions: ReturnType<typeof buildAllWorkflowExtensions>
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState(workflow.nodes as FlowNode[])
  const [edges, setEdges, onEdgesChange] = useEdgesState(workflow.edges as FlowEdge[])
  const { updateNodeData }               = useReactFlow()
  const { navigate }                     = useNavStore()

  // Direct patch into controlled nodes state — no React Flow store dependency
  const patchNode = useCallback<PatchFn>((nodeId, patch) => {
    setNodes((nds) => nds.map((n) =>
      n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n,
    ))
  }, [setNodes])

  const currentMeshUrl = useAppStore((s) => s.currentJob?.outputUrl)
  const showToast = useAppStore((s) => s.showToast)
  const { runState, run, cancel } = useWorkflowRunStore()
  const isRunning = runState.status === 'running'

  // Update AddToScene node when run completes
  useEffect(() => {
    if (runState.status !== 'done' || !runState.outputUrl) return
    const out = nodes.find((n) => n.type === 'outputNode')
    if (out) updateNodeData(out.id, { params: { outputUrl: runState.outputUrl } })
  }, [runState.status, runState.outputUrl])

  const preflightIssues = useMemo(() => {
    const wf: Workflow = { ...workflow, nodes: nodes as WFNode[], edges: edges as WFEdge[] }
    return validateWorkflowPreflight(wf, allExtensions, { currentMeshUrl })
  }, [workflow, nodes, edges, allExtensions, currentMeshUrl])

  const firstPreflightIssue = preflightIssues[0]?.message ?? null

  // Ordered nodes for params list — only those marked showInGenerate
  const sortedNodes = useMemo(
    () => topoSortNodes(nodes as WFNode[], edges as WFEdge[]),
    [nodes, edges],
  )

  const paramNodes = sortedNodes.filter((n) =>
    (n.type === 'imageNode' || n.type === 'textNode' || n.type === 'meshNode' || n.type === 'extensionNode')
    && (n.data as { showInGenerate?: boolean }).showInGenerate === true,
  )

  const handleGenerate = useCallback(() => {
    if (firstPreflightIssue) {
      showToast(firstPreflightIssue)
      return
    }
    const wf: Workflow = { ...workflow, nodes: nodes as WFNode[], edges: edges as WFEdge[] }
    run(wf, allExtensions)
  }, [firstPreflightIssue, nodes, edges, workflow, allExtensions, run, showToast])

  return (
    <div className="flex flex-col flex-1 min-h-0">

      {/* Params list */}
      <div className="flex-1 overflow-y-auto min-h-0 px-4 py-3 flex flex-col gap-4">
        {paramNodes.map((node, i) => {
          const isLast = i === paramNodes.length - 1
          return (
            <div key={node.id}>
              {node.type === 'imageNode' && <ImageParamRow nodeId={node.id} nodes={nodes} onPatch={patchNode} />}
              {node.type === 'textNode'  && <TextParamRow  nodeId={node.id} nodes={nodes} onPatch={patchNode} />}
              {node.type === 'meshNode'  && <MeshParamRow  nodeId={node.id} nodes={nodes} onPatch={patchNode} />}
              {node.type === 'extensionNode' && (() => {
                const ext = getWorkflowExtension(node.data.extensionId ?? '', allExtensions)
                return ext ? <ExtensionParamRow nodeId={node.id} ext={ext} nodes={nodes} onPatch={patchNode} /> : null
              })()}
              {!isLast && <div className="mt-4 border-t border-zinc-800/60" />}
            </div>
          )
        })}

        {paramNodes.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-8 px-2">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-zinc-700">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
            </svg>
            <p className="text-[11px] text-zinc-600 text-center leading-relaxed">
              No nodes pinned to Generate.<br/>
              Click the <span className="text-zinc-400">eye icon</span> on a node in the workflow editor.
            </p>
            <button onClick={() => navigate('workflows')}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-700 hover:border-zinc-500 text-zinc-400 hover:text-zinc-200 text-[10px] font-medium transition-colors">
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
              Open workflow editor
            </button>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="shrink-0 px-4 pt-3 pb-4 border-t border-zinc-800 flex flex-col gap-2">
        {firstPreflightIssue && !isRunning && (
          <div className="flex items-center gap-2 px-2.5 py-2 rounded-lg bg-amber-950/40 border border-amber-800/50">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-amber-300 shrink-0">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            <span className="text-[10px] text-amber-300 font-medium">{firstPreflightIssue}</span>
          </div>
        )}
        {isRunning ? (
          <button onClick={() => cancel()}
            className="w-full py-2.5 rounded-lg text-sm font-semibold bg-red-600 hover:bg-red-700 text-white transition-colors">
            Stop
          </button>
        ) : (
          <button onClick={handleGenerate} disabled={Boolean(firstPreflightIssue)}
            className="w-full py-2.5 rounded-lg text-sm font-semibold bg-accent hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors">
            Generate 3D Model
          </button>
        )}
      </div>
    </div>
  )
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export default function WorkflowPanel() {
  const { workflows, load, activeId } = useWorkflowsStore()
  const { modelExtensions, processExtensions } = useExtensionsStore()
  const loadExtensions         = useExtensionsStore((s) => s.loadExtensions)
  const { navigate }           = useNavStore()
  const [selectedId, setSelectedId] = useState<string | null>(activeId)

  const allExtensions = useMemo(
    () => buildAllWorkflowExtensions(modelExtensions, processExtensions),
    [modelExtensions, processExtensions],
  )

  useEffect(() => { load(); loadExtensions() }, [])

  // Sync when navigated here from the workflow editor (activeId set externally)
  useEffect(() => {
    if (activeId) setSelectedId(activeId)
  }, [activeId])

  useEffect(() => {
    if (!selectedId && workflows.length > 0) setSelectedId(workflows[0].id)
  }, [workflows])

  const workflow = workflows.find((w) => w.id === selectedId) ?? null

  return (
    <div className="flex flex-col flex-1 min-h-0">

      {/* Header */}
      <div className="shrink-0 px-4 pt-3 pb-3 border-b border-zinc-800 flex flex-col gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Workflow</h2>
        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-0">
            <WorkflowDropdown workflows={workflows} value={selectedId} onChange={setSelectedId} />
          </div>
          {selectedId && (
            <button
              onClick={() => { useWorkflowsStore.getState().setActive(selectedId!); navigate('workflows') }}
              title="Edit workflow"
              className="shrink-0 p-1.5 rounded-lg border border-zinc-700 bg-zinc-800/60 text-zinc-400
                         hover:text-zinc-100 hover:bg-zinc-700 hover:border-zinc-600 transition-colors"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Canvas or empty state */}
      {workflow ? (
        <ReactFlowProvider>
          <EmbeddedCanvas
            key={workflow.id + workflow.updatedAt}
            workflow={workflow}
            allExtensions={allExtensions}
          />
        </ReactFlowProvider>
      ) : (
        <div className="flex-1 flex items-center justify-center px-6">
          <p className="text-xs text-zinc-600 text-center leading-relaxed">
            No workflows yet.<br/>Create one in the Workflows tab.
          </p>
        </div>
      )}
    </div>
  )
}

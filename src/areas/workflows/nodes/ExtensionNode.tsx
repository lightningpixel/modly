import { useCallback, useEffect, useRef, useLayoutEffect, useState } from 'react'
import { Handle, Position, useReactFlow } from '@xyflow/react'
import { useExtensionsStore } from '@shared/stores/extensionsStore'
import LlmModelSelect from '@shared/components/ui/LlmModelSelect'
import { buildAllWorkflowExtensions } from '../mockExtensions'
import { HANDLE_COLOR, TAG_CLS, TAG_FALLBACK, FALLBACK_COLOR } from '../portColors'
import type { ParamSchema } from '../mockExtensions'
import type { WFNodeData } from '@shared/types/electron.d'
import { useWorkflowRunStore } from '../workflowRunStore'
import BaseNode from './BaseNode'

// ─── Param control ────────────────────────────────────────────────────────────

// nodrag — without it, React Flow starts dragging the node on mousedown inside
// these fields, so click-drag text selection (or opening a <select>) moves the
// node instead.
const inputCls = 'nodrag w-full bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1 text-[11px] text-zinc-200 focus:outline-none focus:border-accent/60'

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
  // Sync when external value changes (e.g. reset)
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

/** Dropdown of the files inside the folder held by another param (dir_from). */
function FileSelectControl({ param, value, dirValue, onChange }: {
  param:    ParamSchema
  value:    string
  dirValue: string
  onChange: (v: string) => void
}) {
  const [files, setFiles] = useState<string[]>([])
  const extsKey = (param.extensions ?? []).join(',')
  useEffect(() => {
    let alive = true
    if (!dirValue) { setFiles([]); return }
    window.electron.fs.listFiles(dirValue, param.extensions ?? undefined).then((list) => {
      if (alive) setFiles(list)
    }).catch(() => { if (alive) setFiles([]) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirValue, extsKey])

  return (
    <select value={value} disabled={!dirValue} onChange={(e) => onChange(e.target.value)}
      className={`${inputCls} ${!dirValue ? 'opacity-50 cursor-not-allowed' : ''}`}>
      <option value="">{!dirValue ? 'Pick a folder first…' : files.length === 0 ? 'No files found' : 'Select…'}</option>
      {/* Keep a saved value visible even if it's no longer in the folder listing. */}
      {value && !files.includes(value) && <option value={value}>{value} (missing)</option>}
      {files.map((f) => <option key={f} value={f}>{f}</option>)}
    </select>
  )
}

function ParamControl({ param, value, onChange, resolvedParams }: {
  param:          ParamSchema
  value:          number | string
  onChange:       (v: number | string) => void
  resolvedParams: Record<string, unknown>
}) {
  if (param.type === 'file-select') {
    const dirValue = String(resolvedParams[param.dir_from ?? ''] ?? '')
    return <FileSelectControl param={param} value={String(value ?? '')} dirValue={dirValue} onChange={onChange} />
  }
  if (param.type === 'llm-model') {
    return <LlmModelSelect value={String(value ?? '')} tag={param.llm_tag} className={inputCls} onChange={onChange} />
  }
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
        <button
          onClick={async () => {
            const p = await window.electron.fs.selectDirectory()
            if (p) onChange(p)
          }}
          className="nodrag shrink-0 flex items-center justify-center w-6 h-6 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-400 hover:text-zinc-200 transition-colors"
        >
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

// ─── ExtensionNode ────────────────────────────────────────────────────────────

export default function ExtensionNode({ id, data, selected }: { id: string; data: WFNodeData; selected?: boolean }) {
  const { updateNodeData } = useReactFlow()
  const running = useWorkflowRunStore((s) => s.activeNodeId === id)

  const { modelExtensions, processExtensions } = useExtensionsStore()
  const allExtensions = buildAllWorkflowExtensions(modelExtensions, processExtensions)
  const ext = allExtensions.find((e) => e.id === data.extensionId)

  // One row (and one handle) per declared input, however many the manifest
  // declares — a 3rd input used to be dropped silently by the UI while the
  // runner, preflight and autowire all handled it fine.
  const inputs      = (ext?.inputs && ext.inputs.length > 0 ? ext.inputs : [ext?.input ?? 'image']) as string[]
  const isMulti     = inputs.length > 1
  // Manifest-driven. Deliberately NOT set on mesh-exporter: the old check here
  // compared `ext.id === 'mesh-exporter'` against an id that is really
  // "mesh-exporter/export", so it never fired — Export Mesh has always had an
  // output handle, and turning it off now would hide (but not delete) the edges
  // of every saved workflow that chains something after it.
  const isTerminal  = ext?.terminal ?? false
  const outputColor = HANDLE_COLOR[ext?.output ?? 'mesh']
  const hasParams   = (ext?.params.length ?? 0) > 0

  // Refs for handle alignment — one per input row.
  const ioRowRefs = useRef<(HTMLDivElement | null)[]>([])
  const [handleTops, setHandleTops] = useState<string[]>([])
  const handleTop = handleTops[0] ?? '50%'

  // Align handles with their respective IO rows after mount
  useLayoutEffect(() => {
    const tops = inputs.map((_, i) => {
      const el = ioRowRefs.current[i]
      return el ? `${el.offsetTop + el.offsetHeight / 2}px` : '50%'
    })
    setHandleTops((prev) => (prev.length === tops.length && prev.every((v, i) => v === tops[i]) ? prev : tops))
    // `inputs` is rebuilt on every render; its length is what changes the layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputs.length, hasParams])

  const patchParam = useCallback((key: string, val: number | string) => {
    const params = { ...data.params, [key]: val }
    updateNodeData(id, { params })
    // Push live so a paused/looping run picks up the change on the next node start.
    useWorkflowRunStore.getState().setLiveNodeParams(id, params)
  }, [id, data.params, updateNodeData])

  const paramById = new Map(ext?.params.map((p) => [p.id, p]))

  const isVisible = (param: ParamSchema): boolean => {
    if (!param.show_if) return true
    return Object.entries(param.show_if).every(([key, expected]) => {
      const current = data.params[key] ?? paramById.get(key)?.default
      return Array.isArray(expected) ? expected.includes(current as string | number) : current === expected
    })
  }

  // ── IO subheader ─────────────────────────────────────────────────────────
  // One row per input; the output badge rides on the first row.
  const tagCls = (type: string | undefined) => TAG_CLS[type ?? ''] ?? TAG_FALLBACK

  const ioRow = (type: string, index: number) => (
    <div
      key={index}
      ref={(el) => { ioRowRefs.current[index] = el }}
      className="flex items-center justify-between px-3 py-2"
    >
      <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border ${tagCls(type)}`}>
        {ext?.inputLabels?.[index] ?? type ?? '—'}
      </span>
      {index === 0 && !isTerminal && (
        <>
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-zinc-600 shrink-0">
            <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
          </svg>
          <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border ${tagCls(ext?.output)}`}>
            {ext?.output ?? '—'}
          </span>
        </>
      )}
    </div>
  )

  const ioSubheader = isMulti ? (
    <div className="flex flex-col divide-y divide-zinc-800/40">{inputs.map(ioRow)}</div>
  ) : (
    ioRow(inputs[0], 0)
  )

  // ── Handles ──────────────────────────────────────────────────────────────
  const handlesEl = (
    <>
      {/* One input handle per declared input, aligned with its row */}
      {inputs.map((type, i) => (
        <Handle
          key={i}
          id={`input-${i}`}
          type="target"
          position={Position.Left}
          style={{
            background: HANDLE_COLOR[type] ?? FALLBACK_COLOR, width: 14, height: 14,
            border: '2.5px solid #18181b', top: handleTops[i] ?? '50%',
          }}
        />
      ))}
      {/* Output handle */}
      {!isTerminal && (
        <Handle
          id="output"
          type="source"
          position={Position.Right}
          style={{ background: outputColor, width: 14, height: 14, border: '2.5px solid #18181b', top: handleTop }}
        />
      )}
    </>
  )

  return (
    <BaseNode
      id={id}
      selected={selected}
      running={running}
      title={ext?.name ?? data.extensionId ?? 'Unknown extension'}
      enabled={data.enabled}
      showInGenerate={data.showInGenerate ?? false}
      collapsible={hasParams}
      minWidth={200}
      subheader={ioSubheader}
      handles={handlesEl}
    >
      {hasParams && (
        <div className="px-3 pb-3 pt-2.5 flex flex-col gap-2">
          {(() => {
            // Effective values of every param (user value or schema default) —
            // lets file-select params resolve their source folder (dir_from).
            const resolvedParams = Object.fromEntries(
              (ext?.params ?? []).map((p) => [p.id, data.params[p.id] ?? p.default]),
            )
            return ext!.params.filter(isVisible).map((param) => {
              const val = (data.params[param.id] ?? param.default) as number | string
              return (
                <div key={param.id} className="flex items-center gap-2">
                  <label className="text-[10px] text-zinc-500 w-24 shrink-0 leading-tight">{param.label}</label>
                  <div className="flex-1">
                    <ParamControl
                      param={param}
                      value={val}
                      onChange={(v) => patchParam(param.id, v)}
                      resolvedParams={resolvedParams}
                    />
                  </div>
                </div>
              )
            })
          })()}
        </div>
      )}
    </BaseNode>
  )
}

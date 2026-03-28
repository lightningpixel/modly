import { useCallback, useEffect, useRef, useState } from 'react'
import { useWorkflowsStore } from '@shared/stores/workflowsStore'
import { useAppStore } from '@shared/stores/appStore'
import { getMockExtension } from '@areas/workflows/mockExtensions'
import type { ParamSchema } from '@areas/workflows/mockExtensions'
import type { Workflow, WorkflowBlock } from '@shared/types/electron.d'

// ─── Param control ────────────────────────────────────────────────────────────

const inputClass = 'w-full bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1 text-[11px] text-zinc-200 focus:outline-none focus:border-accent/60'

function ParamControl({ param, value, onChange }: {
  param:    ParamSchema
  value:    number | string
  onChange: (v: number | string) => void
}) {
  if (param.type === 'select') {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)} className={inputClass}>
        {param.options?.map((o) => (
          <option key={String(o.value)} value={o.value}>{o.label}</option>
        ))}
      </select>
    )
  }
  return (
    <input
      type="number"
      value={value as number}
      min={param.min}
      max={param.max}
      step={param.step ?? (param.type === 'float' ? 0.1 : 1)}
      onChange={(e) => onChange(param.type === 'float' ? parseFloat(e.target.value) : parseInt(e.target.value, 10))}
      className={inputClass}
    />
  )
}

// ─── Block card (mirrors WorkflowsPage BlockCard style) ───────────────────────

const DOT: Record<string, string> = {
  preprocessor:  'bg-sky-500',
  generator:     'bg-violet-500',
  postprocessor: 'bg-emerald-500',
}

function BlockCard({ block, onToggle, onPatchParam }: {
  block:        WorkflowBlock
  onToggle:     () => void
  onPatchParam: (key: string, value: number | string) => void
}) {
  const [expanded, setExpanded] = useState(true)
  const ext      = getMockExtension(block.extension)
  const dot      = DOT[ext?.category ?? 'generator']
  const hasParams = ext && ext.params.length > 0

  return (
    <div className={`w-full rounded-lg border border-zinc-800 bg-zinc-900 transition-colors hover:border-zinc-700 ${!block.enabled ? 'opacity-40' : ''}`}>

      {/* Header */}
      <div className="flex items-center px-3 py-3">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-semibold text-zinc-200 truncate">{ext?.name ?? block.extension}</p>
            <p className="text-[10px] text-zinc-500 truncate mt-0.5">{ext?.description ?? ''}</p>
          </div>
          {/* Toggle */}
          <button
            onClick={onToggle}
            title={block.enabled ? 'Disable' : 'Enable'}
            className="relative shrink-0"
            style={{ width: 28, height: 16 }}
          >
            <span className={`absolute inset-0 rounded-full transition-colors ${block.enabled ? 'bg-accent/70' : 'bg-zinc-700'}`} />
            <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-all ${block.enabled ? 'left-[13px]' : 'left-0.5'}`} />
          </button>
        </div>

        {/* Chevron */}
        <button
          onClick={() => setExpanded((v) => !v)}
          className="p-1 ml-3 rounded text-zinc-600 hover:text-zinc-400 transition-colors shrink-0"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={`transition-transform ${expanded ? 'rotate-180' : ''}`}>
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>
      </div>

      {/* Params */}
      {expanded && (
        <div className="px-3 pb-3 border-t border-zinc-800 pt-2.5 flex flex-col gap-2">
          {hasParams ? ext.params.map((param) => {
            const val = (block.params[param.id] ?? param.default) as number | string
            return (
              <div key={param.id} className="flex items-center gap-2">
                <label className="text-[10px] text-zinc-500 w-24 shrink-0 truncate">{param.label}</label>
                <div className="flex-1">
                  <ParamControl param={param} value={val} onChange={(v) => onPatchParam(param.id, v)} />
                </div>
              </div>
            )
          }) : (
            <p className="text-[10px] text-zinc-600 italic">No parameters</p>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Input block ─────────────────────────────────────────────────────────────

function InputBlock({ type }: { type: 'image' | 'text' }) {
  const { selectedImagePreviewUrl, setSelectedImagePath, setSelectedImagePreviewUrl, setSelectedImageData } = useAppStore()
  const [isDragging, setIsDragging] = useState(false)

  const handleClick = useCallback(async () => {
    const path = await window.electron.fs.selectImage()
    if (!path) return
    setSelectedImageData(null)
    setSelectedImagePath(path)
    const base64 = await window.electron.fs.readFileBase64(path)
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    setSelectedImagePreviewUrl(URL.createObjectURL(new Blob([bytes], { type: 'image/png' })))
  }, [setSelectedImagePath, setSelectedImagePreviewUrl, setSelectedImageData])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (!file || !file.type.startsWith('image/')) return
    setSelectedImagePreviewUrl(URL.createObjectURL(file))
    const path = (file as File & { path?: string }).path
    if (path) {
      setSelectedImageData(null)
      setSelectedImagePath(path)
    } else {
      const reader = new FileReader()
      reader.onload = (ev) => {
        const base64 = (ev.target?.result as string).split(',')[1]
        setSelectedImageData(base64)
        setSelectedImagePath('__blob__')
      }
      reader.readAsDataURL(file)
    }
  }, [setSelectedImagePath, setSelectedImagePreviewUrl, setSelectedImageData])

  return (
    <div className="w-full rounded-lg border border-zinc-800 bg-zinc-900">
      <div className="flex items-center justify-between px-3 py-3">
        <div className="flex items-center gap-3">
          <div className="w-1.5 h-1.5 rounded-full bg-zinc-500 shrink-0" />
          <span className="text-[11px] font-semibold text-zinc-200">Input</span>
        </div>
        <span className="text-[9px] text-zinc-500 uppercase tracking-wide px-2 py-0.5 rounded-full bg-zinc-800 border border-zinc-700">{type}</span>
      </div>
      <div className="px-3 pb-3 border-t border-zinc-800 pt-2.5">
        {type === 'image' ? (
          <div
            onClick={handleClick}
            onDrop={handleDrop}
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
            onDragLeave={() => setIsDragging(false)}
            className={`relative rounded-lg border-2 border-dashed overflow-hidden flex items-center justify-center cursor-pointer transition-colors
              ${isDragging ? 'border-accent bg-accent/10' : 'border-zinc-700 hover:border-zinc-500'}`}
            style={{ height: selectedImagePreviewUrl ? 'auto' : '80px' }}
          >
            {selectedImagePreviewUrl ? (
              <>
                <img src={selectedImagePreviewUrl} alt="Input" className="w-full object-cover rounded-md" />
                <button
                  onClick={(e) => { e.stopPropagation(); setSelectedImagePath(null); setSelectedImagePreviewUrl(null); setSelectedImageData(null) }}
                  className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-black/70 hover:bg-black/90 text-zinc-300 hover:text-white flex items-center justify-center transition-colors"
                >
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
              </>
            ) : (
              <div className="flex flex-col items-center gap-1.5 text-zinc-600">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="3" y="3" width="18" height="18" rx="2"/>
                  <circle cx="8.5" cy="8.5" r="1.5"/>
                  <polyline points="21 15 16 10 5 21"/>
                </svg>
                <span className="text-[10px]">Drop or click to browse</span>
              </div>
            )}
          </div>
        ) : (
          <textarea
            placeholder="Enter your text input…"
            rows={3}
            className="w-full resize-none rounded-lg bg-zinc-950/40 border border-zinc-700 px-3 py-2 text-[11px] text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 leading-relaxed"
          />
        )}
      </div>
    </div>
  )
}

// ─── Connector arrow ─────────────────────────────────────────────────────────

function Connector() {
  return (
    <div className="flex flex-col items-center py-0.5 shrink-0">
      <div className="w-px h-3 bg-zinc-700" />
      <svg width="8" height="5" viewBox="0 0 8 5" fill="none" className="text-zinc-600">
        <path d="M0 0L4 5L8 0" fill="currentColor" />
      </svg>
    </div>
  )
}

// ─── Workflow selector dropdown ───────────────────────────────────────────────

function WorkflowDropdown({ workflows, value, onChange }: {
  workflows: Workflow[]
  value:     string | null
  onChange:  (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref             = useRef<HTMLDivElement>(null)
  const selected        = workflows.find((w) => w.id === value)

  useEffect(() => {
    if (!open) return
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [open])

  if (workflows.length === 0) {
    return (
      <div className="px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-600 text-xs">
        No workflows yet
      </div>
    )
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`w-full flex items-center justify-between px-3 py-2 rounded-lg bg-zinc-900 border text-left transition-colors ${open ? 'border-zinc-600' : 'border-zinc-800 hover:border-zinc-700'}`}
      >
        <span className="text-xs font-medium text-zinc-200 truncate">
          {selected?.name ?? 'Select a workflow…'}
        </span>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={`shrink-0 ml-2 text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      {open && (
        <div className="absolute top-full mt-1 left-0 right-0 z-50 rounded-lg bg-zinc-900 border border-zinc-700 shadow-xl overflow-hidden">
          {workflows.map((wf, i) => (
            <button
              key={wf.id}
              onClick={() => { onChange(wf.id); setOpen(false) }}
              className={`w-full flex items-center gap-2 px-3 py-2 text-left text-xs transition-colors
                ${i > 0 ? 'border-t border-zinc-800' : ''}
                ${wf.id === value ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-800/60'}`}
            >
              <span className="flex-1 truncate">{wf.name}</span>
              <span className="text-[9px] text-zinc-600 uppercase shrink-0">{wf.blocks.length} block{wf.blocks.length !== 1 ? 's' : ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export default function WorkflowPanel() {
  const { workflows, load } = useWorkflowsStore()
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // per-block overrides: params + enabled
  const [paramOverrides,   setParamOverrides]   = useState<Record<string, Record<string, number | string>>>({})
  const [enabledOverrides, setEnabledOverrides] = useState<Record<string, boolean>>({})

  useEffect(() => { load() }, [])

  useEffect(() => {
    if (!selectedId && workflows.length > 0) setSelectedId(workflows[0].id)
  }, [workflows])

  useEffect(() => {
    setParamOverrides({})
    setEnabledOverrides({})
  }, [selectedId])

  const workflow = workflows.find((w) => w.id === selectedId) ?? null

  function patchParam(blockId: string, key: string, value: number | string) {
    setParamOverrides((prev) => ({ ...prev, [blockId]: { ...(prev[blockId] ?? {}), [key]: value } }))
  }

  function toggleBlock(blockId: string, currentEnabled: boolean) {
    setEnabledOverrides((prev) => ({ ...prev, [blockId]: !(prev[blockId] ?? currentEnabled) }))
  }

  function resolveBlock(block: WorkflowBlock): WorkflowBlock {
    return {
      ...block,
      enabled: enabledOverrides[block.id] ?? block.enabled,
      params:  { ...block.params, ...(paramOverrides[block.id] ?? {}) },
    }
  }

  return (
    <div className="flex flex-col h-full">

      {/* Sticky header */}
      <div className="shrink-0 px-4 pt-3 pb-3 border-b border-zinc-800 flex flex-col gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Workflow</h2>
        <WorkflowDropdown workflows={workflows} value={selectedId} onChange={setSelectedId} />
      </div>

      {/* Scrollable chain */}
      <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col items-stretch">
        {workflow ? (
          <>
            {/* Input block */}
            <InputBlock type={workflow.input} />

            {/* Pipeline blocks */}
            {workflow.blocks.length === 0 ? (
              <Connector />
            ) : workflow.blocks.map((block) => {
              const resolved = resolveBlock(block)
              return (
                <div key={block.id} className="flex flex-col items-stretch">
                  <Connector />
                  <BlockCard
                    block={resolved}
                    onToggle={() => toggleBlock(block.id, block.enabled)}
                    onPatchParam={(key, val) => patchParam(block.id, key, val)}
                  />
                </div>
              )
            })}

            <Connector />

            {/* Output block */}
            <div className="w-full rounded-lg border border-zinc-800 bg-zinc-900">
              <div className="flex items-center gap-3 px-3 py-3">
                <div className="w-1.5 h-1.5 rounded-full bg-zinc-500 shrink-0" />
                <span className="text-[11px] font-semibold text-zinc-400">Output</span>
              </div>
            </div>
          </>
        ) : (
          !workflows.length && (
            <p className="text-xs text-zinc-600 text-center mt-6">No workflows yet.<br/>Create one in the Workflows tab.</p>
          )
        )}
      </div>
    </div>
  )
}

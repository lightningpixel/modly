import { useEffect, useRef, useState } from 'react'
import { useWorkflowsStore } from '@shared/stores/workflowsStore'
import { useExtensionsStore } from '@shared/stores/extensionsStore'
import { useNavStore } from '@shared/stores/navStore'
import type { Workflow, WorkflowBlock } from '@shared/types/electron.d'
import { MOCK_EXTENSIONS, getMockExtension } from './mockExtensions'
import type { ParamSchema, MockExtension } from './mockExtensions'

// ─── Category styles ──────────────────────────────────────────────────────────

const CATEGORY_STYLES: Record<MockExtension['category'], { border: string; bg: string; text: string; dot: string; glowBorder: string; glowBorderHover: string; glowShadow: string; gradient: string; chipBg: string }> = {
  preprocessor: {
    border:          'border-l-sky-500',
    bg:              'bg-sky-500/10',
    text:            'text-sky-400',
    dot:             'bg-sky-500',
    glowBorder:      'border-sky-500/20',
    glowBorderHover: 'hover:border-sky-500/45',
    glowShadow:      'shadow-sky-500/10',
    gradient:        'from-sky-500/8',
    chipBg:          'bg-sky-500/10',
  },
  generator: {
    border:          'border-l-violet-500',
    bg:              'bg-violet-500/10',
    text:            'text-violet-400',
    dot:             'bg-violet-500',
    glowBorder:      'border-violet-500/20',
    glowBorderHover: 'hover:border-violet-500/45',
    glowShadow:      'shadow-violet-500/10',
    gradient:        'from-violet-500/8',
    chipBg:          'bg-violet-500/10',
  },
  postprocessor: {
    border:          'border-l-emerald-500',
    bg:              'bg-emerald-500/10',
    text:            'text-emerald-400',
    dot:             'bg-emerald-500',
    glowBorder:      'border-emerald-500/20',
    glowBorderHover: 'hover:border-emerald-500/45',
    glowShadow:      'shadow-emerald-500/10',
    gradient:        'from-emerald-500/8',
    chipBg:          'bg-emerald-500/10',
  },
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function newId(): string {
  return crypto.randomUUID()
}

function newWorkflow(): Workflow {
  const now = new Date().toISOString()
  return { id: newId(), name: 'New Workflow', description: '', input: 'image', blocks: [], createdAt: now, updatedAt: now }
}

function newBlock(extensionId: string): WorkflowBlock {
  return { id: newId(), extension: extensionId, enabled: true, params: {} }
}

// ─── Block card ───────────────────────────────────────────────────────────────

function ParamControl({ param, value, onChange }: {
  param:    ParamSchema
  value:    number | string
  onChange: (v: number | string) => void
}) {
  const inputClass = "w-full bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1 text-[11px] text-zinc-200 focus:outline-none focus:border-accent/60"

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

function BlockCard({
  block, onToggle, onRemove, onPatchParam,
}: {
  block:        WorkflowBlock
  onToggle:     () => void
  onRemove:     () => void
  onPatchParam: (key: string, value: number | string) => void
}) {
  const ext      = getMockExtension(block.extension)
  const category = ext?.category ?? 'generator'
  const styles   = CATEGORY_STYLES[category]
  const categoryLabel = category === 'preprocessor' ? 'Preprocessor' : category === 'generator' ? 'Generator' : 'Post-processor'

  const [expanded, setExpanded] = useState(true)
  const hasParams = ext && ext.params.length > 0

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(BLOCK_DRAG_KEY, block.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      className={`group relative w-full rounded-lg border border-zinc-800 bg-zinc-900 transition-colors hover:border-zinc-700 cursor-grab active:cursor-grabbing ${!block.enabled ? 'opacity-40' : ''}`}
    >

      {/* Remove button — half outside top-right corner, hover only */}
      <button
        onClick={onRemove}
        className="absolute -top-2.5 -right-2.5 w-6 h-6 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center text-zinc-500 hover:text-red-400 hover:bg-red-950 hover:border-red-800/60 transition-colors opacity-0 group-hover:opacity-100 z-10"
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>

      {/* Header row */}
      <div className="flex items-center px-3 py-3">

        {/* Left: dot + name + toggle */}
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${styles.dot}`} />
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-semibold text-zinc-200 truncate">{ext?.name ?? block.extension}</p>
            <p className="text-[10px] text-zinc-500 truncate mt-0.5">{ext?.description ?? ''}</p>
          </div>
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

        {/* Chevron — far right */}
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v) }}
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

// ─── Connector arrow ──────────────────────────────────────────────────────────

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

// ─── Add block picker ─────────────────────────────────────────────────────────

function AddBlockPicker({
  usedIds, onSelect, onClose,
}: {
  usedIds:  string[]
  onSelect: (id: string) => void
  onClose:  () => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [onClose])

  const groups: Record<MockExtension['category'], MockExtension[]> = {
    preprocessor:  MOCK_EXTENSIONS.filter((e) => e.category === 'preprocessor'),
    generator:     MOCK_EXTENSIONS.filter((e) => e.category === 'generator'),
    postprocessor: MOCK_EXTENSIONS.filter((e) => e.category === 'postprocessor'),
  }

  const groupLabels: Record<MockExtension['category'], string> = {
    preprocessor:  'Preprocessors',
    generator:     'Generators',
    postprocessor: 'Post-processors',
  }

  return (
    <div
      ref={ref}
      className="absolute z-20 bottom-full mb-2 left-1/2 -translate-x-1/2 w-72 bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl overflow-hidden"
    >
      <div className="px-3 py-2 border-b border-zinc-800">
        <p className="text-[11px] font-semibold text-zinc-400">Add a block</p>
      </div>
      <div className="max-h-72 overflow-y-auto">
        {(Object.keys(groups) as MockExtension['category'][]).map((cat) => (
          <div key={cat}>
            <p className={`px-3 pt-2.5 pb-1 text-[9px] font-bold uppercase tracking-widest ${CATEGORY_STYLES[cat].text}`}>
              {groupLabels[cat]}
            </p>
            {groups[cat].map((ext) => {
              const used = usedIds.includes(ext.id)
              return (
                <button
                  key={ext.id}
                  disabled={used}
                  onClick={() => { onSelect(ext.id); onClose() }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-zinc-800 disabled:opacity-35 disabled:cursor-not-allowed transition-colors"
                >
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${CATEGORY_STYLES[cat].dot}`} />
                  <div className="min-w-0">
                    <p className="text-[11px] font-medium text-zinc-200 truncate">{ext.name}</p>
                    <p className="text-[10px] text-zinc-500 truncate">{ext.description}</p>
                  </div>
                  {used && <span className="ml-auto text-[9px] text-zinc-600 shrink-0">Added</span>}
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Pipeline canvas ──────────────────────────────────────────────────────────

const DRAG_KEY       = 'modly/extension-id'
const BLOCK_DRAG_KEY = 'modly/block-id'

function DropZone({ index, active, onDrop, onDragOver, onDragLeave }: {
  index:       number
  active:      boolean
  onDrop:      (index: number, id: string, type: 'extension' | 'block') => void
  onDragOver:  (index: number) => void
  onDragLeave: () => void
}) {
  return (
    <div
      className="w-full flex flex-col items-center"
      onDragOver={(e) => { e.preventDefault(); onDragOver(index) }}
      onDragLeave={onDragLeave}
      onDrop={(e) => {
        e.preventDefault()
        const extId   = e.dataTransfer.getData(DRAG_KEY)
        const blockId = e.dataTransfer.getData(BLOCK_DRAG_KEY)
        if (extId)   onDrop(index, extId,   'extension')
        else if (blockId) onDrop(index, blockId, 'block')
      }}
    >
      <div className={`w-px transition-all ${active ? 'h-8 bg-accent' : 'h-3 bg-zinc-700'}`} />
      <div className={`transition-all overflow-hidden ${active ? 'h-8 opacity-100' : 'h-0 opacity-0'}`}>
        <div className="flex items-center justify-center w-full h-8 mx-auto rounded-xl border-2 border-dashed border-accent/60 bg-accent/5 text-accent text-[10px] font-semibold px-6">
          Drop here
        </div>
      </div>
      {active && <div className="w-px h-3 bg-accent" />}
      {!active && (
        <svg width="8" height="5" viewBox="0 0 8 5" fill="none" className="text-zinc-600">
          <path d="M0 0L4 5L8 0" fill="currentColor" />
        </svg>
      )}
    </div>
  )
}

function PipelineCanvas({
  draft, onPatch, onAddBlock, onInsertBlock, onRemoveBlock, onReorderBlock, onPatchBlock,
}: {
  draft:           Workflow
  onPatch:         (p: Partial<Workflow>) => void
  onAddBlock:      (id: string) => void
  onInsertBlock:   (id: string, atIndex: number) => void
  onRemoveBlock:   (id: string) => void
  onReorderBlock:  (id: string, toIndex: number) => void
  onPatchBlock:    (id: string, p: Partial<WorkflowBlock>) => void
}) {
  const [showPicker, setShowPicker]         = useState(false)
  const [activeDropZone, setActiveDropZone] = useState<number | null>(null)
  const usedIds = draft.blocks.map((b) => b.extension)

  function handleDrop(index: number, id: string, type: 'extension' | 'block') {
    setActiveDropZone(null)
    if (type === 'extension') {
      if (usedIds.includes(id)) return
      onInsertBlock(id, index)
    } else {
      onReorderBlock(id, index)
    }
  }

  return (
    <div className="flex flex-col items-center w-full max-w-md mx-auto py-8 px-4">

      {/* Input block */}
      <div className="w-full rounded-xl border border-zinc-700 bg-zinc-900 overflow-hidden">
        <div className="p-3 flex flex-col gap-3">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-lg bg-zinc-800 flex items-center justify-center shrink-0">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-zinc-400">
                  <path d="M3 12h18M3 6h18M3 18h18"/>
                </svg>
              </div>
              <span className="text-[11px] font-semibold text-zinc-200">Input</span>
            </div>
            {/* Type toggle */}
            <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-zinc-800 border border-zinc-700">
              {(['image', 'text'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => onPatch({ input: t })}
                  className={`px-2.5 py-1 rounded-md text-[10px] font-semibold capitalize transition-colors ${
                    draft.input === t
                      ? 'bg-zinc-700 text-zinc-100'
                      : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* Content area */}
          {draft.input === 'image' ? (
            <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-zinc-700 bg-zinc-950/40 h-28 text-zinc-600 hover:border-zinc-600 hover:text-zinc-500 transition-colors cursor-default">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
                <circle cx="8.5" cy="8.5" r="1.5"/>
                <polyline points="21 15 16 10 5 21"/>
              </svg>
              <span className="text-[10px]">Drop an image here or click to browse</span>
            </div>
          ) : (
            <textarea
              placeholder="Enter your text input…"
              rows={4}
              className="w-full resize-none rounded-lg bg-zinc-950/40 border border-zinc-700 px-3 py-2 text-[11px] text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 leading-relaxed"
            />
          )}

          {/* Output chip */}
          <div className="flex justify-end">
            <span className="px-2 py-0.5 rounded-full bg-zinc-800 border border-zinc-700 text-[9px] text-zinc-500 uppercase tracking-wide">
              {draft.input}
            </span>
          </div>
        </div>
      </div>

      {/* First drop zone (index 0) */}
      <DropZone
        index={0}
        active={activeDropZone === 0}
        onDrop={handleDrop}
        onDragOver={setActiveDropZone}
        onDragLeave={() => setActiveDropZone(null)}
      />

      {/* Blocks */}
      {draft.blocks.map((block, idx) => (
        <div key={block.id} className="w-full flex flex-col items-center">
          <BlockCard
            block={block}
            onToggle={() => onPatchBlock(block.id, { enabled: !block.enabled })}
            onRemove={() => onRemoveBlock(block.id)}
            onPatchParam={(key, val) => onPatchBlock(block.id, { params: { ...block.params, [key]: val } })}
          />
          <DropZone
            index={idx + 1}
            active={activeDropZone === idx + 1}
            onDrop={handleDrop}
            onDragOver={setActiveDropZone}
            onDragLeave={() => setActiveDropZone(null)}
          />
        </div>
      ))}

      {/* Add block button (when not dragging) */}
      {activeDropZone === null && (
        <div className="relative flex flex-col items-center">
          <button
            onClick={() => setShowPicker((v) => !v)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-full border border-dashed border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-500 text-[11px] font-medium transition-colors"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            Add block
          </button>
          {showPicker && (
            <AddBlockPicker
              usedIds={usedIds}
              onSelect={onAddBlock}
              onClose={() => setShowPicker(false)}
            />
          )}
        </div>
      )}

      {/* Output block */}
      <div className="flex flex-col items-center mt-1 w-full">
        <div className="w-px h-3 bg-zinc-700" />
        <svg width="8" height="5" viewBox="0 0 8 5" fill="none" className="text-zinc-600 mb-1">
          <path d="M0 0L4 5L8 0" fill="currentColor"/>
        </svg>
        <div className="w-full rounded-xl border border-zinc-700 bg-zinc-900 overflow-hidden">
          <div className="p-3 flex items-center gap-2">
            <div className="w-6 h-6 rounded-lg bg-zinc-800 flex items-center justify-center shrink-0">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-zinc-400">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </div>
            <span className="text-[11px] font-semibold text-zinc-400">Output</span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Workflow editor ──────────────────────────────────────────────────────────

function WorkflowEditor({
  workflow, onSave, onDelete, onExport,
}: {
  workflow: Workflow
  onSave:   (w: Workflow) => void
  onDelete: () => void
  onExport: () => void
}) {
  const { navigate } = useNavStore()
  const [draft, setDraft] = useState<Workflow>(workflow)
  const [dirty, setDirty] = useState(false)
  const [editingName, setEditingName] = useState(false)

  useEffect(() => { setDraft(workflow); setDirty(false) }, [workflow.id])

  function patch(p: Partial<Workflow>) { setDraft((d) => ({ ...d, ...p })); setDirty(true) }

  function addBlock(extensionId: string) {
    setDraft((d) => ({ ...d, blocks: [...d.blocks, newBlock(extensionId)] }))
    setDirty(true)
  }

  function insertBlock(extensionId: string, atIndex: number) {
    setDraft((d) => {
      const blocks = [...d.blocks]
      blocks.splice(atIndex, 0, newBlock(extensionId))
      return { ...d, blocks }
    })
    setDirty(true)
  }

  function removeBlock(id: string) {
    setDraft((d) => ({ ...d, blocks: d.blocks.filter((b) => b.id !== id) }))
    setDirty(true)
  }

  function reorderBlock(id: string, toIndex: number) {
    setDraft((d) => {
      const blocks = [...d.blocks]
      const from   = blocks.findIndex((b) => b.id === id)
      if (from === -1 || toIndex === from || toIndex === from + 1) return d
      const [item] = blocks.splice(from, 1)
      blocks.splice(toIndex > from ? toIndex - 1 : toIndex, 0, item)
      return { ...d, blocks }
    })
    setDirty(true)
  }

  function patchBlock(id: string, p: Partial<WorkflowBlock>) {
    setDraft((d) => ({ ...d, blocks: d.blocks.map((b) => b.id === id ? { ...b, ...p } : b) }))
    setDirty(true)
  }

  function handleSave() { onSave({ ...draft, updatedAt: new Date().toISOString() }); setDirty(false) }

  return (
    <div className="flex flex-col flex-1 overflow-hidden">

      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-zinc-800 shrink-0">

        {/* Inline name edit */}
        {editingName ? (
          <input
            autoFocus
            value={draft.name}
            onChange={(e) => patch({ name: e.target.value })}
            onBlur={() => setEditingName(false)}
            onKeyDown={(e) => e.key === 'Enter' && setEditingName(false)}
            className="flex-1 bg-transparent border-b border-accent/60 text-sm font-semibold text-zinc-200 focus:outline-none pb-0.5"
          />
        ) : (
          <button
            onClick={() => setEditingName(true)}
            className="flex-1 text-left text-sm font-semibold text-zinc-200 hover:text-white truncate"
          >
            {draft.name || 'Untitled'}
          </button>
        )}

<div className="flex items-center gap-1.5">
          <button
            onClick={() => navigate('generate')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent/10 border border-accent/30 text-accent-light hover:bg-accent/20 hover:border-accent/50 transition-colors"
            title="Run workflow"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="none">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
            <span className="text-[11px] font-semibold">Run</span>
          </button>
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
          {dirty && (
            <button
              onClick={handleSave}
              className="px-3 py-1.5 rounded-lg bg-accent text-white text-[11px] font-semibold hover:bg-accent/90 transition-colors"
            >
              Save
            </button>
          )}
        </div>
      </div>

      {/* Pipeline canvas */}
      <div className="flex-1 overflow-y-auto bg-[radial-gradient(circle_at_center,_#1f1f23_0%,_#131315_100%)]">
        <PipelineCanvas
          draft={draft}
          onPatch={patch}
          onAddBlock={addBlock}
          onInsertBlock={insertBlock}
          onRemoveBlock={removeBlock}
          onReorderBlock={reorderBlock}
          onPatchBlock={patchBlock}
        />
      </div>
    </div>
  )
}

// ─── Workflow card (sidebar) ──────────────────────────────────────────────────

function WorkflowCard({ workflow, active, onClick }: { workflow: Workflow; active: boolean; onClick: () => void }) {
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
        <span className="text-[10px] text-zinc-500 capitalize">{workflow.input}</span>
        <span className="text-[10px] text-zinc-600">·</span>
        <span className="text-[10px] text-zinc-500">{workflow.blocks.length} block{workflow.blocks.length !== 1 ? 's' : ''}</span>
      </div>
    </button>
  )
}

// ─── Tab bar ──────────────────────────────────────────────────────────────────

function TabBar({
  openIds, activeId, workflows, onActivate, onClose, onNew,
}: {
  openIds:    string[]
  activeId:   string | null
  workflows:  Workflow[]
  onActivate: (id: string) => void
  onClose:    (id: string) => void
  onNew:      () => void
}) {
  return (
    <div className="flex items-end gap-0 border-b border-zinc-800 bg-zinc-950/40 px-1 overflow-x-auto shrink-0">
      {openIds.map((id) => {
        const wf     = workflows.find((w) => w.id === id)
        const active = id === activeId
        return (
          <div
            key={id}
            onClick={() => onActivate(id)}
            className={`group flex items-center gap-1.5 px-3 py-2 min-w-0 max-w-[160px] cursor-pointer border-t border-x select-none transition-colors ${
              active
                ? 'bg-zinc-900 border-zinc-700 text-zinc-200 border-b-zinc-900 -mb-px z-10'
                : 'bg-transparent border-transparent text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/40'
            }`}
          >
            <span className="text-[11px] font-medium truncate flex-1">{wf?.name || 'Untitled'}</span>
            <button
              onClick={(e) => { e.stopPropagation(); onClose(id) }}
              className={`shrink-0 rounded p-0.5 transition-colors ${
                active
                  ? 'text-zinc-500 hover:text-zinc-200 hover:bg-zinc-700'
                  : 'text-transparent group-hover:text-zinc-500 hover:!text-zinc-200 hover:bg-zinc-700'
              }`}
            >
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        )
      })}
      <button
        onClick={onNew}
        title="New workflow"
        className="flex items-center justify-center w-7 h-7 mb-0.5 ml-0.5 shrink-0 rounded text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
    </div>
  )
}

// ─── Extensions panel ────────────────────────────────────────────────────────

function ExtensionsPanel({ usedIds }: { usedIds: string[] }) {
  const { extensions, loading, loadExtensions } = useExtensionsStore()

  useEffect(() => { loadExtensions() }, [])

  const groups: Record<MockExtension['category'], MockExtension[]> = {
    preprocessor:  MOCK_EXTENSIONS.filter((e) => e.category === 'preprocessor'),
    generator:     MOCK_EXTENSIONS.filter((e) => e.category === 'generator'),
    postprocessor: MOCK_EXTENSIONS.filter((e) => e.category === 'postprocessor'),
  }

  const groupLabels: Record<MockExtension['category'], string> = {
    preprocessor:  'Preprocessors',
    generator:     'Generators',
    postprocessor: 'Post-processors',
  }

  // Real installed extensions, enriched with mock category info
  const installedIds = new Set(extensions.flatMap((e) => e.models.map((m) => m.id)))

  return (
    <div className="flex flex-col w-72 shrink-0 border-l border-zinc-800 bg-zinc-950/30">
      <div className="px-4 py-3 border-b border-zinc-800">
        <h2 className="text-xs font-semibold text-zinc-300">Extensions</h2>
        <p className="text-[10px] text-zinc-600 mt-0.5">Available blocks</p>
      </div>

      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-4">
        {(Object.keys(groups) as MockExtension['category'][]).map((cat) => (
          <div key={cat} className="flex flex-col gap-2">
            <p className={`text-[9px] font-bold uppercase tracking-widest ${CATEGORY_STYLES[cat].text}`}>
              {groupLabels[cat]}
            </p>
            {groups[cat].map((ext) => {
              const installed = installedIds.has(ext.id)
              const inUse     = usedIds.includes(ext.id)
              const styles    = CATEGORY_STYLES[cat]
              return (
                <div
                  key={ext.id}
                  draggable={!inUse}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_KEY, ext.id)
                    e.dataTransfer.effectAllowed = 'copy'
                  }}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border border-zinc-800 bg-zinc-900 transition-colors
                    ${inUse ? 'opacity-35 cursor-not-allowed' : 'cursor-grab hover:bg-zinc-800/60 hover:border-zinc-700 active:cursor-grabbing'}`}
                >
                  {/* Colored dot */}
                  <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${styles.dot}`} />

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] font-medium text-zinc-200 truncate">{ext.name}</p>
                    <p className="text-[10px] text-zinc-500 truncate">{ext.description}</p>
                  </div>

                  {/* Right side */}
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    {installed && <span className={`text-[9px] font-semibold ${styles.text}`}>✓</span>}
                    {ext.params.length > 0 && <span className="text-[9px] text-zinc-600">{ext.params.length}p</span>}
                  </div>
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function WorkflowsPage(): JSX.Element {
  const { workflows, loading, activeId, load, save, remove, importFile, exportFile, setActive } = useWorkflowsStore()
  const [openIds, setOpenIds] = useState<string[]>([])

  useEffect(() => { load() }, [])

  useEffect(() => {
    const validIds = workflows.map((w) => w.id)
    setOpenIds((prev) => prev.filter((id) => validIds.includes(id)))
  }, [workflows])

  function openTab(id: string) {
    setOpenIds((prev) => prev.includes(id) ? prev : [...prev, id])
    setActive(id)
  }

  function closeTab(id: string) {
    const idx  = openIds.indexOf(id)
    const next = openIds[idx + 1] ?? openIds[idx - 1] ?? null
    setOpenIds((prev) => prev.filter((i) => i !== id))
    setActive(next)
  }

  const activeWorkflow = workflows.find((w) => w.id === activeId) ?? null

  async function handleCreate() {
    const wf = newWorkflow()
    await save(wf)
    openTab(wf.id)
  }

  async function handleImport() {
    const result = await importFile()
    if (result.success && result.workflow) openTab((result.workflow as Workflow).id)
  }

  return (
    <div className="flex flex-1 overflow-hidden">

      {/* Left panel */}
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
            <WorkflowCard key={wf.id} workflow={wf} active={wf.id === activeId} onClick={() => openTab(wf.id)} />
          ))}
        </div>
      </div>

      {/* Right panel */}
      <div className="flex flex-col flex-1 overflow-hidden">
        <TabBar
          openIds={openIds} activeId={activeId} workflows={workflows}
          onActivate={setActive} onClose={closeTab} onNew={handleCreate}
        />
        <div className="flex flex-1 overflow-hidden">
          {activeWorkflow ? (
            <WorkflowEditor
              key={activeWorkflow.id}
              workflow={activeWorkflow}
              onSave={save}
              onDelete={() => remove(activeWorkflow.id)}
              onExport={() => exportFile(activeWorkflow)}
            />
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
      </div>

      {/* Extensions panel */}
      <ExtensionsPanel usedIds={activeWorkflow?.blocks.map((b) => b.extension) ?? []} />

    </div>
  )
}

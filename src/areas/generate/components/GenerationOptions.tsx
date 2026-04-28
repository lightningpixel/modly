import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '@shared/stores/appStore'
import { useApi } from '@shared/hooks/useApi'
import { FieldLabel, Tooltip, ConfirmModal } from '@shared/components/ui'

import type { CatalogModel } from '../models'

const REMESH_OPTIONS = [
  { label: 'Quad-Dominant', value: 'quad'     },
  { label: 'Triangle', value: 'triangle' },
  { label: 'None',     value: 'none'     },
] as const

// ─── Schema types ──────────────────────────────────────────────────────────────

interface ParamSchema {
  id: string
  label: string
  type: 'select' | 'float' | 'int'
  default: any
  min?: number
  max?: number
  step?: number
  options?: { value: any; label: string }[]
  tooltip?: string
}

// ─── Dynamic parameter renderers ───────────────────────────────────────────────

function ShuffleIcon(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="17 1 21 5 17 9" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <polyline points="7 23 3 19 7 15" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </svg>
  )
}

function SelectParam({ schema, value, onChange }: { schema: ParamSchema; value: any; onChange: (v: any) => void }): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel label={schema.label} tooltip={schema.tooltip} />
      <div className="flex gap-1.5">
        {schema.options?.map((opt) => (
          <button
            key={String(opt.value)}
            onClick={() => onChange(opt.value)}
            className={`flex-1 py-1.5 text-xs rounded-lg transition-colors ${
              value === opt.value
                ? 'bg-accent text-white'
                : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function FloatParam({ schema, value, onChange }: { schema: ParamSchema; value: any; onChange: (v: any) => void }): JSX.Element {
  const step = schema.step ?? 0.1
  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel label={schema.label} tooltip={schema.tooltip} />
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={schema.min}
          max={schema.max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="flex-1 accent-violet-500"
        />
        <span className="text-xs tabular-nums text-zinc-300 w-10 text-right">
          {Number(value).toFixed(step < 1 ? 1 : 0)}
        </span>
      </div>
    </div>
  )
}

function IntInput({ value, onChange, placeholder, className }: { value: number; onChange: (v: number) => void; placeholder?: string; className: string }) {
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
      placeholder={placeholder}
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

function IntParam({ schema, value, onChange }: { schema: ParamSchema; value: any; onChange: (v: any) => void }): JSX.Element {
  const isSeed = schema.id === 'seed'
  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel label={schema.label} tooltip={schema.tooltip} />
      <div className="flex items-center gap-2">
        <IntInput
          value={value}
          onChange={onChange}
          placeholder={isSeed ? '-1 = random' : undefined}
          className="w-full px-3 py-1.5 text-xs rounded-lg bg-zinc-900 border border-zinc-700/60 text-zinc-200 focus:outline-none focus:border-zinc-500"
        />
        {isSeed && (
          <button
            onClick={() => onChange(Math.floor(Math.random() * (schema.max ?? 2147483647)))}
            title="Random seed"
            className="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            <ShuffleIcon />
          </button>
        )}
      </div>
    </div>
  )
}

function DynamicParam({ schema, value, onChange }: { schema: ParamSchema; value: any; onChange: (v: any) => void }): JSX.Element | null {
  switch (schema.type) {
    case 'select': return <SelectParam schema={schema} value={value} onChange={onChange} />
    case 'float':  return <FloatParam  schema={schema} value={value} onChange={onChange} />
    case 'int':    return <IntParam    schema={schema} value={value} onChange={onChange} />
    default:       return null
  }
}

// ─── Custom model dropdown ────────────────────────────────────────────────────

function ModelIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2L2 7l10 5 10-5-10-5z" />
      <path d="M2 17l10 5 10-5" />
      <path d="M2 12l10 5 10-5" />
    </svg>
  )
}

function CheckIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function ChevronIcon({ open }: { open: boolean }): JSX.Element {
  return (
    <svg
      width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}

interface ModelSelectProps {
  models: CatalogModel[]
  value: string
  onChange: (id: string) => void
}

function ModelSelect({ models, value, onChange }: ModelSelectProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const selected = models.find((m) => m.id === value)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  if (models.length === 0) {
    return (
      <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-600 text-sm">
        <div className="w-7 h-7 rounded-lg bg-zinc-800 flex items-center justify-center">
          <ModelIcon />
        </div>
        No model downloaded
      </div>
    )
  }

  return (
    <div ref={ref} className="relative">
      {/* Trigger */}
      <button
        onClick={() => setOpen((v) => !v)}
        className={`
          w-full flex items-center justify-between px-3 py-2.5 rounded-xl
          bg-zinc-900 border transition-all duration-150
          ${open ? 'border-zinc-500 ring-1 ring-zinc-600/40' : 'border-zinc-700/60 hover:border-zinc-600'}
        `}
      >
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-zinc-800 border border-zinc-700/50 flex items-center justify-center text-accent">
            <ModelIcon />
          </div>
          <span className="text-sm font-medium text-zinc-200">
            {selected?.name ?? value}
          </span>
        </div>
        <div className="text-zinc-500">
          <ChevronIcon open={open} />
        </div>
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute top-full mt-1.5 left-0 right-0 z-50 rounded-xl bg-zinc-900 border border-zinc-700/60 shadow-2xl overflow-hidden">
          {models.map((m, i) => {
            const isSelected = m.id === value
            return (
              <button
                key={m.id}
                onClick={() => { onChange(m.id); setOpen(false) }}
                className={`
                  w-full flex items-center justify-between px-3 py-2.5
                  transition-colors duration-100 text-left
                  ${i > 0 ? 'border-t border-zinc-800' : ''}
                  ${isSelected ? 'bg-zinc-800' : 'hover:bg-zinc-800/60'}
                `}
              >
                <div className="flex items-center gap-2.5">
                  <div className={`w-7 h-7 rounded-lg flex items-center justify-center border ${
                    isSelected
                      ? 'bg-accent/15 border-accent/30 text-accent'
                      : 'bg-zinc-800 border-zinc-700/50 text-zinc-500'
                  }`}>
                    <ModelIcon />
                  </div>
                  <div className="flex flex-col items-start">
                    <span className={`text-sm font-medium ${isSelected ? 'text-zinc-100' : 'text-zinc-300'}`}>
                      {m.name}
                    </span>
                    <span className="text-[10px] text-zinc-600 uppercase tracking-wide">{m.id}</span>
                  </div>
                </div>
                {isSelected && (
                  <span className="text-accent">
                    <CheckIcon />
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function GenerationOptions(): JSX.Element {
  const { generationOptions, setGenerationOptions, currentJob, apiUrl } = useAppStore()
  const [models, setModels] = useState<CatalogModel[]>([])
  const [textureResolutionRaw, setTextureResolutionRaw] = useState(
    String(generationOptions.textureResolution ?? 512)
  )

  const isDisabled = currentJob?.status === 'uploading' || currentJob?.status === 'generating'
  const [showTextureWarning, setShowTextureWarning] = useState(false)

  // ─── Dynamic params schema ─────────────────────────────────────────────────
  const [schema, setSchema] = useState<ParamSchema[]>([])
  const schemaCache = useRef<Record<string, ParamSchema[]>>({})

  // Fetch schema when model changes
  useEffect(() => {
    const modelId = generationOptions.modelId
    if (!modelId || !apiUrl) {
      setSchema([])
      return
    }

    // Use cache if available
    if (schemaCache.current[modelId]) {
      setSchema(schemaCache.current[modelId])
      initDefaults(schemaCache.current[modelId])
      return
    }

    fetch(`${apiUrl}/model/params?model_id=${encodeURIComponent(modelId)}`)
      .then((res) => res.json())
      .then((params: ParamSchema[]) => {
        schemaCache.current[modelId] = params
        setSchema(params)
        initDefaults(params)
      })
      .catch(() => setSchema([]))
  }, [generationOptions.modelId, apiUrl])

  function initDefaults(params: ParamSchema[]) {
    const current = generationOptions.modelParams
    const defaults: Record<string, any> = {}
    for (const p of params) {
      if (!(p.id in current)) {
        defaults[p.id] = p.default
      }
    }
    if (Object.keys(defaults).length > 0) {
      setGenerationOptions({ modelParams: { ...current, ...defaults } })
    }
  }

  function setModelParam(id: string, value: any) {
    setGenerationOptions({
      modelParams: { ...generationOptions.modelParams, [id]: value },
    })
  }

  // ─── Load models list ──────────────────────────────────────────────────────

  const { getAllModelsStatus } = useApi()

  useEffect(() => {
    if (!apiUrl) return
    getAllModelsStatus()
      .then((statuses) => {
        const list = statuses
          .filter((s) => s.downloaded)
          .map((s) => ({ id: s.id, name: s.name ?? s.id }))
        setModels(list)
        if (list.length === 0) {
          setGenerationOptions({ modelId: '' })
        } else if (!generationOptions.modelId || !list.find((m) => m.id === generationOptions.modelId)) {
          setGenerationOptions({ modelId: list[0].id })
        }
      })
      .catch(() => {})
  }, [apiUrl])

  return (
    <>
    <div className={`flex flex-col px-4 pb-4 gap-3 ${isDisabled ? 'opacity-50 pointer-events-none' : ''}`}>
      <div className="h-px bg-zinc-800" />
      <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Options</h2>

      {/* Model */}
      <div className="flex flex-col gap-1.5">
        <FieldLabel
          label="Model"
          tooltip="The AI model used to generate the 3D mesh from your image. Only downloaded models are shown."
        />
        <ModelSelect
          models={models}
          value={generationOptions.modelId}
          onChange={(id) => setGenerationOptions({ modelId: id, modelParams: {} })}
        />
      </div>

      {/* Remesh */}
      <div className="flex flex-col gap-1.5">
        <FieldLabel
          label="Remesh"
          tooltip="Quad-Dominant regularizes the surface for cleaner downstream edits, but it is not character retopology. Triangle is faster and more compatible. None skips remeshing entirely."
        />
        <div className="flex gap-1.5">
          {REMESH_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setGenerationOptions({ remesh: opt.value })}
              className={`flex-1 py-1.5 text-xs rounded-lg transition-colors ${
                generationOptions.remesh === opt.value
                  ? 'bg-accent text-white'
                  : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Dynamic model params */}
      {schema.map((param) => (
        <DynamicParam
          key={param.id}
          schema={param}
          value={generationOptions.modelParams[param.id] ?? param.default}
          onChange={(val) => setModelParam(param.id, val)}
        />
      ))}

      {/* Separator */}
      <div className="flex items-center gap-2 pt-1">
        <div className="h-px flex-1 bg-zinc-800" />
        <span className="text-xs font-semibold uppercase tracking-widest text-zinc-600">Texture</span>
        <div className="h-px flex-1 bg-zinc-800" />
      </div>

      {/* Texture */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center w-full">
          <span className="text-sm text-zinc-300">Generate Texture</span>
          <button
            role="checkbox"
            aria-checked={generationOptions.enableTexture}
            onClick={() => {
              if (!generationOptions.enableTexture) {
                setShowTextureWarning(true)
              } else {
                setGenerationOptions({ enableTexture: false })
              }
            }}
            className={`ml-2 w-9 h-5 rounded-full transition-colors relative flex-shrink-0 ${
              generationOptions.enableTexture ? 'bg-accent' : 'bg-zinc-700'
            }`}
          >
            <span className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white shadow transition-all ${
              generationOptions.enableTexture ? 'left-[18px]' : 'left-0.5'
            }`} />
          </button>
          <span className="ml-auto">
            <Tooltip content="Bake UV-mapped textures onto the mesh. Requires uv_unwrapper and texture_baker to be compiled.">
              <span className="w-5 h-5 rounded-full flex items-center justify-center text-zinc-600 hover:text-accent-light transition-colors cursor-default select-none">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="16" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12.01" y2="8" />
                </svg>
              </span>
            </Tooltip>
          </span>
        </div>

        <div className={`flex flex-col gap-1 transition-opacity ${generationOptions.enableTexture ? '' : 'opacity-40'}`}>
            <FieldLabel
              label="Texture Resolution"
              tooltip="Width and height of the baked texture in pixels. Higher values give more detail but take longer. Must be between 64 and 2048."
            />
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={64}
                max={2048}
                step={64}
                value={textureResolutionRaw}
                disabled={!generationOptions.enableTexture}
                onChange={(e) => setTextureResolutionRaw(e.target.value)}
                onBlur={() => {
                  const v = parseInt(textureResolutionRaw)
                  const clamped = isNaN(v) ? 512 : Math.max(64, Math.min(2048, v))
                  setTextureResolutionRaw(String(clamped))
                  setGenerationOptions({ textureResolution: clamped })
                }}
                className="w-full px-3 py-1.5 text-xs rounded-lg bg-zinc-900 border border-zinc-700/60 text-zinc-200 focus:outline-none focus:border-zinc-500 disabled:cursor-not-allowed [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
              <span className="text-xs text-zinc-600 flex-shrink-0">px</span>
            </div>
          </div>
      </div>

    </div>

    {showTextureWarning && (
      <ConfirmModal
        title="Texture generation is experimental"
        description="This feature is still in development and may produce unexpected results, crash, or significantly slow down generation. Use at your own risk."
        confirmLabel="Enable anyway"
        cancelLabel="Cancel"
        onConfirm={() => {
          setGenerationOptions({ enableTexture: true })
          setShowTextureWarning(false)
        }}
        onCancel={() => setShowTextureWarning(false)}
      />
    )}
    </>
  )
}

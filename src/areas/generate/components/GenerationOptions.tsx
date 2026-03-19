import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '@shared/stores/appStore'
import { FieldLabel, Tooltip, ConfirmModal } from '@shared/components/ui'

import type { CatalogModel } from '../models'

const QUALITY_PRESETS = [
  { label: 'Low',    vertexCount: 5000  },
  { label: 'Medium', vertexCount: 10000 },
  { label: 'High',   vertexCount: 20000 },
] as const

const REMESH_OPTIONS = [
  { label: 'Quad',     value: 'quad'     },
  { label: 'Triangle', value: 'triangle' },
  { label: 'None',     value: 'none'     },
] as const

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

const CUSTOM_MAX = 100_000

export default function GenerationOptions(): JSX.Element {
  const { generationOptions, setGenerationOptions, currentJob } = useAppStore()
  const [models, setModels] = useState<CatalogModel[]>([])
  const [textureResolutionRaw, setTextureResolutionRaw] = useState(
    String(generationOptions.textureResolution ?? 512)
  )

  const isDisabled = currentJob?.status === 'uploading' || currentJob?.status === 'generating'
  const [showTextureWarning, setShowTextureWarning] = useState(false)

  useEffect(() => {
    window.electron.model.listDownloaded()
      .then((list) => {
        setModels(list)
        if (list.length > 0 && (!generationOptions.modelId || !list.find((m) => m.id === generationOptions.modelId))) {
          setGenerationOptions({ modelId: list[0].id })
        }
      })
      .catch(() => {})
  }, [])

  const currentQuality = QUALITY_PRESETS.find((p) => p.vertexCount === generationOptions.vertexCount)
  const isCustomMode = !currentQuality
  const [showCustom, setShowCustom] = useState(isCustomMode)
  const [customRaw, setCustomRaw] = useState(String(generationOptions.vertexCount))

  function commitCustomValue(raw: string) {
    const parsed = parseInt(raw, 10)
    const clamped = isNaN(parsed) ? 10000 : Math.max(1, Math.min(CUSTOM_MAX, parsed))
    setCustomRaw(String(clamped))
    setGenerationOptions({ vertexCount: clamped })
  }

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
          onChange={(id) => setGenerationOptions({ modelId: id })}
        />
      </div>

      {/* Mesh quality — temporarily hidden for the communication video
           (no effect on Hunyuan3D 2 Mini)
      <div className="flex flex-col gap-1.5">
        <FieldLabel
          label="Mesh Quality"
          tooltip="Controls the number of vertices in the generated mesh. Higher quality produces more detail but takes longer and uses more memory."
        >
          <span className="text-xs text-zinc-600">
            {showCustom
              ? `(${generationOptions.vertexCount.toLocaleString()} vertices)`
              : `(${(generationOptions.vertexCount / 1000).toFixed(0)}k vertices)`
            }
          </span>
        </FieldLabel>
        <div className="flex gap-1.5">
          {QUALITY_PRESETS.map((preset) => (
            <button
              key={preset.vertexCount}
              onClick={() => {
                setShowCustom(false)
                setGenerationOptions({ vertexCount: preset.vertexCount })
              }}
              className={`flex-1 py-1.5 text-xs rounded-lg transition-colors ${
                !showCustom && currentQuality?.vertexCount === preset.vertexCount
                  ? 'bg-accent text-white'
                  : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
              }`}
            >
              {preset.label}
            </button>
          ))}
          <button
            onClick={() => {
              setShowCustom(true)
              setCustomRaw(String(generationOptions.vertexCount))
            }}
            className={`flex-1 py-1.5 text-xs rounded-lg transition-colors ${
              showCustom
                ? 'bg-accent text-white'
                : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
            }`}
          >
            Custom
          </button>
        </div>
        {showCustom && (
          <div className="flex items-center gap-2 mt-0.5">
            <input
              type="number"
              min={1}
              max={CUSTOM_MAX}
              value={customRaw}
              onChange={(e) => setCustomRaw(e.target.value)}
              onBlur={(e) => commitCustomValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') commitCustomValue(customRaw) }}
              className="w-full px-3 py-1.5 text-xs rounded-lg bg-zinc-900 border border-zinc-700/60 text-zinc-200 focus:outline-none focus:border-zinc-500 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            />
            <span className="text-xs text-zinc-600 flex-shrink-0 whitespace-nowrap">max {(CUSTOM_MAX / 1000).toFixed(0)}k</span>
          </div>
        )}
      </div>
      */}

      {/* Remesh */}
      <div className="flex flex-col gap-1.5">
        <FieldLabel
          label="Remesh"
          tooltip="Quad produces clean topology ideal for animation and sculpting. Triangle is faster and more compatible. None skips remeshing entirely."
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

      {/* Inference steps — Hunyuan models only */}
      {generationOptions.modelId.startsWith('hunyuan') && (
        <div className="flex flex-col gap-1.5">
          <FieldLabel
            label="Quality"
            tooltip="Number of diffusion sampling steps. More steps = better geometry but slower generation."
          />
          <div className="flex gap-1.5">
            {([
              { label: 'Fast',     value: 10 },
              { label: 'Balanced', value: 30 },
              { label: 'High',     value: 50 },
            ] as const).map((opt) => (
              <button
                key={opt.value}
                onClick={() => setGenerationOptions({ numInferenceSteps: opt.value })}
                className={`flex-1 py-1.5 text-xs rounded-lg transition-colors ${
                  generationOptions.numInferenceSteps === opt.value
                    ? 'bg-accent text-white'
                    : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Octree resolution — Hunyuan models only */}
      {generationOptions.modelId.startsWith('hunyuan') && (
        <div className="flex flex-col gap-1.5">
          <FieldLabel
            label="Mesh Resolution"
            tooltip="Controls the octree resolution used during shape generation. Higher values produce a smoother, more detailed surface but use more VRAM and take longer."
          />
          <div className="flex gap-1.5">
            {([
              { label: 'Low',    value: 256 },
              { label: 'Medium', value: 380 },
              { label: 'High',   value: 512 },
            ] as const).map((opt) => (
              <button
                key={opt.value}
                onClick={() => setGenerationOptions({ octreeResolution: opt.value })}
                className={`flex-1 py-1.5 text-xs rounded-lg transition-colors ${
                  generationOptions.octreeResolution === opt.value
                    ? 'bg-accent text-white'
                    : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Guidance Scale + Seed — Hunyuan models only */}
      {generationOptions.modelId.startsWith('hunyuan') && (
        <>
          <div className="flex flex-col gap-1.5">
            <FieldLabel
              label="Guidance Scale"
              tooltip="Controls how closely the model follows your image. Higher = more faithful to the reference, lower = more creative freedom. Recommended: 5–7."
            />
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={1}
                max={10}
                step={0.5}
                value={generationOptions.guidanceScale}
                onChange={(e) => setGenerationOptions({ guidanceScale: Number(e.target.value) })}
                className="flex-1 accent-violet-500"
              />
              <span className="text-xs tabular-nums text-zinc-300 w-6 text-right">
                {generationOptions.guidanceScale}
              </span>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <FieldLabel
              label="Seed"
              tooltip="Random seed for reproducibility. Set to -1 for a random result each time, or enter a fixed value to reproduce a specific generation."
            />
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={-1}
                max={2147483647}
                value={generationOptions.seed}
                onChange={(e) => setGenerationOptions({ seed: parseInt(e.target.value) || -1 })}
                className="w-full px-3 py-1.5 text-xs rounded-lg bg-zinc-900 border border-zinc-700/60 text-zinc-200 focus:outline-none focus:border-zinc-500 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
              <button
                onClick={() => setGenerationOptions({ seed: Math.floor(Math.random() * 2147483647) })}
                title="Random seed"
                className="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="17 1 21 5 17 9" />
                  <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                  <polyline points="7 23 3 19 7 15" />
                  <path d="M21 13v2a4 4 0 0 1-4 4H3" />
                </svg>
              </button>
            </div>
          </div>
        </>
      )}

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

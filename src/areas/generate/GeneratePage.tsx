import { useState, useRef, useCallback, useEffect } from 'react'
import { useAppStore } from '@shared/stores/appStore'
import type { GenerationJob } from '@shared/stores/appStore'
import { useApi } from '@shared/hooks/useApi'
import { ColorPicker } from '@shared/components/ui'
import GenerationHUD from './components/GenerationHUD'
import Viewer3D from './components/Viewer3D'
import WorkflowPanel from './components/WorkflowPanel'

const MIN_WIDTH = 220
const MAX_WIDTH = 520
const DEFAULT_WIDTH = 320

// ---------------------------------------------------------------------------
// Export dropdown
// ---------------------------------------------------------------------------

const EXPORT_FORMATS = [
  { fmt: 'glb' as const, desc: 'Binary glTF' },
  { fmt: 'obj' as const, desc: 'Wavefront' },
  { fmt: 'stl' as const, desc: '3D Print' },
  { fmt: 'ply' as const, desc: 'Polygon File' },
]

function ExportDropdown({
  onExport,
  onClose,
}: {
  onExport: (f: 'glb' | 'obj' | 'stl' | 'ply') => void
  onClose: () => void
}) {
  return (
    <div className="absolute top-full left-0 mt-1 z-50 bg-zinc-900 border border-zinc-700/60 rounded-xl p-1 flex flex-col gap-0.5 min-w-[150px] shadow-xl">
      {EXPORT_FORMATS.map(({ fmt, desc }) => (
        <button
          key={fmt}
          onClick={() => { onExport(fmt); onClose() }}
          className="px-3 py-2 text-left hover:bg-zinc-800 rounded-lg transition-colors flex items-center gap-2.5"
        >
          <span className="text-xs font-mono font-semibold text-zinc-200">.{fmt}</span>
          <span className="text-[10px] text-zinc-500">{desc}</span>
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Decimate popover
// ---------------------------------------------------------------------------

function DecimatePopover({
  currentTriangles,
  decimating,
  onDecimate,
  onClose,
}: {
  currentTriangles: number | null
  decimating: boolean
  onDecimate: (targetFaces: number) => void
  onClose: () => void
}) {
  const defaultTarget = currentTriangles ? Math.round(currentTriangles * 0.5) : 5000
  const [inputValue, setInputValue] = useState(String(defaultTarget))

  const parsed = parseInt(inputValue, 10)
  const validTarget = !isNaN(parsed) && parsed >= 100 ? parsed : null
  const reduction =
    currentTriangles && validTarget
      ? Math.round((1 - Math.min(validTarget, currentTriangles) / currentTriangles) * 100)
      : null

  return (
    <div className="absolute top-full left-0 mt-1 z-50 bg-zinc-900 border border-zinc-700/60 rounded-xl p-3 flex flex-col gap-3 min-w-[200px] shadow-xl">
      <p className="text-[10px] text-zinc-500 uppercase tracking-wider">Decimate mesh</p>

      {currentTriangles && (
        <p className="text-[10px] text-zinc-500">
          Current: <span className="text-zinc-300">{currentTriangles.toLocaleString()} tri</span>
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        <label className="text-[10px] text-zinc-500">Target faces</label>
        <input
          type="number"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          min={100}
          step={500}
          className="bg-zinc-800 border border-zinc-700 rounded-lg px-2.5 py-1.5 text-xs text-zinc-200 w-full focus:outline-none focus:border-violet-500 transition-colors"
        />
        {reduction !== null && (
          <p className="text-[10px] text-zinc-500">
            Reduction: <span className="text-violet-400">{reduction}%</span>
          </p>
        )}
      </div>

      <div className="flex gap-2">
        <button
          onClick={onClose}
          className="flex-1 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={() => validTarget && onDecimate(validTarget)}
          disabled={decimating || !validTarget}
          className="flex-1 px-3 py-1.5 bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-xs rounded-lg transition-colors flex items-center justify-center gap-1.5 font-medium"
        >
          {decimating ? (
            <>
              <svg className="animate-spin" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
              Processing…
            </>
          ) : 'Apply'}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Light popover
// ---------------------------------------------------------------------------

export interface LightSettings {
  ambientIntensity: number
  ambientColor: string
  mainIntensity: number
  mainColor: string
  fillIntensity: number
  fillColor: string
}

export const DEFAULT_LIGHT_SETTINGS: LightSettings = {
  ambientIntensity: 1.2,
  ambientColor: '#ffffff',
  mainIntensity: 1.5,
  mainColor: '#ffffff',
  fillIntensity: 0.6,
  fillColor: '#ffffff',
}

function LightPopover({
  settings,
  onChange,
  onClose,
}: {
  settings: LightSettings
  onChange: (s: LightSettings) => void
  onClose: () => void
}) {
  function lightRow(
    label: string,
    colorKey: keyof LightSettings,
    intensityKey: keyof LightSettings,
    max: number,
  ) {
    const intensity = settings[intensityKey] as number
    const color = settings[colorKey] as string
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <ColorPicker
            value={color}
            onChange={(c) => onChange({ ...settings, [colorKey]: c })}
          />
          <span className="text-[10px] text-zinc-400 flex-1">{label}</span>
          <span className="text-[10px] text-zinc-500 font-mono">{intensity.toFixed(1)}</span>
        </div>
        <input
          type="range"
          min={0}
          max={max}
          step={0.1}
          value={intensity}
          onChange={(e) => onChange({ ...settings, [intensityKey]: parseFloat(e.target.value) })}
          className="w-full h-1.5 accent-violet-500 cursor-pointer"
        />
      </div>
    )
  }

  return (
    <div className="absolute top-full right-0 mt-1 z-50 bg-zinc-900 border border-zinc-700/60 rounded-xl p-3 flex flex-col gap-3 min-w-[220px] shadow-xl">
      <div className="flex items-center justify-between">
        <p className="text-[10px] text-zinc-500 uppercase tracking-wider">Lighting</p>
        <button
          onClick={() => onChange(DEFAULT_LIGHT_SETTINGS)}
          className="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors"
        >
          Reset
        </button>
      </div>
      {lightRow('Ambient', 'ambientColor', 'ambientIntensity', 3)}
      {lightRow('Sun', 'mainColor', 'mainIntensity', 4)}
      {lightRow('Fill', 'fillColor', 'fillIntensity', 2)}
      <button
        onClick={onClose}
        className="mt-1 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors"
      >
        Close
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Smooth popover
// ---------------------------------------------------------------------------

function SmoothPopover({
  smoothing,
  onSmooth,
  onClose,
}: {
  smoothing: boolean
  onSmooth: (iterations: number) => void
  onClose: () => void
}) {
  const [inputValue, setInputValue] = useState('3')

  const parsed = parseInt(inputValue, 10)
  const valid = !isNaN(parsed) && parsed >= 1 && parsed <= 20

  return (
    <div className="absolute top-full left-0 mt-1 z-50 bg-zinc-900 border border-zinc-700/60 rounded-xl p-3 flex flex-col gap-3 min-w-[190px] shadow-xl">
      <p className="text-[10px] text-zinc-500 uppercase tracking-wider">Smooth mesh</p>

      <div className="flex flex-col gap-1.5">
        <label className="text-[10px] text-zinc-500">Iterations <span className="text-zinc-600">(1–20)</span></label>
        <input
          type="number"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          min={1}
          max={20}
          step={1}
          className="bg-zinc-800 border border-zinc-700 rounded-lg px-2.5 py-1.5 text-xs text-zinc-200 w-full focus:outline-none focus:border-violet-500 transition-colors"
        />
        <p className="text-[10px] text-zinc-600">More iterations = smoother, but loses detail</p>
      </div>

      <div className="flex gap-2">
        <button
          onClick={onClose}
          className="flex-1 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={() => valid && onSmooth(parsed)}
          disabled={smoothing || !valid}
          className="flex-1 px-3 py-1.5 bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-xs rounded-lg transition-colors flex items-center justify-center gap-1.5 font-medium"
        >
          {smoothing ? (
            <>
              <svg className="animate-spin" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
              Processing…
            </>
          ) : 'Apply'}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// GeneratePage
// ---------------------------------------------------------------------------

export default function GeneratePage(): JSX.Element {
  const [unloadStatus, setUnloadStatus] = useState<'idle' | 'done'>('idle')
  const [panelWidth, setPanelWidth] = useState(DEFAULT_WIDTH)
  const [openPanel, setOpenPanel] = useState<'export' | 'decimate' | 'smooth' | 'import' | 'light' | null>(null)
  const [lightSettings, setLightSettings] = useState<LightSettings>(DEFAULT_LIGHT_SETTINGS)
  const [decimating, setDecimating] = useState(false)
  const [smoothing, setSmoothing] = useState(false)
  const [importing, setImporting] = useState(false)
  const dragging = useRef(false)

  const isGenerating = useAppStore((s) =>
    s.currentJob?.status === 'uploading' || s.currentJob?.status === 'generating'
  )
  const currentJob = useAppStore((s) => s.currentJob)
  const apiUrl = useAppStore((s) => s.apiUrl)
  const updateCurrentJob = useAppStore((s) => s.updateCurrentJob)
  const setCurrentJob = useAppStore((s) => s.setCurrentJob)
  const meshStats = useAppStore((s) => s.meshStats)
  const pushMeshUrl = useAppStore((s) => s.pushMeshUrl)
  const undoMesh = useAppStore((s) => s.undoMesh)
  const redoMesh = useAppStore((s) => s.redoMesh)
  const canUndo = useAppStore((s) => s.historyIndex > 0)
  const canRedo = useAppStore((s) => s.historyIndex < s.meshHistory.length - 1)
  const { optimizeMesh, smoothMesh, importMesh } = useApi()

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      if (e.key === 'z') { e.preventDefault(); undoMesh() }
      if (e.key === 'y') { e.preventDefault(); redoMesh() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [undoMesh, redoMesh])

  const hasModel = currentJob?.status === 'done' && !!currentJob.outputUrl

  async function handleUnloadAll() {
    await window.electron.model.unloadAll()
    setUnloadStatus('done')
    setTimeout(() => setUnloadStatus('idle'), 2000)
  }

  function handleExport(format: 'glb' | 'obj' | 'stl' | 'ply') {
    if (!currentJob?.outputUrl) return
    const stem = `modly-${Date.now()}`
    const link = document.createElement('a')
    if (format === 'glb') {
      link.href = `${apiUrl}${currentJob.outputUrl}`
    } else {
      const path = encodeURIComponent(currentJob.outputUrl.replace('/workspace/', ''))
      link.href = `${apiUrl}/optimize/export?path=${path}&format=${format}`
    }
    link.download = `${stem}.${format}`
    link.click()
  }

  async function handleImportMesh() {
    const filePath = await window.electron.fs.selectMeshFile()
    if (!filePath) return
    setOpenPanel(null)
    setImporting(true)
    try {
      const { url } = await importMesh(filePath)
      const job: GenerationJob = {
        id: `import-${Date.now()}`,
        imageFile: '',
        status: 'done',
        progress: 100,
        outputUrl: url,
        originalOutputUrl: url,
        createdAt: Date.now(),
      }
      setCurrentJob(job)
      pushMeshUrl(url)
    } finally {
      setImporting(false)
    }
  }

  async function handleSmooth(iterations: number) {
    if (!currentJob?.outputUrl) return
    setSmoothing(true)
    try {
      const path = currentJob.outputUrl.replace('/workspace/', '')
      const { url } = await smoothMesh(path, iterations)
      updateCurrentJob({ outputUrl: url })
      pushMeshUrl(url)
      setOpenPanel(null)
    } finally {
      setSmoothing(false)
    }
  }

  async function handleDecimate(targetFaces: number) {
    if (!currentJob?.outputUrl) return
    setDecimating(true)
    try {
      const path = currentJob.outputUrl.replace('/workspace/', '')
      const { url } = await optimizeMesh(path, targetFaces)
      updateCurrentJob({ outputUrl: url })
      pushMeshUrl(url)
      setOpenPanel(null)
    } finally {
      setDecimating(false)
    }
  }

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return
      setPanelWidth((w) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w + ev.movementX)))
    }
    const onMouseUp = () => {
      dragging.current = false
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }, [])

  return (
    <>
      <div className="flex flex-col border-r border-zinc-800 bg-surface-400 overflow-hidden shrink-0" style={{ width: panelWidth }}>
        <WorkflowPanel />
      </div>

      {/* Resize handle */}
      <div
        onMouseDown={onMouseDown}
        className="w-1 shrink-0 cursor-col-resize hover:bg-accent/40 active:bg-accent/60 transition-colors"
      />

      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header bar */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 bg-surface-400 shrink-0">

          {/* Undo / Redo */}
          <button
            onClick={undoMesh}
            disabled={!canUndo}
            title="Undo (Ctrl+Z)"
            className="flex items-center justify-center w-7 h-7 rounded-lg text-[11px] font-medium bg-zinc-800 border border-zinc-700/50 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 transition-colors disabled:opacity-30 disabled:pointer-events-none"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
              <path d="M3 7v6h6" />
              <path d="M3 13a9 9 0 1 0 2.28-5.93" />
            </svg>
          </button>
          <button
            onClick={redoMesh}
            disabled={!canRedo}
            title="Redo (Ctrl+Y)"
            className="flex items-center justify-center w-7 h-7 rounded-lg text-[11px] font-medium bg-zinc-800 border border-zinc-700/50 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 transition-colors disabled:opacity-30 disabled:pointer-events-none"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
              <path d="M21 7v6h-6" />
              <path d="M21 13a9 9 0 1 1-2.28-5.93" />
            </svg>
          </button>

          <div className="w-px h-4 bg-zinc-700/60" />

          {/* Import */}
          <div className="relative">
            <button
              onClick={() => setOpenPanel((p) => (p === 'import' ? null : 'import'))}
              disabled={importing}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium border transition-colors disabled:opacity-50 disabled:pointer-events-none
                ${openPanel === 'import'
                  ? 'bg-zinc-700 border-zinc-600 text-zinc-200'
                  : 'bg-zinc-800 border-zinc-700/50 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'
                }`}
            >
              {importing ? (
                <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 5 17 10" />
                  <line x1="12" y1="5" x2="12" y2="15" />
                </svg>
              )}
              {importing ? 'Importing…' : 'Import'}
              {!importing && (
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              )}
            </button>
            {openPanel === 'import' && (
              <div className="absolute top-full left-0 mt-1 z-50 bg-zinc-900 border border-zinc-700/60 rounded-xl p-1 flex flex-col gap-0.5 min-w-[140px] shadow-xl">
                <button
                  onClick={handleImportMesh}
                  className="px-3 py-2 text-left hover:bg-zinc-800 rounded-lg transition-colors flex items-center gap-2.5"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="text-zinc-400">
                    <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
                  </svg>
                  <div>
                    <p className="text-xs text-zinc-200">Mesh</p>
                    <p className="text-[10px] text-zinc-500">.glb .obj .stl .ply</p>
                  </div>
                </button>
              </div>
            )}
          </div>

          {hasModel && (
            <>
              <div className="w-px h-4 bg-zinc-700/60" />

              {/* Export */}
              <div className="relative">
                <button
                  onClick={() => setOpenPanel((p) => (p === 'export' ? null : 'export'))}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium border transition-colors
                    ${openPanel === 'export'
                      ? 'bg-zinc-700 border-zinc-600 text-zinc-200'
                      : 'bg-zinc-800 border-zinc-700/50 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'
                    }`}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  Export
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
                {openPanel === 'export' && (
                  <ExportDropdown
                    onExport={handleExport as (f: 'glb' | 'obj' | 'stl' | 'ply') => void}
                    onClose={() => setOpenPanel(null)}
                  />
                )}
              </div>

              {/* Smooth */}
              <div className="relative">
                <button
                  onClick={() => setOpenPanel((p) => (p === 'smooth' ? null : 'smooth'))}
                  disabled={smoothing}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium border transition-colors disabled:opacity-50 disabled:pointer-events-none
                    ${openPanel === 'smooth' || smoothing
                      ? 'bg-zinc-700 border-zinc-600 text-zinc-200'
                      : 'bg-zinc-800 border-zinc-700/50 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'
                    }`}
                >
                  {smoothing ? (
                    <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                    </svg>
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  )}
                  {smoothing ? 'Processing…' : 'Smooth'}
                </button>
                {openPanel === 'smooth' && (
                  <SmoothPopover
                    smoothing={smoothing}
                    onSmooth={handleSmooth}
                    onClose={() => setOpenPanel(null)}
                  />
                )}
              </div>

              {/* Decimate */}
              <div className="relative">
                <button
                  onClick={() => setOpenPanel((p) => (p === 'decimate' ? null : 'decimate'))}
                  disabled={decimating}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium border transition-colors disabled:opacity-50 disabled:pointer-events-none
                    ${openPanel === 'decimate' || decimating
                      ? 'bg-zinc-700 border-zinc-600 text-zinc-200'
                      : 'bg-zinc-800 border-zinc-700/50 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'
                    }`}
                >
                  {decimating ? (
                    <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                    </svg>
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                      <polygon points="12 2 22 20 2 20" />
                      <line x1="12" y1="9" x2="8" y2="17" />
                      <line x1="12" y1="9" x2="16" y2="17" />
                      <line x1="8" y1="17" x2="16" y2="17" />
                    </svg>
                  )}
                  {decimating ? 'Processing…' : 'Decimate'}
                </button>
                {openPanel === 'decimate' && (
                  <DecimatePopover
                    currentTriangles={meshStats?.triangles ?? null}
                    decimating={decimating}
                    onDecimate={handleDecimate}
                    onClose={() => setOpenPanel(null)}
                  />
                )}
              </div>

            </>
          )}

          {/* Light — always visible, pushed to the right */}
          <div className="relative ml-auto">
            <button
              onClick={() => setOpenPanel((p) => (p === 'light' ? null : 'light'))}
              title="Lighting"
              className={`flex items-center justify-center w-7 h-7 rounded-lg border transition-colors
                ${openPanel === 'light'
                  ? 'bg-zinc-700 border-zinc-600 text-zinc-200'
                  : 'bg-zinc-800 border-zinc-700/50 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'
                }`}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                <circle cx="12" cy="12" r="4" />
                <line x1="12" y1="2" x2="12" y2="5" />
                <line x1="12" y1="19" x2="12" y2="22" />
                <line x1="4.22" y1="4.22" x2="6.34" y2="6.34" />
                <line x1="17.66" y1="17.66" x2="19.78" y2="19.78" />
                <line x1="2" y1="12" x2="5" y2="12" />
                <line x1="19" y1="12" x2="22" y2="12" />
                <line x1="4.22" y1="19.78" x2="6.34" y2="17.66" />
                <line x1="17.66" y1="6.34" x2="19.78" y2="4.22" />
              </svg>
            </button>
            {openPanel === 'light' && (
              <LightPopover
                settings={lightSettings}
                onChange={setLightSettings}
                onClose={() => setOpenPanel(null)}
              />
            )}
          </div>
        </div>

        {/* Viewer area */}
        <div className="flex-1 relative overflow-hidden">
          <Viewer3D lightSettings={lightSettings} />
          <GenerationHUD />

          {/* Free memory — overlay top-left */}
          <button
            onClick={handleUnloadAll}
            disabled={isGenerating}
            title="Free model from memory"
            className="absolute top-3 left-3 z-20 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-zinc-900/70 border border-zinc-700/50 backdrop-blur-sm text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 transition-colors disabled:opacity-30 disabled:pointer-events-none"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
              <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
            </svg>
            {unloadStatus === 'done' ? 'Freed' : 'Free memory'}
          </button>
        </div>
      </div>
    </>
  )
}

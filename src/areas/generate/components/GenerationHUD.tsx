import { useEffect, useRef, useState } from 'react'
import { useGeneration } from '@shared/hooks/useGeneration'
import { useAppStore } from '@shared/stores/appStore'
import { useApi } from '@shared/hooks/useApi'

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

export default function GenerationHUD(): JSX.Element | null {
  const { currentJob, reset } = useGeneration()
  const apiUrl = useAppStore((s) => s.apiUrl)
  const meshStats = useAppStore((s) => s.meshStats)
  const updateCurrentJob = useAppStore((s) => s.updateCurrentJob)
  const { optimizeMesh } = useApi()

  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef<number | null>(null)
  const [exportFormat, setExportFormat] = useState('glb')
  const [exporting, setExporting] = useState(false)
  const [tqdmLog, setTqdmLog] = useState<string | null>(null)

  async function handleExport() {
    if (!currentJob?.outputUrl || exporting) return
    setExporting(true)
    await window.electron.model.export({ outputUrl: currentJob.outputUrl, format: exportFormat })
    setExporting(false)
  }

  const maxFaces = meshStats?.triangles ?? 50000
  const [targetFaces, setTargetFaces] = useState(Math.round(maxFaces / 2))
  const [optimizing, setOptimizing] = useState(false)
  const [originalUrl, setOriginalUrl] = useState<string | null>(null)
  const [optimizedUrl, setOptimizedUrl] = useState<string | null>(null)
  const [showingOptimized, setShowingOptimized] = useState(false)

  // Reset optimization state when a new model is loaded
  useEffect(() => {
    setTargetFaces(Math.round(maxFaces / 2))
    setOriginalUrl(null)
    setOptimizedUrl(null)
    setShowingOptimized(false)
  }, [maxFaces])

  const handleOptimize = async () => {
    if (!currentJob?.outputUrl) return
    // Always decimate from the original to avoid chaining degradation
    const baseUrl = originalUrl ?? currentJob.outputUrl
    const path = baseUrl.replace('/workspace/', '')
    setOptimizing(true)
    try {
      const { url } = await optimizeMesh(path, targetFaces)
      if (!originalUrl) setOriginalUrl(currentJob.outputUrl)
      setOptimizedUrl(url)
      setShowingOptimized(true)
      updateCurrentJob({ outputUrl: url })
    } finally {
      setOptimizing(false)
    }
  }

  const handleToggle = (wantOptimized: boolean) => {
    if (!originalUrl || !optimizedUrl) return
    setShowingOptimized(wantOptimized)
    updateCurrentJob({ outputUrl: wantOptimized ? optimizedUrl : originalUrl })
  }

  const status = currentJob?.status
  const isActive = status === 'uploading' || status === 'generating'
  const isVisible = status === 'uploading' || status === 'generating' || status === 'done' || status === 'error'

  // Elapsed timer
  useEffect(() => {
    if (isActive) {
      if (!startRef.current) startRef.current = Date.now()
      const id = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startRef.current!) / 1000))
      }, 1000)
      return () => clearInterval(id)
    } else {
      startRef.current = null
      setElapsed(0)
    }
  }, [isActive])

  // tqdm log listener
  useEffect(() => {
    if (isActive) {
      setTqdmLog(null)
      window.electron.python.onLog((line) => setTqdmLog(line))
      return () => { window.electron.python.offLog(); setTqdmLog(null) }
    }
  }, [isActive])

  if (!currentJob || !isVisible) return null

  const { progress, step, error, outputUrl } = currentJob

  return (
    <div className="absolute bottom-8 left-1/2 animate-slide-up z-20 w-96 pointer-events-auto">
      <div className="bg-zinc-900/95 backdrop-blur-md border border-zinc-700/60 rounded-2xl shadow-2xl overflow-hidden">

        {/* Generating / uploading */}
        {isActive && (
          <div className="px-5 py-4 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
                <span className="text-sm font-medium text-zinc-200">
                  {step ?? (status === 'uploading' ? 'Reading image…' : 'Generating 3D mesh…')}
                </span>
              </div>
              <span className="text-xs tabular-nums text-zinc-500">{formatElapsed(elapsed)}</span>
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-accent rounded-full transition-all duration-700 ease-out"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <div className="flex items-center justify-between gap-2">
                {tqdmLog && (
                  <span className="text-[11px] text-zinc-500 truncate font-mono">{tqdmLog}</span>
                )}
                <span className="text-xs text-zinc-600 tabular-nums shrink-0 ml-auto">{progress}%</span>
              </div>
            </div>
          </div>
        )}

        {/* Done */}
        {status === 'done' && (
          <div className="px-5 py-4 flex flex-col gap-4 animate-fade-in">
            {/* Header row */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-6 h-6 rounded-full bg-green-500/15 border border-green-500/30 flex items-center justify-center shrink-0">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-green-400">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
                <span className="text-sm font-medium text-zinc-200">Generation complete</span>
              </div>
              {meshStats && (
                <span className="text-xs text-zinc-500 tabular-nums">
                  {meshStats.triangles.toLocaleString()} tri
                </span>
              )}
            </div>

            <div className="border-t border-zinc-800 pt-3 flex flex-col gap-2.5">

              {/* Toggle original / optimized */}
              {optimizedUrl && (
                <div className="flex items-center gap-1 self-start bg-zinc-800 rounded-lg p-0.5">
                  <button
                    onClick={() => handleToggle(false)}
                    className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${!showingOptimized ? 'bg-zinc-600 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}
                  >
                    Original
                  </button>
                  <button
                    onClick={() => handleToggle(true)}
                    className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${showingOptimized ? 'bg-zinc-600 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}
                  >
                    Optimized
                  </button>
                </div>
              )}

              {/* Slider + Optimize row */}
              <div className="flex items-center gap-2.5">
                <div className="flex flex-col gap-1 flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-zinc-500">Polygons</span>
                    <span className="text-[11px] tabular-nums text-zinc-400">{targetFaces.toLocaleString()}</span>
                  </div>
                  <input
                    type="range"
                    min={100}
                    max={maxFaces}
                    value={targetFaces}
                    disabled={!meshStats}
                    onChange={(e) => setTargetFaces(Number(e.target.value))}
                    className="w-full accent-violet-500 disabled:opacity-40"
                  />
                </div>
                <button
                  onClick={handleOptimize}
                  disabled={optimizing || !meshStats}
                  className="shrink-0 px-3 py-2.5 rounded-xl bg-accent hover:bg-accent-dark disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium transition-colors"
                >
                  {optimizing ? 'Optimizing…' : 'Optimize'}
                </button>
              </div>

              {/* Export row */}
              <div className="flex gap-1.5">
                <select
                  value={exportFormat}
                  onChange={(e) => setExportFormat(e.target.value)}
                  className="px-2 py-2 rounded-xl bg-zinc-800 border border-zinc-700/50 text-zinc-300 text-xs font-medium focus:outline-none focus:border-zinc-500 transition-colors cursor-pointer"
                >
                  {['glb', 'stl', 'obj', 'ply'].map((f) => (
                    <option key={f} value={f}>{f.toUpperCase()}</option>
                  ))}
                </select>
                <button
                  onClick={handleExport}
                  disabled={exporting}
                  className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed text-zinc-200 text-sm font-medium transition-colors"
                >
                  {exporting ? (
                    <div className="w-3.5 h-3.5 rounded-full border-2 border-zinc-500 border-t-zinc-200 animate-spin" />
                  ) : 'Export'}
                </button>
              </div>

            </div>

            <button
              onClick={reset}
              className="w-full py-2 rounded-xl bg-transparent hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 text-xs font-medium transition-colors"
            >
              New model
            </button>
          </div>
        )}

        {/* Error */}
        {status === 'error' && (
          <div className="px-5 py-4 flex flex-col gap-3 animate-fade-in">
            <div className="flex items-center gap-2.5">
              <div className="w-6 h-6 rounded-full bg-red-500/15 border border-red-500/30 flex items-center justify-center shrink-0">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-red-400">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </div>
              <span className="text-sm font-medium text-zinc-200">Generation failed</span>
            </div>
            <p className="text-xs text-red-400 bg-red-950/40 border border-red-900/40 rounded-lg px-3 py-2 max-h-24 overflow-y-auto whitespace-pre-wrap break-words">
              {error}
            </p>
            <button
              onClick={reset}
              className="w-full py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-sm font-medium transition-colors"
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

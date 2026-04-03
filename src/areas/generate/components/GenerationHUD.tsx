import { useEffect, useState } from 'react'
import { useGeneration } from '@shared/hooks/useGeneration'

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

export default function GenerationHUD(): JSX.Element | null {
  const { currentJob, reset } = useGeneration()
  const [elapsed, setElapsed] = useState(0)
  const [tqdmLog, setTqdmLog] = useState<string | null>(null)

  const status = currentJob?.status
  const isActive = status === 'uploading' || status === 'generating'
  const isVisible = status === 'uploading' || status === 'generating' || status === 'error'

  // Elapsed timer — based on currentJob.createdAt so it survives navigation
  useEffect(() => {
    if (isActive && currentJob?.createdAt) {
      const id = setInterval(() => {
        setElapsed(Math.floor((Date.now() - currentJob.createdAt) / 1000))
      }, 1000)
      return () => clearInterval(id)
    } else {
      setElapsed(0)
    }
  }, [isActive, currentJob?.createdAt])

  // tqdm log listener
  useEffect(() => {
    if (isActive) {
      setTqdmLog(null)
      window.electron.python.onLog((line) => setTqdmLog(line))
      return () => { window.electron.python.offLog(); setTqdmLog(null) }
    }
  }, [isActive])

  if (!currentJob || !isVisible) return null

  const { progress, step, error } = currentJob

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

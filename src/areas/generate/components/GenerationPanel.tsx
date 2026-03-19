import { useEffect, useRef, useState } from 'react'
import { useGeneration } from '@shared/hooks/useGeneration'

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

export default function GenerationPanel(): JSX.Element {
  const { currentJob, reset } = useGeneration()
  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef<number | null>(null)
  const [exportFormat, setExportFormat] = useState('glb')
  const [exporting, setExporting] = useState(false)

  async function handleExport() {
    if (!currentJob?.outputUrl || exporting) return
    setExporting(true)
    await window.electron.model.export({ outputUrl: currentJob.outputUrl, format: exportFormat })
    setExporting(false)
  }

  const status = currentJob?.status
  const isActive = status === 'uploading' || status === 'generating'

  // Elapsed timer — starts when generation begins, resets on idle
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

  if (!currentJob) return <></>

  const { status: jobStatus, progress, step, error } = currentJob

  const statusLabel: Record<string, string> = {
    uploading:  'Reading image…',
    generating: step ?? 'Generating 3D mesh…',
    done:       'Done!',
    error:      'Generation failed',
  }

  return (
    <div className="flex flex-col px-4 pb-4 gap-3">
      <div className="h-px bg-zinc-800" />
      <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Progress</h2>

      {/* Step + timer */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-300">{statusLabel[jobStatus] ?? jobStatus}</p>
        {isActive && (
          <span className="text-xs tabular-nums text-zinc-500">{formatElapsed(elapsed)}</span>
        )}
      </div>

      {/* Progress bar */}
      {isActive && (
        <div className="flex flex-col gap-1.5">
          <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-accent rounded-full transition-all duration-700 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="text-xs text-zinc-600 tabular-nums">{progress}%</span>
        </div>
      )}

      {/* Error */}
      {jobStatus === 'error' && (
        <div className="p-3 bg-red-900/30 border border-red-800 rounded-lg">
          <p className="text-xs text-red-400 whitespace-pre-wrap break-words">{error}</p>
        </div>
      )}

      {/* Done actions */}
      {jobStatus === 'done' && (
        <div className="flex flex-col gap-2">
          <div className="flex gap-1.5">
            <select
              value={exportFormat}
              onChange={(e) => setExportFormat(e.target.value)}
              className="px-2 py-2 rounded-lg bg-zinc-800 border border-zinc-700/50 text-zinc-300 text-xs font-medium focus:outline-none focus:border-zinc-500 transition-colors cursor-pointer"
            >
              {['glb', 'stl', 'obj', 'ply'].map((f) => (
                <option key={f} value={f}>{f.toUpperCase()}</option>
              ))}
            </select>
            <button
              onClick={handleExport}
              disabled={exporting}
              className="flex-1 py-2 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed text-zinc-200 transition-colors"
            >
              {exporting ? 'Exporting…' : 'Export'}
            </button>
          </div>
          <button
            onClick={reset}
            className="w-full py-2 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 transition-colors"
          >
            New
          </button>
        </div>
      )}
    </div>
  )
}

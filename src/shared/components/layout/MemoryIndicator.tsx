import { useEffect, useState } from 'react'
import { useAppStore } from '@shared/stores/appStore'

const GB = 1024 ** 3
const RAM_INTERVAL_MS = 2000
const VRAM_INTERVAL_MS = 2000

interface MemorySample {
  total: number
  used: number
  available: number
}

function fmtGB(bytes: number): string {
  return (bytes / GB).toFixed(1)
}

function getBarColors(pct: number): { barColor: string; textColor: string } {
  if (pct >= 90) return { barColor: 'bg-red-500', textColor: 'text-red-300' }
  if (pct >= 75) return { barColor: 'bg-amber-500', textColor: 'text-amber-300' }
  return { barColor: 'bg-emerald-500', textColor: 'text-zinc-300' }
}

/**
 * Polls `sample` every `intervalMs` while `enabled`, skipping a tick while the
 * previous call is still running. A null or failed sample keeps the last value,
 * so a transient miss does not flicker the bar away. Disabling clears the value.
 */
function useSampler<T>(sample: () => Promise<T | null>, intervalMs: number, enabled: boolean): T | null {
  const [value, setValue] = useState<T | null>(null)

  useEffect(() => {
    if (!enabled) {
      setValue(null)
      return
    }
    let cancelled = false
    let inFlight = false
    const tick = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const next = await sample()
        if (!cancelled && next) setValue(next)
      } catch {
        // Renderer should not break if memory sampling fails.
      } finally {
        inFlight = false
      }
    }
    tick()
    const id = setInterval(tick, intervalMs)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [sample, intervalMs, enabled])

  return value
}

const sampleRam = () => window.electron.system.memory()
const sampleVram = () => window.electron.system.gpuMemory()

function MemoryBar({ label, sample, tooltip }: { label: string; sample: MemorySample; tooltip: string }): JSX.Element {
  const pct = sample.total > 0 ? Math.min(100, Math.round((sample.used / sample.total) * 100)) : 0
  const { barColor, textColor } = getBarColors(pct)
  return (
    <div className="flex items-center gap-2" title={tooltip}>
      <span className="text-[10px] font-medium text-zinc-500 tracking-wide uppercase">{label}</span>
      <div className="w-20 h-1.5 bg-zinc-900 rounded-full overflow-hidden">
        <div
          className={`h-full ${barColor} transition-all duration-500 ease-out`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`text-[11px] tabular-nums ${textColor}`}>
        {fmtGB(sample.used)} / {fmtGB(sample.total)} GB
      </span>
    </div>
  )
}

function tooltipFor(heading: string, sample: MemorySample): string {
  return (
    `${heading}\n` +
    `  Used:      ${fmtGB(sample.used)} GB\n` +
    `  Available: ${fmtGB(sample.available)} GB\n` +
    `  Total:     ${fmtGB(sample.total)} GB`
  )
}

export default function MemoryIndicator(): JSX.Element | null {
  const isMac = useAppStore(s => s.platform === 'darwin')
  const showRam = useAppStore(s => s.showRamIndicator)
  const showVram = useAppStore(s => s.showVramIndicator) && !isMac

  const ram = useSampler(sampleRam, RAM_INTERVAL_MS, showRam)
  const vram = useSampler(sampleVram, VRAM_INTERVAL_MS, showVram)

  const ramBar = showRam && ram ? ram : null
  const vramBar = showVram && vram && vram.total > 0 ? vram : null
  if (!ramBar && !vramBar) return null

  return (
    <div className="flex items-center gap-4 mr-3 px-2.5 py-1 rounded-md bg-zinc-800/60 border border-zinc-700/60 no-drag">
      {ramBar && <MemoryBar label="RAM" sample={ramBar} tooltip={tooltipFor('RAM', ramBar)} />}
      {vramBar && (
        <MemoryBar
          label="VRAM"
          sample={vramBar}
          tooltip={tooltipFor(vramBar.name ? `VRAM — ${vramBar.name}` : 'VRAM', vramBar)}
        />
      )}
    </div>
  )
}

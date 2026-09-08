import { useEffect, useState } from 'react'
import { useAppStore } from '@shared/stores/appStore'

const GB = 1024 ** 3

function fmtGB(bytes: number): string {
  return (bytes / GB).toFixed(1)
}

function getBarColors(pct: number): { barColor: string; textColor: string } {
  if (pct >= 90) return { barColor: 'bg-red-500', textColor: 'text-red-300' }
  if (pct >= 75) return { barColor: 'bg-amber-500', textColor: 'text-amber-300' }
  return { barColor: 'bg-emerald-500', textColor: 'text-zinc-300' }
}

export default function MemoryIndicator(): JSX.Element | null {
  const [ram, setRam] = useState<{ total: number; used: number; available: number } | null>(null)
  const [vram, setVram] = useState<{ total: number; used: number; available: number } | null>(null)
  const platform = useAppStore(s => s.platform)
  const isMac = platform === 'darwin'
  const showVramIndicator = useAppStore(s => s.showVramIndicator)

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const [ramNext, vramNext] = await Promise.all([
          window.electron.system.memory(),
          isMac ? Promise.resolve(null) : window.electron.system.gpuMemory(),
        ])
        if (!cancelled) {
          setRam(ramNext)
          setVram(vramNext)
        }
      } catch {
        // Renderer should not break if memory sampling fails.
      }
    }
    tick()
    const id = setInterval(tick, 2000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [isMac])

  if (!ram) return null

  const ramPct = ram.total > 0 ? Math.min(100, Math.round((ram.used / ram.total) * 100)) : 0
  const ramColors = getBarColors(ramPct)

  const ramTooltip =
    `RAM:\n` +
    `  Used:      ${fmtGB(ram.used)} GB\n` +
    `  Available: ${fmtGB(ram.available)} GB\n` +
    `  Total:     ${fmtGB(ram.total)} GB`

  const vramBar = showVramIndicator && !isMac && vram && vram.total > 0 ? (() => {
    const vramPct = Math.min(100, Math.round((vram.used / vram.total) * 100))
    const vramColors = getBarColors(vramPct)
    const vramTooltip =
      `VRAM:\n` +
      `  Used:      ${fmtGB(vram.used)} GB\n` +
      `  Available: ${fmtGB(vram.available)} GB\n` +
      `  Total:     ${fmtGB(vram.total)} GB`
    return (
      <div className="flex items-center gap-2 ml-4" title={vramTooltip}>
        <span className="text-[10px] font-medium text-zinc-500 tracking-wide uppercase">VRAM</span>
        <div className="w-20 h-1.5 bg-zinc-900 rounded-full overflow-hidden">
          <div
            className={`h-full ${vramColors.barColor} transition-all duration-500 ease-out`}
            style={{ width: `${vramPct}%` }}
          />
        </div>
        <span className={`text-[11px] tabular-nums ${vramColors.textColor}`}>
          {fmtGB(vram.used)} / {fmtGB(vram.total)} GB
        </span>
      </div>
    )
  })() : null

  return (
    <div
      className="flex items-center gap-2 mr-3 px-2.5 py-1 rounded-md bg-zinc-800/60 border border-zinc-700/60 no-drag"
      title={ramTooltip}
    >
      <span className="text-[10px] font-medium text-zinc-500 tracking-wide uppercase">RAM</span>
      <div className="w-20 h-1.5 bg-zinc-900 rounded-full overflow-hidden">
        <div
          className={`h-full ${ramColors.barColor} transition-all duration-500 ease-out`}
          style={{ width: `${ramPct}%` }}
        />
      </div>
      <span className={`text-[11px] tabular-nums ${ramColors.textColor}`}>
        {fmtGB(ram.used)} / {fmtGB(ram.total)} GB
      </span>
      {vramBar}
    </div>
  )
}
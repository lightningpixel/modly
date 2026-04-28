import { useEffect, useState } from 'react'

const GB = 1024 ** 3

function fmtGB(bytes: number): string {
  return (bytes / GB).toFixed(1)
}

export default function MemoryIndicator(): JSX.Element | null {
  const [mem, setMem] = useState<{ total: number; used: number; available: number } | null>(null)

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const next = await window.electron.system.memory()
        if (!cancelled) setMem(next)
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
  }, [])

  if (!mem) return null

  const pct = mem.total > 0 ? Math.min(100, Math.round((mem.used / mem.total) * 100)) : 0

  let barColor = 'bg-emerald-500'
  let textColor = 'text-zinc-300'
  if (pct >= 90) {
    barColor = 'bg-red-500'
    textColor = 'text-red-300'
  } else if (pct >= 75) {
    barColor = 'bg-amber-500'
    textColor = 'text-amber-300'
  }

  const tooltip =
    `Used:      ${fmtGB(mem.used)} GB\n` +
    `Available: ${fmtGB(mem.available)} GB\n` +
    `Total:     ${fmtGB(mem.total)} GB`

  return (
    <div
      className="flex items-center gap-2 mr-3 px-2.5 py-1 rounded-md bg-zinc-800/60 border border-zinc-700/60 no-drag"
      title={tooltip}
    >
      <span className="text-[10px] font-medium text-zinc-500 tracking-wide uppercase">RAM</span>
      <div className="w-20 h-1.5 bg-zinc-900 rounded-full overflow-hidden">
        <div
          className={`h-full ${barColor} transition-all duration-500 ease-out`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`text-[11px] tabular-nums ${textColor}`}>
        {fmtGB(mem.used)} / {fmtGB(mem.total)} GB
      </span>
    </div>
  )
}

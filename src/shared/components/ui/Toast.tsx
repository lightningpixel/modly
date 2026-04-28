import { useEffect } from 'react'
import { useAppStore } from '@shared/stores/appStore'

export function Toast(): JSX.Element | null {
  const { toast, hideToast } = useAppStore()

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => hideToast(), toast.durationMs ?? 2800)
    return () => window.clearTimeout(timer)
  }, [toast?.id, toast?.durationMs, hideToast])

  if (!toast) return null

  return (
    <div className="fixed right-4 bottom-4 z-50 pointer-events-none">
      <div className="pointer-events-auto max-w-sm rounded-xl border border-amber-500/30 bg-zinc-900/96 shadow-2xl backdrop-blur-sm">
        <div className="flex items-start gap-3 px-4 py-3">
          <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-amber-500/30 bg-amber-500/12">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-amber-300">
              <path d="M10.29 3.86 1.82 18A2 2 0 0 0 3.53 21h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-amber-200/80">Workflow Check</p>
            <p className="mt-1 text-sm leading-5 text-zinc-100">{toast.message}</p>
          </div>
          <button
            onClick={hideToast}
            className="shrink-0 rounded-md p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
            aria-label="Dismiss notification"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '@shared/stores/appStore'
import { useAgentStore } from '@shared/stores/agentStore'
import { useLlmModels, type LlmModel } from '@shared/stores/llmModelsStore'
import { useLlmDownloadsStore } from '@shared/services/llmDownloads'
import { formatBytes as fmtBytes } from '@shared/utils/format'
import { SegmentedControl } from '@shared/ui'
import { SseProgressBar } from './SseProgressBar'
import { vramFit } from './vramFit'
import { agentGrade } from './agentGrade'

// ─── Types ────────────────────────────────────────────────────────────────────

// Single source of truth lives in the shared catalog store; re-exported here so
// existing importers (AgentSection) keep resolving `LlmModel` from this module.
export type { LlmModel }

interface LlmStatus {
  vram_gb: number | null
}

type Filter = 'all' | 'fits' | 'vision' | 'cad'

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function formatBytes(n?: number): string {
  return n ? fmtBytes(n) : '—'
}

type Tone = 'accent' | 'warn' | 'muted' | 'outline'

const TONES: Record<Tone, string> = {
  accent:  'bg-accent/15 text-accent-light border-accent/30',
  warn:    'bg-amber-500/10 text-amber-400 border-amber-500/30',
  muted:   'bg-zinc-800 text-zinc-400 border-zinc-700',
  outline: 'bg-transparent text-accent-light border-accent/40',
}

function Tag({ tone, colors, icon, title, children }: {
  tone?: Tone
  /** Explicit color classes, for verdicts that bring their own (vramFit). */
  colors?: string
  icon?: React.ReactNode
  title?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <span title={title} className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] font-medium ${colors ?? TONES[tone ?? 'muted']}`}>
      {icon}
      {children}
    </span>
  )
}

const ICONS = {
  check:  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>,
  warn:   <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>,
  star:   <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polygon points="12 2 15.1 8.3 22 9.3 17 14.1 18.2 21 12 17.8 5.8 21 7 14.1 2 9.3 8.9 8.3 12 2" /></svg>,
  eye:    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>,
  cube:   <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /></svg>,
  file:   <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>,
}

const outlineBtnCls = 'inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg border border-accent/40 text-accent-light text-xs font-medium hover:bg-accent/10 hover:border-accent/60 transition-colors disabled:opacity-50'
const ghostBtnCls   = 'px-3.5 py-1.5 rounded-lg border border-zinc-700 text-zinc-300 text-xs font-medium hover:text-white hover:border-zinc-500 transition-colors'

// ─── Component ────────────────────────────────────────────────────────────────

export function ModelLibraryModal({ onClose }: { onClose: () => void }): JSX.Element {
  const apiUrl     = useAppStore((s) => s.apiUrl)
  const localModel = useAgentStore((s) => s.localModel)
  const setLocalModel = useAgentStore((s) => s.setLocalModel)

  const [status, setStatus] = useState<LlmStatus | null>(null)
  const [adding, setAdding] = useState(false)
  const [error, setError]   = useState<string | null>(null)
  const [query, setQuery]   = useState('')
  const [filter, setFilter] = useState<Filter>('all')

  // The model list comes from the shared catalog store, so a download or delete
  // here immediately updates every other picker (chat, extension params,
  // chat) and vice-versa — no independent per-surface fetch.
  const { models, refresh: refreshModels } = useLlmModels()

  // Downloads live in a module-level store (src/shared/services/llmDownloads.ts)
  // so they keep running — and stay visible on reopen — after this modal closes.
  const downloads         = useLlmDownloadsStore((s) => s.downloads)
  const downloadError     = useLlmDownloadsStore((s) => s.error)
  const startDownload     = useLlmDownloadsStore((s) => s.start)
  const pauseDownload     = useLlmDownloadsStore((s) => s.pause)
  const cancelDownload    = useLlmDownloadsStore((s) => s.cancel)
  const dismissDownloadError = useLlmDownloadsStore((s) => s.dismissError)

  // Aborts every in-flight fetch (status/model list + any SSE stream) when the
  // modal unmounts, so closing it mid-download doesn't leak a fetch or call
  // setState on a component that's gone.
  const aliveRef            = useRef(true)
  const abortControllersRef = useRef(new Set<AbortController>())
  const dialogRef           = useRef<HTMLDivElement>(null)

  function withAbort<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    abortControllersRef.current.add(controller)
    return run(controller.signal).finally(() => { abortControllersRef.current.delete(controller) })
  }

  useEffect(() => {
    aliveRef.current = true
    const controllers = abortControllersRef.current
    return () => {
      aliveRef.current = false
      for (const controller of controllers) controller.abort()
      controllers.clear()
    }
  }, [])

  // Escape closes the modal; Tab is trapped inside it while it's open.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key !== 'Tab' || !dialogRef.current) return
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      if (focusable.length === 0) return
      const first = focusable[0]
      const last  = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKeyDown)
    dialogRef.current?.focus()
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const refresh = useCallback(async () => {
    void refreshModels()   // shared model catalog (propagates to every picker)
    try {
      const s = await withAbort((signal) =>
        fetch(`${apiUrl}/llm/status`, { signal }).then((r) => r.json()),
      )
      if (!aliveRef.current) return
      setStatus(s)
    } catch {
      if (!aliveRef.current) return
      setStatus(null)
    }
  }, [apiUrl, refreshModels])

  // Once, on open (and if the API URL changes) — `refresh` is stable, see
  // useLlmModels. It used to be rebuilt on every render, so this effect re-ran
  // on every render and each pass forced another /llm/models + /llm/status.
  useEffect(() => { void refresh() }, [refresh])

  async function handleAdd() {
    setAdding(true)
    setError(null)
    try {
      const res = await window.electron.agent.addModel()
      if (!aliveRef.current) return
      if (res.error) setError(res.error)
      if (res.success) void refresh()
    } finally {
      if (aliveRef.current) setAdding(false)
    }
  }

  async function handleDelete(id: string) {
    await fetch(`${apiUrl}/llm/models/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})
    void refresh()
  }

  // Downloads run in the shared store, possibly finishing while this modal is
  // closed — refresh the model list whenever one drops out (done/error/cancelled)
  // while we're mounted, so "downloaded" flips without waiting for a remount.
  const prevDownloadIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const prev = prevDownloadIdsRef.current
    const current = new Set(Object.keys(downloads).filter((id) => downloads[id] !== undefined))
    let finished = false
    for (const id of prev) if (!current.has(id)) finished = true
    prevDownloadIdsRef.current = current
    if (finished) void refresh()
  }, [downloads, refresh])

  // VRAM is only known on NVIDIA (nvidia-smi); without it there is no fit verdict
  // to show or filter on.
  const vramGb = status?.vram_gb ?? null

  const filterOptions: { value: Filter; label: string }[] = [
    { value: 'all', label: 'All' },
    ...(vramGb ? [{ value: 'fits' as const, label: 'Fits my GPU' }] : []),
    { value: 'vision', label: 'Vision' },
    { value: 'cad',    label: 'CAD' },
  ]

  const q = query.trim().toLowerCase()
  const matches = (m: LlmModel): boolean => {
    const tags = m.tags ?? []
    if (filter === 'vision' && !tags.includes('vision')) return false
    if (filter === 'cad'    && !tags.includes('cad'))    return false
    if (filter === 'fits') {
      const fit = vramFit(m.vram_estimate_mb, vramGb)
      if (!fit || fit.label === "Won't fit") return false
    }
    return !q || m.name.toLowerCase().includes(q) || (m.description ?? '').toLowerCase().includes(q)
  }

  const installed = models.filter((m) => m.downloaded && matches(m))
  const suggested = models.filter((m) => !m.downloaded && matches(m))
  const filtering = filter !== 'all' || q !== ''

  function renderCard(m: LlmModel): JSX.Element {
    const dl     = downloads[m.id]
    const tags   = m.tags ?? []
    const inUse  = m.downloaded && localModel === m.id
    // Code/CAD models are tools for workflow nodes, not chat models: the chat's
    // own picker leaves them out, so they cannot become the agent's model here.
    const nodeOnly = tags.some((t) => t === 'code' || t === 'cad')
    const fit    = vramFit(m.vram_estimate_mb, vramGb)
    // Size and VRAM say nothing about how well a model drives the agent — a 4B
    // outscores a 20B here. The tooltip keeps a measured rate and an estimate
    // visibly apart.
    const grade  = agentGrade(m)

    return (
      <div
        key={m.id}
        className={`rounded-xl border bg-surface-300 px-4 py-3.5 flex flex-col gap-2.5 transition-colors ${
          inUse ? 'border-accent/50' : 'border-zinc-800 hover:border-zinc-700'
        }`}
      >
        <div className="flex items-start justify-between gap-3">
          <p className="text-[13px] font-semibold text-zinc-100 leading-snug break-words">{m.name}</p>
          {inUse && (
            <Tag tone="accent" icon={<span className="w-1.5 h-1.5 rounded-full bg-accent-light" />}>In use</Tag>
          )}
        </div>

        <div className="flex flex-wrap gap-1">
          {tags.includes('default') && <Tag tone="outline" icon={ICONS.star}>Recommended</Tag>}
          {fit && <Tag colors={fit.className} icon={fit.label === 'Fits' ? ICONS.check : ICONS.warn}>{fit.label}</Tag>}
          {tags.includes('vision') && <Tag tone="muted" icon={ICONS.eye}>Vision</Tag>}
          {tags.includes('cad') && <Tag tone="muted" icon={ICONS.cube}>CAD</Tag>}
          {m.source === 'custom' && <Tag tone="muted" icon={ICONS.file}>Custom</Tag>}
          {grade && <Tag tone="muted" title={grade.title}>{grade.label}</Tag>}
        </div>

        {m.description && (
          <p className="text-[11px] text-zinc-400 leading-relaxed line-clamp-3" title={m.description}>{m.description}</p>
        )}

        <div className="mt-auto pt-1 flex items-center justify-between gap-2 text-[10px] font-mono text-zinc-500">
          <span className="truncate">{[m.size_bytes ? formatBytes(m.size_bytes) : null, m.quant].filter(Boolean).join(' · ')}</span>
          {m.vram_estimate_mb ? (
            <span className="shrink-0">
              ~{(m.vram_estimate_mb / 1024).toFixed(1)}{vramGb ? ` / ${vramGb}` : ''} GB VRAM
            </span>
          ) : null}
        </div>

        {dl && <SseProgressBar event={dl} />}

        <div className="flex items-center gap-2 pt-0.5">
          {m.downloaded ? (
            <>
              {inUse ? (
                <span className="text-[11px] text-zinc-500">Used by the chat agent</span>
              ) : nodeOnly ? (
                <span className="text-[11px] text-zinc-500">For workflow nodes, not the chat</span>
              ) : (
                <button onClick={() => setLocalModel(m.id)} className={outlineBtnCls}>Select</button>
              )}
              <button
                onClick={() => handleDelete(m.id)}
                title="Delete model file"
                aria-label={`Delete ${m.name}`}
                className="ml-auto p-1.5 rounded-lg text-zinc-600 hover:text-red-400 hover:bg-red-950/40 transition-colors"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            </>
          ) : dl ? (
            <>
              {dl.paused ? (
                <button onClick={() => startDownload(m.id)} className={ghostBtnCls}>Resume</button>
              ) : (
                <button onClick={() => void pauseDownload(m.id)} className={ghostBtnCls}>Pause</button>
              )}
              <button onClick={() => void cancelDownload(m.id)} className={`${ghostBtnCls} hover:!text-red-400`}>Cancel</button>
            </>
          ) : (
            <button onClick={() => startDownload(m.id)} className={outlineBtnCls}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Download
            </button>
          )}
        </div>
      </div>
    )
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="absolute inset-0 bg-zinc-950/70 backdrop-blur-sm animate-fade-in" />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Models"
        tabIndex={-1}
        className="relative w-[1000px] max-w-[94vw] max-h-[88vh] rounded-2xl bg-zinc-900 border border-zinc-700/60 shadow-[0_30px_60px_rgba(0,0,0,0.5)] overflow-hidden animate-slide-up-center flex flex-col focus:outline-none"
      >

        {/* Header */}
        <div className="px-5 pt-5 pb-4 border-b border-zinc-800/80 shrink-0 flex flex-col gap-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-zinc-100 leading-tight">Models</h2>
              <p className="text-xs text-zinc-500 mt-0.5">
                Local models shared by the whole app — chat agent and extensions.
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {vramGb != null && (
                // self-stretch: as tall as the Add button beside it, whatever its padding.
                <span className="self-stretch inline-flex items-center gap-1.5 px-2.5 rounded-md bg-zinc-800 border border-zinc-700 text-[11px] font-medium text-zinc-300">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-zinc-500">
                    <rect x="2" y="6" width="20" height="12" rx="2" /><line x1="6" y1="10" x2="6" y2="14" /><line x1="10" y1="10" x2="10" y2="14" /><line x1="14" y1="10" x2="14" y2="14" />
                  </svg>
                  {vramGb} GB VRAM
                </span>
              )}
              <button
                onClick={() => void handleAdd()}
                disabled={adding}
                className="px-3.5 py-1.5 rounded-lg bg-accent hover:bg-accent-dark text-white text-[12px] font-medium transition-colors disabled:opacity-50"
              >
                {adding ? 'Adding…' : 'Add'}
              </button>
              <button onClick={onClose} aria-label="Close" className="ml-1 p-1.5 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative w-80 max-w-full">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none">
                <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search models"
                className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded-lg pl-8 pr-3 py-2 placeholder:text-zinc-500 focus:outline-none focus:border-accent/50"
              />
            </div>
            <SegmentedControl value={filter} onChange={setFilter} options={filterOptions} ariaLabel="Filter models" />
          </div>

          {status === null && (
            <p className="text-[11px] text-zinc-500 flex items-center gap-2">
              Cannot reach the Modly API.
              {/* The library does not poll, so a backend that was still starting
                * up needs a way back in short of reopening the modal. */}
              <button onClick={() => { void refresh() }} className="text-accent-light hover:underline underline-offset-2">
                Retry
              </button>
            </p>
          )}
          {(error || downloadError) && (
            <p className="text-[11px] text-red-400 flex items-center gap-2">
              <span className="flex-1">{error || downloadError}</span>
              <button
                onClick={() => { setError(null); dismissDownloadError() }}
                className="shrink-0 text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                Dismiss
              </button>
            </p>
          )}
        </div>

        {/* Installed first, then the catalog's suggestions not yet downloaded */}
        <div className="px-5 py-4 overflow-y-auto flex flex-col gap-6">
          {([
            {
              title: 'Installed',
              items: installed,
              empty: filtering ? 'No installed model matches.' : 'No model installed yet — add a .gguf file or download a suggestion below.',
            },
            {
              title: 'Suggested',
              items: suggested,
              empty: filtering ? 'No suggested model matches.' : 'Every suggested model is installed.',
            },
          ]).map((section) => (
            <div key={section.title} className="flex flex-col gap-3">
              <h3 className="text-[10.5px] font-semibold uppercase tracking-widest text-zinc-500">
                {section.title}
                <span className="ml-2 text-zinc-700">{section.items.length}</span>
              </h3>
              {section.items.length > 0 ? (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(270px,1fr))] gap-3">
                  {section.items.map(renderCard)}
                </div>
              ) : (
                <p className="text-[11px] text-zinc-600">{section.empty}</p>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  )
}

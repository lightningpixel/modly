import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '@shared/stores/appStore'
import { useAgentStore } from '@shared/stores/agentStore'
import { useLlmModels, type LlmModel } from '@shared/stores/llmModelsStore'
import { consumeSse, useLlmDownloadsStore, type SseEvent } from '@shared/services/llmDownloads'
import { formatBytes as fmtBytes } from '@shared/utils/format'
import { vramFit } from './vramFit'
import { agentGrade } from './agentGrade'

// ─── Types ────────────────────────────────────────────────────────────────────

// Single source of truth lives in the shared catalog store; re-exported here so
// existing importers (AgentSection) keep resolving `LlmModel` from this module.
export type { LlmModel }

interface LlmStatus {
  binary_installed: boolean
  has_nvidia_gpu:   boolean
  vram_gb:          number | null
  models_dir:       string
  server:           { alive: boolean; model_id: string | null }
}

type CategoryId = 'all' | 'general' | 'vision' | 'cad' | 'custom'

const CATEGORIES: { id: CategoryId; label: string }[] = [
  { id: 'all',     label: 'All' },
  { id: 'general', label: 'General' },
  { id: 'vision',  label: 'Vision' },
  { id: 'cad',     label: 'CAD' },
  { id: 'custom',  label: 'Custom' },
]

function inCategory(m: LlmModel, cat: CategoryId): boolean {
  const tags = m.tags ?? []
  switch (cat) {
    case 'all':     return true
    case 'custom':  return m.source === 'custom'
    case 'vision':  return tags.includes('vision')
    case 'cad':     return tags.includes('cad')
    case 'general': return m.source === 'catalog' && !tags.includes('cad') && !tags.includes('vision')
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function formatBytes(n?: number): string {
  return n ? fmtBytes(n) : '—'
}

function ProgressBar({ event }: { event: SseEvent }): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-[10px] text-zinc-500">
        <span className="truncate">{event.status}</span>
        <span className="shrink-0">
          {event.totalBytes ? `${formatBytes(event.bytesDownloaded)} / ${formatBytes(event.totalBytes)}` : `${event.percent ?? 0}%`}
        </span>
      </div>
      <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
        <div className="h-full bg-accent rounded-full transition-all" style={{ width: `${event.percent ?? 0}%` }} />
      </div>
    </div>
  )
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ModelLibraryModal({ onClose }: { onClose: () => void }): JSX.Element {
  const apiUrl     = useAppStore((s) => s.apiUrl)
  const localModel = useAgentStore((s) => s.localModel)
  const setLocalModel = useAgentStore((s) => s.setLocalModel)

  const [status, setStatus]         = useState<LlmStatus | null>(null)
  const [category, setCategory]     = useState<CategoryId>('all')
  const [installing, setInstalling] = useState<SseEvent | null>(null)
  const [error, setError]           = useState<string | null>(null)

  // The model list comes from the shared catalog store, so a download or delete
  // here immediately updates every other picker (extension params, chat) and
  // vice-versa — no independent per-surface fetch.
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

  async function handleInstallEngine() {
    setInstalling({ percent: 0, status: 'Starting…' })
    setError(null)
    try {
      await withAbort((signal) => consumeSse(`${apiUrl}/llm/binary/install`, (e) => {
        if (!aliveRef.current) return
        if (e.error) { setError(e.error); return }
        setInstalling(e)
      }, signal))
    } catch (e) {
      if (aliveRef.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (aliveRef.current) setInstalling(null)
      void refresh()
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

  const visible = models.filter((m) => inCategory(m, category))
  const counts = Object.fromEntries(
    CATEGORIES.map((c) => [c.id, models.filter((m) => inCategory(m, c.id)).length]),
  ) as Record<CategoryId, number>

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
        aria-label="Model library"
        tabIndex={-1}
        className="relative w-[600px] max-w-[92vw] max-h-[85vh] rounded-2xl bg-zinc-900 border border-accent/20 shadow-2xl shadow-accent/5 overflow-hidden animate-slide-up-center flex flex-col focus:outline-none"
      >

        {/* Header */}
        <div className="px-5 pt-5 pb-3 flex items-start justify-between gap-3 shrink-0">
          <div>
            <h2 className="text-base font-semibold text-zinc-100 leading-tight">Model library</h2>
            <p className="text-xs text-zinc-500 mt-0.5">
              Local models shared by the whole app — chat agent and extensions.
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-zinc-600 hover:text-zinc-300 transition-colors mt-0.5">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Engine status */}
        <div className="px-5 pb-3 shrink-0">
          {status === null ? (
            <p className="text-[11px] text-zinc-500 flex items-center gap-2">
              Cannot reach the Modly API.
              {/* The library no longer polls, so a backend that was still
                * starting up needs a way back in short of reopening the modal. */}
              <button
                onClick={() => { void refresh() }}
                className="text-accent hover:underline underline-offset-2"
              >
                Retry
              </button>
            </p>
          ) : !status.binary_installed ? (
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-3.5 py-3 flex flex-col gap-2">
              <p className="text-[11.5px] text-zinc-300 leading-relaxed">
                The inference engine is not installed. Modly will fetch the llama.cpp build matching this
                machine ({status.has_nvidia_gpu ? 'NVIDIA GPU detected — CUDA build' : 'Vulkan/CPU build'}).
              </p>
              {installing ? (
                <ProgressBar event={installing} />
              ) : (
                <button
                  onClick={handleInstallEngine}
                  className="self-start px-3.5 py-1.5 rounded-lg bg-accent hover:bg-accent-dark text-white text-[11.5px] font-medium transition-colors"
                >
                  Install engine
                </button>
              )}
            </div>
          ) : (
            <p className="text-[11px] text-emerald-400">
              Engine installed{status.server.alive ? ` — ${status.server.model_id} loaded` : ''}
            </p>
          )}
          {(error || downloadError) && (
            <p className="text-[11px] text-red-400 mt-1.5 flex items-center gap-2">
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

        {/* Category tabs */}
        <div className="px-5 pb-3 flex items-center gap-1.5 shrink-0">
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              onClick={() => setCategory(c.id)}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors border ${
                category === c.id
                  ? 'bg-accent/15 text-accent border-accent/30'
                  : 'bg-zinc-900 text-zinc-500 border-zinc-800 hover:text-zinc-300 hover:border-zinc-600'
              }`}
            >
              {c.label}
              <span className={`ml-1.5 ${category === c.id ? 'text-accent/70' : 'text-zinc-700'}`}>{counts[c.id]}</span>
            </button>
          ))}
        </div>

        {/* Model list */}
        <div className="px-5 pb-4 overflow-y-auto flex flex-col gap-2">
          {visible.map((m) => {
            const dl = downloads[m.id]
            return (
              <div key={m.id} className="border border-zinc-800 rounded-xl px-3.5 py-3 flex flex-col gap-1.5 bg-zinc-900/40 shrink-0">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[12.5px] text-zinc-200 truncate">
                      {m.name}
                      {m.source === 'custom' && (
                        <span className="ml-2 text-[9px] px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-500">custom</span>
                      )}
                      {(m.tags ?? []).includes('cad') && (
                        <span className="ml-2 text-[9px] px-1.5 py-0.5 rounded border border-violet-500/30 bg-violet-500/10 text-violet-400">CAD</span>
                      )}
                      {(m.tags ?? []).includes('vision') && (
                        <span className="ml-2 text-[9px] px-1.5 py-0.5 rounded border border-sky-500/30 bg-sky-500/10 text-sky-400">Vision</span>
                      )}
                      {/* Size and VRAM say nothing about how well a model drives
                        * the agent — a 4B outscores a 20B here. The tooltip keeps
                        * a measured rate and an estimate visibly apart. */}
                      {(() => {
                        const grade = agentGrade(m)
                        return grade ? (
                          <span title={grade.title}
                            className={`ml-2 text-[9px] px-1.5 py-0.5 rounded border ${grade.className}`}>
                            {grade.label}
                          </span>
                        ) : null
                      })()}
                    </p>
                    <p className="text-[10.5px] text-zinc-600 flex items-center gap-1.5 flex-wrap">
                      <span>
                        {formatBytes(m.size_bytes)}
                        {m.quant ? ` · ${m.quant}` : ''}
                        {m.vram_estimate_mb ? ` · ~${(m.vram_estimate_mb / 1000).toFixed(1)} GB VRAM` : ''}
                      </span>
                      {(() => {
                        const fit = vramFit(m.vram_estimate_mb, status?.vram_gb)
                        return fit ? (
                          <span className={`text-[9px] px-1.5 py-0.5 rounded border ${fit.className}`}>{fit.label}</span>
                        ) : null
                      })()}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {m.downloaded ? (
                      <>
                        {localModel === m.id ? (
                          <span className="text-[10px] px-2 py-1 rounded-md bg-accent/15 text-accent border border-accent/30">Default</span>
                        ) : (
                          <button
                            onClick={() => setLocalModel(m.id)}
                            className="text-[10px] px-2 py-1 rounded-md border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 transition-colors"
                          >
                            Use
                          </button>
                        )}
                        <button
                          onClick={() => handleDelete(m.id)}
                          title="Delete model file"
                          className="text-zinc-700 hover:text-red-400 transition-colors"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      </>
                    ) : dl ? (
                      <>
                        {dl.paused ? (
                          <button
                            onClick={() => startDownload(m.id)}
                            className="text-[10px] px-2 py-1 rounded-md border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 transition-colors"
                          >
                            Resume
                          </button>
                        ) : (
                          <button
                            onClick={() => void pauseDownload(m.id)}
                            className="text-[10px] px-2 py-1 rounded-md border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 transition-colors"
                          >
                            Pause
                          </button>
                        )}
                        <button
                          onClick={() => void cancelDownload(m.id)}
                          className="text-[10px] px-2 py-1 rounded-md border border-zinc-700 text-zinc-400 hover:text-red-400 transition-colors"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => startDownload(m.id)}
                        className="text-[10px] px-2 py-1 rounded-md border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 transition-colors"
                      >
                        Download
                      </button>
                    )}
                  </div>
                </div>
                {m.description && <p className="text-[10.5px] text-zinc-500 leading-relaxed">{m.description}</p>}
                {dl && <ProgressBar event={dl} />}
              </div>
            )
          })}
          {visible.length === 0 && (
            <p className="text-[11px] text-zinc-600 py-4 text-center">
              {category === 'custom'
                ? `No custom models — drop .gguf files in ${status?.models_dir ?? '~/.modly/llm/models'}`
                : 'No models in this category.'}
            </p>
          )}
        </div>

        {/* Footer hint */}
        <div className="px-5 py-3 border-t border-zinc-800/70 shrink-0">
          <p className="text-[10px] text-zinc-600">
            Custom models: drop any .gguf in <span className="text-zinc-500">{status?.models_dir ?? '~/.modly/llm/models'}</span> — detected automatically.
          </p>
        </div>
      </div>
    </div>,
    document.body,
  )
}

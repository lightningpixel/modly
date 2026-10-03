import { create } from 'zustand'
import { useAppStore } from '@shared/stores/appStore'

// GGUF model downloads must survive the Model Library modal being closed and
// reopened — the backend already keeps downloading in the background once
// started (see api/routers/llm.py), it just needs a watcher that isn't tied to
// a component's lifecycle. This module-level store owns that watch, the same
// way agentChat.ts owns the chat's SSE stream outside React.

export interface SseEvent {
  percent?:         number
  status?:          string
  bytesDownloaded?: number
  totalBytes?:      number
  error?:           string
  cancelled?:       boolean
  paused?:          boolean
}

/** Reads one SSE `data: {...}` frame at a time and calls `onEvent` for each. */
export async function consumeSse(url: string, onEvent: (data: SseEvent) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(url, { signal })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  outer: for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const parts = buf.split('\n\n')
    buf = parts.pop() ?? ''
    for (const part of parts) {
      const line = part.split('\n').find((l) => l.startsWith('data: '))
      if (!line) continue
      let data: SseEvent
      try { data = JSON.parse(line.slice(6)) } catch { continue /* malformed frame */ }
      onEvent(data)
      // The stream stays open after an error frame — stop reading instead of
      // spinning on a download the server has already given up on.
      if (data.error) { void reader.cancel().catch(() => {}); break outer }
    }
  }
}

interface LlmDownloadsStore {
  downloads: Record<string, SseEvent | undefined>
  error:     string | null
  start:     (modelId: string) => void
  pause:     (modelId: string) => Promise<void>
  cancel:    (modelId: string) => Promise<void>
  dismissError: () => void
}

// Model ids this renderer is currently watching. The backend is reconnect-safe
// (a GET while a download is already in flight attaches instead of restarting
// it), this just avoids opening a second redundant connection from this same
// store if start() is called twice in a row (e.g. StrictMode double-invoke).
const _watching = new Set<string>()

export const useLlmDownloadsStore = create<LlmDownloadsStore>((set) => ({
  downloads: {},
  error:     null,

  start(modelId) {
    if (_watching.has(modelId)) return
    _watching.add(modelId)
    const apiUrl = useAppStore.getState().apiUrl

    // Resuming from a paused entry: reset it to a live "connecting" state so the
    // Resume button flips back to Pause immediately, before the first SSE frame.
    set((s) => ({ downloads: { ...s.downloads, [modelId]: { percent: s.downloads[modelId]?.percent ?? 0, status: 'Starting…' } } }))

    let last: SseEvent | undefined
    void consumeSse(`${apiUrl}/llm/download?model_id=${encodeURIComponent(modelId)}`, (e) => {
      if (e.error) { set({ error: e.error }); return }
      last = e
      set((s) => ({ downloads: { ...s.downloads, [modelId]: e } }))
    })
      .catch((e) => set({ error: e instanceof Error ? e.message : String(e) }))
      .finally(() => {
        _watching.delete(modelId)
        // Keep the paused entry so a Resume button stays visible; the .part file
        // is preserved server-side and start() resumes it. Any other terminal
        // (done/cancelled/error) drops the row.
        set((s) => ({ downloads: { ...s.downloads, [modelId]: last?.paused ? last : undefined } }))
      })
  },

  async pause(modelId) {
    const apiUrl = useAppStore.getState().apiUrl
    await fetch(`${apiUrl}/llm/download/pause?model_id=${encodeURIComponent(modelId)}`, { method: 'POST' }).catch(() => {})
  },

  async cancel(modelId) {
    const apiUrl = useAppStore.getState().apiUrl
    await fetch(`${apiUrl}/llm/download/cancel?model_id=${encodeURIComponent(modelId)}`, { method: 'POST' }).catch(() => {})
    // A paused download has no live watcher to hit its .finally cleanup — drop
    // the row here so Cancel visibly clears it.
    set((s) => ({ downloads: { ...s.downloads, [modelId]: undefined } }))
  },

  dismissError: () => set({ error: null }),
}))

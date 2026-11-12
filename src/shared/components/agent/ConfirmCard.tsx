import { create } from 'zustand'
import type { ConfirmInfo } from './clientTools'

// ─── Confirm queue ────────────────────────────────────────────────────────────

export type ConfirmStatus = 'pending' | 'confirmed' | 'cancelled'

export interface ConfirmRequest {
  /** Unique per request. */
  key: string
  description: string
  destructive: boolean
  status: ConfirmStatus
  /** The client_tool event this request belongs to, when it came from one. */
  tool?: string
  eventId?: string
  callId?: string
}

interface ConfirmQueueState {
  requests: ConfirmRequest[]
  /** Shows a card and resolves with the user's answer. Matches runClientTool's `confirm`. */
  confirm: (description: string, info?: ConfirmInfo) => Promise<boolean>
  answer: (key: string, confirmed: boolean) => void
  /** Cancels every pending request (stream aborted, panel closed, new conversation). */
  cancelAll: () => void
  /** Forgets answered requests. */
  clearAnswered: () => void
  /** Cancels the pending card of one client_tool event (the server stopped waiting for it). */
  cancelEvent: (eventId: string) => void
  /** Called whenever a card is queued; the panel uses it to open itself so the card is seen. */
  onQueued: (() => void) | null
  setOnQueued: (callback: (() => void) | null) => void
}

// Resolvers stay out of the state: they are not data to render.
const resolvers = new Map<string, (confirmed: boolean) => void>()
let nextKey = 0

export const useConfirmQueue = create<ConfirmQueueState>((set, get) => ({
  requests: [],

  confirm(description, info) {
    const key = `confirm-${++nextKey}`
    const request: ConfirmRequest = {
      key,
      description,
      destructive: info?.destructive ?? true,
      status: 'pending',
      tool: info?.tool,
      eventId: info?.id,
      callId: info?.callId,
    }
    return new Promise<boolean>((resolve) => {
      resolvers.set(key, resolve)
      set((s) => ({ requests: [...s.requests, request] }))
      get().onQueued?.()
    })
  },

  answer(key, confirmed) {
    const resolve = resolvers.get(key)
    if (!resolve) return
    resolvers.delete(key)
    set((s) => ({
      requests: s.requests.map((r) => (r.key === key ? { ...r, status: confirmed ? 'confirmed' : 'cancelled' } : r)),
    }))
    resolve(confirmed)
  },

  cancelAll() {
    for (const r of get().requests) if (r.status === 'pending') get().answer(r.key, false)
  },

  clearAnswered() {
    set((s) => ({ requests: s.requests.filter((r) => r.status === 'pending') }))
  },

  cancelEvent(eventId) {
    for (const r of get().requests) if (r.status === 'pending' && r.eventId === eventId) get().answer(r.key, false)
  },

  onQueued: null,
  setOnQueued: (callback) => set({ onQueued: callback }),
}))

// ─── Card ─────────────────────────────────────────────────────────────────────

export interface ConfirmCardProps {
  description: string
  destructive?: boolean
  status: ConfirmStatus
  onConfirm: () => void
  onCancel: () => void
}

/** The Confirm / Cancel card shown in the chat before a sensitive action. */
export function ConfirmCard({ description, destructive = true, status, onConfirm, onCancel }: ConfirmCardProps): JSX.Element {
  const pending = status === 'pending'

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!pending) return
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    } else if (e.key === 'Enter' && !(e.target as HTMLElement).dataset.confirmCancel) {
      // Enter on the Cancel button keeps its native meaning.
      e.preventDefault()
      onConfirm()
    }
  }

  return (
    <div
      role="group"
      aria-label="Confirm action"
      tabIndex={pending ? 0 : -1}
      onKeyDown={handleKeyDown}
      className={`rounded-xl border bg-zinc-800/40 overflow-hidden text-[11px] outline-none focus-visible:ring-1 focus-visible:ring-accent/60 ${
        pending ? (destructive ? 'border-red-800/50' : 'border-accent/30') : 'border-zinc-700/50'
      }`}
    >
      <div className="flex items-start gap-2 px-3 py-2.5">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          className={`shrink-0 mt-px ${pending && destructive ? 'text-red-400' : 'text-zinc-500'}`}>
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <p className="text-zinc-200 leading-relaxed">{description}</p>
      </div>

      <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-zinc-700/40">
        {pending ? (
          <>
            <button
              type="button"
              data-confirm-cancel="true"
              onClick={onCancel}
              className="px-2.5 py-1 rounded-lg font-medium text-zinc-300 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 hover:border-zinc-600 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className={`px-2.5 py-1 rounded-lg font-medium border transition-colors ${
                destructive
                  ? 'text-red-300 bg-red-950/40 hover:bg-red-900/50 border-red-800/60 hover:border-red-700'
                  : 'text-accent-light bg-accent/10 hover:bg-accent/20 border-accent/30 hover:border-accent/50'
              }`}
            >
              Confirm
            </button>
          </>
        ) : (
          <span className={`flex items-center gap-1.5 font-medium ${status === 'confirmed' ? 'text-emerald-400' : 'text-zinc-500'}`}>
            {status === 'confirmed' ? (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            )}
            {status === 'confirmed' ? 'Confirmed' : 'Cancelled'}
          </span>
        )}
      </div>
    </div>
  )
}

/** A ConfirmCard bound to one request of the queue. */
export function QueuedConfirmCard({ request }: { request: ConfirmRequest }): JSX.Element {
  const answer = useConfirmQueue((s) => s.answer)
  return (
    <ConfirmCard
      description={request.description}
      destructive={request.destructive}
      status={request.status}
      onConfirm={() => answer(request.key, true)}
      onCancel={() => answer(request.key, false)}
    />
  )
}

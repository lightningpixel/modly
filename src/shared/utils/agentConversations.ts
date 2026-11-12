// Pure renderer-side logic for persisted agent conversations. File storage
// and id validation live in electron/main/agent-conversations.ts.

export interface ConversationSummary {
  id: string
  title: string
  /** Epoch milliseconds. */
  updatedAt: number
}

export interface Conversation {
  id: string
  title: string
  /** Epoch milliseconds. */
  createdAt: number
  /** Epoch milliseconds. */
  updatedAt: number
  /** AgentChat messages; attached images stay inline as data URLs. */
  messages: unknown[]
}

export const TITLE_MAX_LENGTH = 60
export const UNTITLED = 'New conversation'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The first user message, on one line, cut to TITLE_MAX_LENGTH characters. */
export function deriveTitle(messages: readonly unknown[]): string {
  for (const m of messages) {
    if (!isRecord(m) || m.role !== 'user' || typeof m.content !== 'string') continue
    const text = m.content.replace(/\s+/g, ' ').trim()
    if (!text) continue
    return text.length > TITLE_MAX_LENGTH ? `${text.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…` : text
  }
  return UNTITLED
}

/** Newest first; ties keep a stable order by id. */
export function sortSummaries<T extends ConversationSummary>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => (b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id))
}

/** Replace (or add) one summary and keep the list sorted. */
export function upsertSummary(list: readonly ConversationSummary[], summary: ConversationSummary): ConversationSummary[] {
  return sortSummaries([...list.filter((s) => s.id !== summary.id), summary])
}

/**
 * A conversation saved mid-turn holds a streaming message and running tools.
 * Nothing is streaming once it is loaded again, so settle them.
 */
export function settleMessages(messages: readonly unknown[]): unknown[] {
  return messages.map((m) => {
    if (!isRecord(m)) return m
    const settled: Record<string, unknown> = { ...m }
    if (settled.streaming) settled.streaming = false
    if (Array.isArray(settled.actions)) {
      settled.actions = settled.actions.map((a) => (isRecord(a) && a.running ? { ...a, running: false } : a))
    }
    return settled
  })
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "just now", "5m ago", "3h ago", "2d ago", then a short date. */
export function relativeDate(ts: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ts)
  if (diff < MINUTE) return 'just now'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d ago`
  const d = new Date(ts)
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }
  if (d.getFullYear() !== new Date(now).getFullYear()) opts.year = 'numeric'
  return d.toLocaleDateString('en-US', opts)
}

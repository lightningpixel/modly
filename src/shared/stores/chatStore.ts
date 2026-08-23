import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Workflow } from '@shared/types/electron.d'

export interface ActionDone {
  tool: string
  result: string
  payload?: {
    type: string
    url?: string
    face_count?: number
    workflow_id?: string
    workflow_name?: string
    /** run_workflow: target the workflow created earlier in this same turn —
     *  the backend cannot know its id, the app stamps it. */
    created_this_turn?: boolean
    workflow?: Omit<Workflow, 'id' | 'createdAt' | 'updatedAt'>
    set_params?: { step: number; params: Record<string, unknown> }[]
    name?: string
    description?: string
    mode?: string
    /** export_mesh: workspace-relative source path and target format.
     *  set_input_image: absolute path of the picture the Image node points at. */
    path?: string
    format?: string
  } | null
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  thinking?: string
  imageDataUrls?: string[]
  /** Workspace URLs (`/workspace/...`) of workflow output images — light, persisted. */
  imageUrls?: string[]
  actions?: ActionDone[]
  streaming?: boolean
  /** UI-only info line (e.g. auto-switch to a vision model) — never sent to the LLM. */
  notice?: boolean
}

/** One chat thread. Everything the agent sends is scoped to a conversation:
 *  its transcript, and the compacted note covering the turns already folded. */
export interface Conversation {
  id:            string
  /** Auto-derived from the first user message, then left alone — so a name the
   *  user typed is never overwritten by a later message. */
  title:         string
  messages:      ChatMessage[]
  summary:       string
  compactedUpTo: number
}

interface ChatState {
  /** Every thread, newest created first — a stable order, so the list does not
   *  reshuffle under the pointer while a conversation is being used. Always
   *  holds an entry for `activeId`. */
  conversations: Conversation[]
  activeId:      string

  /** The open conversation's transcript. This is the live copy every writer
   *  (the SSE stream, the workflow watcher) touches; the matching entry in
   *  `conversations` catches up on switch, on delete and on every persist. */
  messages: ChatMessage[]
  /** Compact LLM-written note covering messages[0..compactedUpTo). */
  summary: string
  compactedUpTo: number

  // ── Live agent state (owned by agentChat service, NOT persisted) ─────────
  // Lives here so the SSE stream survives page switches: the ChatPanel
  // component only renders this state, it never owns the stream.
  isLoading: boolean
  statusText: string | null
  error: string | null
  pendingWorkflow: { id: string; name: string } | null
  /** Chat-picker model override; null = follow the Settings default. */
  chatModel: string | null
  /** Brain-icon thinking override; null = follow the Settings default. */
  thinkingOverride: 'auto' | 'on' | 'off' | null

  setMessages:   (updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => void
  setCompaction: (summary: string, upTo: number) => void
  /** Empty the open conversation, keeping it (and its place in the list). */
  clear:         () => void
  setAgentState: (patch: Partial<Pick<ChatState, 'isLoading' | 'statusText' | 'error' | 'pendingWorkflow'>>) => void
  setChatModel:  (model: string | null) => void
  setThinkingOverride: (mode: 'auto' | 'on' | 'off' | null) => void

  // Callers should go through agentChat's wrappers, which also abort the turn
  // in flight — a stream left running writes its tokens into whatever
  // conversation is open when they arrive.
  newConversation:    () => void
  switchConversation: (id: string) => void
  deleteConversation: (id: string) => void
  renameConversation: (id: string, title: string) => void
}

/** Cap on the persisted history, per conversation. Nothing trims the live
 *  array, so a long-running session grew localStorage until the quota threw and
 *  every later write was silently lost. Only the tail is kept; older turns are
 *  covered by `summary`. */
const MAX_PERSISTED_MESSAGES = 200
/** Cap on the number of threads kept on disk. Oldest first out — except the
 *  open one, which is never dropped from under the user. */
const MAX_CONVERSATIONS = 30
const TITLE_MAX = 40

const newId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `c-${Date.now()}-${Math.random().toString(16).slice(2)}`

/** One line, short enough for the picker. Shared so a name the user typed is cut
 *  exactly like a derived one — with the ellipsis that says it was cut. */
function shorten(text: string): string {
  const line = text.trim().replace(/\s+/g, ' ')
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line
}

/** First real user line, shortened — what the picker lists a thread under. */
function titleFrom(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === 'user' && !m.notice && m.content.trim())
  return first ? shorten(first.content) : ''
}

function emptyConversation(): Conversation {
  return { id: newId(), title: '', messages: [], summary: '', compactedUpTo: 0 }
}

type LiveFields = Pick<ChatState, 'conversations' | 'activeId' | 'messages' | 'summary' | 'compactedUpTo'>

/** The conversation list with the live copy folded back into the open thread.
 *  The two only ever diverge between writes; every read of another thread's
 *  transcript goes through this. */
function withLive(s: LiveFields): Conversation[] {
  return s.conversations.map((c) =>
    c.id === s.activeId
      ? { ...c, messages: s.messages, summary: s.summary, compactedUpTo: s.compactedUpTo }
      : c,
  )
}

/** Open `conversation`: its transcript becomes the live copy. */
function open(conversation: Conversation) {
  return {
    activeId:      conversation.id,
    messages:      conversation.messages,
    summary:       conversation.summary,
    compactedUpTo: conversation.compactedUpTo,
    error:         null,
    statusText:    null,
  }
}

/** Drops a create_workflow action's graph, keeping the shape the UI reads.
 *  ActionsCard only ever shows `payload.workflow.name`; the nodes and edges are
 *  consumed live by handleAction and are the single heaviest thing in a message. */
function lightenAction(action: ActionDone): ActionDone {
  const workflow = action.payload?.workflow
  if (!workflow) return action
  return { ...action, payload: { ...action.payload!, workflow: { ...workflow, nodes: [], edges: [] } } }
}

/** Attachments are heavy data URLs (localStorage quota), and a persisted
 *  streaming flag would restore a forever-spinning message. */
function trimForStorage(c: Conversation): Conversation {
  const dropped = Math.max(0, c.messages.length - MAX_PERSISTED_MESSAGES)
  return {
    ...c,
    messages: c.messages.slice(dropped).map(({ imageDataUrls: _img, streaming: _live, ...m }) => (
      m.actions ? { ...m, actions: m.actions.map(lightenAction) } : m
    )),
    // compactedUpTo indexes into `messages`, so it has to move with the cut
    // or the restored summary would be attributed to the wrong turns.
    compactedUpTo: Math.max(0, c.compactedUpTo - dropped),
  }
}

const STORAGE_KEY = 'modly-chat-history'
/** Where the v1 history is copied before it is rewritten in the new shape.
 *  The migration below is the one irreversible step in this store: once the
 *  first write lands, the old value is gone. A single-file chat history is
 *  cheap to keep and impossible to reconstruct. */
const V1_BACKUP_KEY = `${STORAGE_KEY}-v1-backup`

const initial = emptyConversation()

export const useChatStore = create<ChatState>()(
  persist(
    (set) => ({
      conversations: [initial],
      activeId:      initial.id,

      messages: [],
      summary: '',
      compactedUpTo: 0,

      isLoading: false,
      statusText: null,
      error: null,
      pendingWorkflow: null,
      chatModel: null,
      thinkingOverride: null,

      setMessages: (updater) => set((s) => {
        const messages = typeof updater === 'function' ? updater(s.messages) : updater
        // The thread list is only rebuilt when the title is actually written —
        // once per conversation. Touching it on every call would hand a new
        // array to every subscriber on each streamed token, for a list whose
        // rendering never changed.
        const active = s.conversations.find((c) => c.id === s.activeId)
        const title  = active && !active.title ? titleFrom(messages) : ''
        if (!title) return { messages }
        return {
          messages,
          conversations: s.conversations.map((c) => c.id === s.activeId ? { ...c, title } : c),
        }
      }),
      setCompaction: (summary, upTo) => set({ summary, compactedUpTo: upTo }),

      clear: () => set((s) => ({
        messages: [], summary: '', compactedUpTo: 0, error: null, pendingWorkflow: null,
        // Emptied in place: same id, same slot in the list, blank again.
        conversations: s.conversations.map((c) => c.id === s.activeId
          ? { ...emptyConversation(), id: c.id }
          : c),
      })),

      setAgentState: (patch) => set(patch),
      setChatModel: (model) => set({ chatModel: model }),
      setThinkingOverride: (mode) => set({ thinkingOverride: mode }),

      newConversation: () => set((s) => {
        // Already sitting on a blank one: starting a second would stack empty
        // threads every time the button is pressed.
        if (s.messages.length === 0) return {}
        const fresh = emptyConversation()
        // `pendingWorkflow` is deliberately left alone: it tracks the run
        // engine, not this thread. Clearing it makes the run watcher return
        // early, and the finished mesh never reaches the viewer.
        return { conversations: [fresh, ...withLive(s)], ...open(fresh) }
      }),

      switchConversation: (id) => set((s) => {
        if (id === s.activeId) return {}
        const conversations = withLive(s)
        const target = conversations.find((c) => c.id === id)
        if (!target) return {}
        return { conversations, ...open(target) }
      }),

      deleteConversation: (id) => set((s) => {
        const remaining = withLive(s).filter((c) => c.id !== id)
        if (id !== s.activeId) return { conversations: remaining }
        // The open one went: fall back to the next thread, or to a fresh blank
        // one so the store is never left without an active conversation.
        const conversations = remaining.length > 0 ? remaining : [emptyConversation()]
        return { conversations, ...open(conversations[0]) }
      }),

      renameConversation: (id, title) => set((s) => ({
        // Cleared back to empty on purpose: the next message re-derives a title,
        // which is a better answer than pinning a blank name.
        conversations: s.conversations.map((c) =>
          c.id === id ? { ...c, title: shorten(title) } : c),
      })),
    }),
    {
      name: STORAGE_KEY,
      version: 2,
      // v1 was a single thread stored flat — wrap it as the first conversation
      // rather than dropping a history the user may still be working from.
      migrate: (persisted, version) => {
        if (version >= 2) return persisted
        try {
          // Runs during hydration, before persist has written anything back —
          // the key still holds the v1 payload here, and nowhere else.
          const raw = window.localStorage.getItem(STORAGE_KEY)
          if (raw && !window.localStorage.getItem(V1_BACKUP_KEY)) {
            window.localStorage.setItem(V1_BACKUP_KEY, raw)
          }
        } catch { /* no storage, or quota — migrating still beats not loading */ }
        const old = (persisted ?? {}) as { messages?: ChatMessage[]; summary?: string; compactedUpTo?: number }
        const messages = old.messages ?? []
        return {
          conversations: [{
            ...emptyConversation(),
            title:         titleFrom(messages),
            messages,
            summary:       old.summary ?? '',
            compactedUpTo: old.compactedUpTo ?? 0,
          }],
          activeId: undefined,   // resolved by merge below
        }
      },
      // Only the threads are stored; the live copy is rebuilt from the active
      // one on load, so there is exactly one persisted copy of a transcript.
      partialize: (s) => {
        const all  = withLive(s).map(trimForStorage)
        const kept = all.slice(0, MAX_CONVERSATIONS)
        if (!kept.some((c) => c.id === s.activeId)) {
          const active = all.find((c) => c.id === s.activeId)
          if (active) kept[kept.length - 1] = active
        }
        return { conversations: kept, activeId: s.activeId }
      },
      // `messages` is not persisted, so the default shallow merge would restore
      // the thread list next to an empty transcript.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as { conversations?: Conversation[]; activeId?: string }
        const conversations = (p.conversations ?? []).filter((c) => c && typeof c.id === 'string')
        if (conversations.length === 0) return current   // keep the fresh empty conversation
        const active = conversations.find((c) => c.id === p.activeId) ?? conversations[0]
        return {
          ...current,
          conversations,
          activeId:      active.id,
          messages:      active.messages ?? [],
          summary:       active.summary ?? '',
          compactedUpTo: active.compactedUpTo ?? 0,
        }
      },
    },
  ),
)

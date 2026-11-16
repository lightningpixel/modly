import { create } from 'zustand'
import type { AgentAction, ToolStop } from '@shared/utils/agentStream'
// Relative so the store loads under `node --test` (no path aliases there).
import {
  createSerialQueue,
  deriveTitle,
  settleMessages,
  upsertSummary,
  type Conversation,
  type ConversationSummary,
} from '../utils/agentConversations'

// ─── Message types (AgentChat) ────────────────────────────────────────────────

export interface ActionDone extends AgentAction {
  id?: string
  running?: boolean
}

export interface AgentMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  thinking?: string
  /** Attached images, inline as data URLs (persisted as-is). */
  imageDataUrls?: string[]
  actions?: ActionDone[]
  stopped?: ToolStop | null
  streaming?: boolean
}

// ─── Store ────────────────────────────────────────────────────────────────────

const SAVE_DEBOUNCE_MS = 500
/** Unreadable conversations init skips before giving up on reopening one. */
const MAX_INIT_ATTEMPTS = 5

interface AgentConversationState {
  /** Id of the conversation on screen; not on disk until it has a message. */
  currentId: string
  createdAt: number
  messages: AgentMessage[]
  /** Saved conversations, newest first. */
  list: ConversationSummary[]
  /** A turn is streaming or a workflow it started is running: switching would misroute its output. */
  busy: boolean

  setMessages: (update: AgentMessage[] | ((prev: AgentMessage[]) => AgentMessage[])) => void
  setBusy: (busy: boolean) => void
  newConversation: () => Promise<void>
  open: (id: string) => Promise<void>
  remove: (id: string) => Promise<void>
  refreshList: () => Promise<void>
  /** Loads the list and opens the most recent readable conversation. Runs once, retried if it failed. */
  init: () => Promise<void>
  /** Writes a pending debounced save now. */
  flush: () => Promise<void>
}

type OpenResult = 'opened' | 'unreadable' | 'skipped'

function newId(): string {
  return crypto.randomUUID()
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
// Unsaved changes: opening or switching away must not bump an untouched conversation.
let dirty = false
// Bumped on every edit: a save clears `dirty` only if nothing changed while it was writing.
let edits = 0
// Deleted conversations: a save finishing late must not bring one back into the list.
const removedIds = new Set<string>()
let initPromise: Promise<void> | null = null
// Every disk operation runs through this queue, one at a time: a save in
// flight is always awaited, and a delete never races the write of its file.
const enqueue = createSerialQueue()

export const useAgentConversationStore = create<AgentConversationState>()((set, get) => {
  /**
   * Writes the current conversation if it has unsaved changes. Queued tasks only.
   * False when the write failed: the changes stay unsaved and switching away must wait.
   */
  async function saveNow(): Promise<boolean> {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
    const { currentId, createdAt, messages } = get()
    // An empty conversation never reaches the disk.
    if (!dirty || messages.length === 0) return true
    const editsAtStart = edits
    const conversation: Conversation = {
      id: currentId,
      title: deriveTitle(messages),
      createdAt,
      updatedAt: Date.now(),
      messages,
    }
    try {
      await window.electron.agent.conversations.save(conversation)
    } catch (err) {
      // Still dirty: the next change or switch tries again.
      console.error('[agent] Failed to save conversation:', err)
      return false
    }
    if (get().currentId === conversation.id && edits === editsAtStart) dirty = false
    if (!removedIds.has(conversation.id)) {
      set((s) => ({ list: upsertSummary(s.list, { id: conversation.id, title: conversation.title, updatedAt: conversation.updatedAt }) }))
    }
    return true
  }

  function save(): Promise<boolean> {
    return enqueue(saveNow)
  }

  function scheduleSave(): void {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => { void save() }, SAVE_DEBOUNCE_MS)
  }

  /** Queued tasks only. */
  async function openNow(id: string): Promise<OpenResult> {
    if (get().busy || id === get().currentId) return 'skipped'
    // Leaving a conversation whose save failed would lose it.
    if (!(await saveNow())) return 'skipped'
    let conversation: Conversation | null
    try {
      conversation = await window.electron.agent.conversations.read(id)
    } catch (err) {
      console.error('[agent] Failed to read conversation:', err)
      return 'skipped'
    }
    if (!conversation) {
      // Gone or corrupted on disk: drop it from the list.
      set((s) => ({ list: s.list.filter((c) => c.id !== id) }))
      return 'unreadable'
    }
    set({
      currentId: conversation.id,
      createdAt: conversation.createdAt,
      messages: settleMessages(conversation.messages) as AgentMessage[],
    })
    dirty = false
    return 'opened'
  }

  return {
    currentId: newId(),
    createdAt: Date.now(),
    messages: [],
    list: [],
    busy: false,

    setMessages: (update) => {
      set((s) => ({ messages: typeof update === 'function' ? update(s.messages) : update }))
      dirty = true
      edits++
      scheduleSave()
    },

    setBusy: (busy) => set({ busy }),

    newConversation: () => enqueue(async () => {
      if (get().busy) return
      // Leaving a conversation whose save failed would lose it.
      if (!(await saveNow())) return
      set({ currentId: newId(), createdAt: Date.now(), messages: [] })
      dirty = false
    }),

    open: async (id) => { await enqueue(() => openNow(id)) },

    remove: (id) => enqueue(async () => {
      const isCurrent = id === get().currentId
      if (isCurrent && get().busy) return
      try {
        await window.electron.agent.conversations.remove(id)
      } catch (err) {
        // Still on disk, and its pending changes still get saved.
        console.error('[agent] Failed to delete conversation:', err)
        return
      }
      removedIds.add(id)
      if (isCurrent) {
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
        dirty = false
      }
      set((s) => ({
        list: s.list.filter((c) => c.id !== id),
        ...(isCurrent ? { currentId: newId(), createdAt: Date.now(), messages: [] } : {}),
      }))
    }),

    refreshList: () => enqueue(async () => {
      try {
        set({ list: await window.electron.agent.conversations.list() })
      } catch (err) {
        console.error('[agent] Failed to list conversations:', err)
      }
    }),

    init: () => {
      initPromise ??= (async () => {
        // Throws on failure, so a failed init is forgotten and the next call retries.
        const list = await enqueue(() => window.electron.agent.conversations.list())
        set({ list })
        // Open the most recent readable one; unreadable files drop out of the list.
        for (const { id } of list.slice(0, MAX_INIT_ATTEMPTS)) {
          // The user may already have started typing a new conversation.
          if (get().messages.length > 0 || get().busy) return
          if ((await enqueue(() => openNow(id))) !== 'unreadable') return
        }
      })().catch((err: unknown) => {
        console.error('[agent] Failed to load conversations:', err)
        initPromise = null
      })
      return initPromise
    },

    flush: async () => { await save() },
  }
})

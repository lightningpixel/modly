import { create } from 'zustand'
import type { AgentAction, ToolStop } from '@shared/utils/agentStream'
import {
  deriveTitle,
  settleMessages,
  upsertSummary,
  type Conversation,
  type ConversationSummary,
} from '@shared/utils/agentConversations'

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
  newConversation: () => void
  open: (id: string) => Promise<void>
  remove: (id: string) => Promise<void>
  refreshList: () => Promise<void>
  /** Loads the list and opens the most recent conversation. Runs once. */
  init: () => Promise<void>
  /** Writes a pending debounced save now. */
  flush: () => Promise<void>
}

function newId(): string {
  return crypto.randomUUID()
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
// Unsaved changes: opening or switching away must not bump an untouched conversation.
let dirty = false
let initPromise: Promise<void> | null = null

export const useAgentConversationStore = create<AgentConversationState>()((set, get) => {
  async function save(): Promise<void> {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
    const { currentId, createdAt, messages } = get()
    // An empty conversation never reaches the disk.
    if (!dirty || messages.length === 0) return
    dirty = false
    const conversation: Conversation = {
      id: currentId,
      title: deriveTitle(messages),
      createdAt,
      updatedAt: Date.now(),
      messages,
    }
    try {
      await window.electron.agent.conversations.save(conversation)
      set((s) => ({ list: upsertSummary(s.list, { id: conversation.id, title: conversation.title, updatedAt: conversation.updatedAt }) }))
    } catch (err) {
      console.error('[agent] Failed to save conversation:', err)
    }
  }

  function scheduleSave(): void {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => { void save() }, SAVE_DEBOUNCE_MS)
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
      scheduleSave()
    },

    setBusy: (busy) => set({ busy }),

    newConversation: () => {
      if (get().busy) return
      void save()
      set({ currentId: newId(), createdAt: Date.now(), messages: [] })
      dirty = false
    },

    open: async (id) => {
      if (get().busy || id === get().currentId) return
      await save()
      const conversation = await window.electron.agent.conversations.read(id)
      if (!conversation) {
        // Gone or corrupted on disk: drop it from the list.
        set((s) => ({ list: s.list.filter((c) => c.id !== id) }))
        return
      }
      set({
        currentId: conversation.id,
        createdAt: conversation.createdAt,
        messages: settleMessages(conversation.messages) as AgentMessage[],
      })
      dirty = false
    },

    remove: async (id) => {
      const isCurrent = id === get().currentId
      if (isCurrent && get().busy) return
      if (isCurrent) {
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
        dirty = false
      }
      try {
        await window.electron.agent.conversations.remove(id)
      } catch (err) {
        console.error('[agent] Failed to delete conversation:', err)
        return
      }
      set((s) => ({
        list: s.list.filter((c) => c.id !== id),
        ...(isCurrent ? { currentId: newId(), createdAt: Date.now(), messages: [] } : {}),
      }))
    },

    refreshList: async () => {
      try {
        set({ list: await window.electron.agent.conversations.list() })
      } catch (err) {
        console.error('[agent] Failed to list conversations:', err)
      }
    },

    init: () => {
      initPromise ??= (async () => {
        await get().refreshList()
        const latest = get().list[0]
        // The user may already have started typing a new conversation.
        if (latest && get().messages.length === 0 && !get().busy) await get().open(latest.id)
      })()
      return initPromise
    },

    flush: save,
  }
})

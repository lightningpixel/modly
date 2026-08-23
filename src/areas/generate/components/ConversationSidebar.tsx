import { useEffect, useRef, useState } from 'react'
import { useChatStore } from '@shared/stores/chatStore'
import { newConversation, switchConversation, deleteConversation, clearAgentChat } from '@shared/services/agentChat'

/**
 * Chat history, as a drawer over the panel.
 *
 * A drawer rather than a column: the chat panel is already narrow next to the
 * 3D viewer, so a permanent sidebar would take width from the conversation
 * itself. It slides over, and any click outside sends it back.
 */
export default function ConversationSidebar({
  open, onClose, onLeave,
}: {
  open:    boolean
  onClose: () => void
  /** Called after the visible conversation changed, so the panel can reset. */
  onLeave: () => void
}): JSX.Element | null {
  const conversations = useChatStore((s) => s.conversations)
  const activeId      = useChatStore((s) => s.activeId)
  const isEmpty       = useChatStore((s) => s.messages.length === 0)
  const rename        = useChatStore((s) => s.renameConversation)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft]         = useState('')
  const inputRef                  = useRef<HTMLInputElement>(null)

  useEffect(() => { if (editingId) inputRef.current?.select() }, [editingId])
  // A rename left open would reappear, still in edit mode, on the next opening.
  useEffect(() => { if (!open) setEditingId(null) }, [open])

  // Escape closes the drawer, the way every other overlay in the app behaves.
  // While a row is being renamed it discards the typed name instead, so one key
  // never does two things at once.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (editingId) setEditingId(null)
      else onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, editingId, onClose])

  if (!open) return null

  const leave = (act: () => void) => () => { act(); onClose(); onLeave() }

  function startRename(id: string, title: string) {
    setDraft(title)
    setEditingId(id)
  }

  function commitRename() {
    if (!editingId) return
    rename(editingId, draft)
    setEditingId(null)
  }

  return (
    <>
      {/* Catches the click that dismisses the drawer, and dims what is behind.
        * Commits an open rename first: mousedown runs before the browser moves
        * focus, so closing here would unmount the field and its onBlur would
        * never fire — the name the user typed would vanish without a word. */}
      <div className="absolute inset-0 z-40 bg-zinc-950/50" onMouseDown={() => { commitRename(); onClose() }} />

      <aside className="absolute inset-y-0 left-0 z-50 w-[230px] max-w-[85%] bg-zinc-900 border-r border-zinc-800 flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-3 py-2.5 shrink-0">
          <span className="text-[11px] font-medium text-zinc-400">Conversations</span>
          <button onClick={onClose} title="Close history" className="text-zinc-600 hover:text-zinc-300 transition-colors">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <button
          onClick={leave(newConversation)}
          className="mx-2 mb-2 px-2.5 py-2 rounded-lg flex items-center gap-2 text-[11.5px] text-zinc-200 hover:bg-zinc-800 transition-colors shrink-0"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
          </svg>
          New chat
        </button>

        <p className="px-3 pb-1 text-[10px] uppercase tracking-wide text-zinc-600 shrink-0">Recent</p>

        <div className="flex-1 overflow-y-auto min-h-0 px-2 pb-2 flex flex-col gap-0.5">
          {conversations.map((c) => (
            <div
              key={c.id}
              className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 transition-colors ${
                c.id === activeId ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800/60'
              }`}
            >
              {editingId === c.id ? (
                <input
                  ref={inputRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => { if (e.key === 'Enter') commitRename() }}
                  placeholder="Conversation name"
                  className="flex-1 min-w-0 bg-zinc-950/60 border border-zinc-700 rounded px-1.5 py-0.5 text-[11px] text-zinc-100 focus:outline-none focus:border-accent/50"
                />
              ) : (
                <>
                  <button
                    onClick={leave(() => switchConversation(c.id))}
                    onDoubleClick={() => startRename(c.id, c.title)}
                    className="flex-1 min-w-0 text-left text-[11px] truncate"
                  >
                    {c.title || 'New conversation'}
                  </button>
                  {/* Only on hover, and on the open one, so a narrow row is not
                    * two thirds icons. */}
                  <button
                    onClick={() => startRename(c.id, c.title)}
                    title="Rename"
                    className="shrink-0 opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-zinc-200 transition-opacity"
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
                    </svg>
                  </button>
                  {/* Deleting the open thread falls back to the next one, so the
                    * drawer can stay open on it — but the panel behind is now
                    * showing another transcript and has to be told. */}
                  <button
                    onClick={() => { const wasOpen = c.id === activeId; deleteConversation(c.id); if (wasOpen) onLeave() }}
                    title="Delete"
                    className="shrink-0 opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-red-400 transition-opacity"
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </>
              )}
            </div>
          ))}
        </div>

        <button
          onClick={leave(clearAgentChat)}
          disabled={isEmpty}
          className="px-3 py-2 text-left text-[11px] text-zinc-500 hover:text-red-400 hover:bg-zinc-800 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-zinc-500 border-t border-zinc-800 transition-colors shrink-0"
        >
          Clear this conversation
        </button>
      </aside>
    </>
  )
}

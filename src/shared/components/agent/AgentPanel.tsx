import { useEffect, useRef, useState } from 'react'
import {
  AGENT_PANEL_DEFAULT_WIDTH,
  AGENT_PANEL_MAX_WIDTH,
  AGENT_PANEL_MIN_WIDTH,
  clampPanelWidth,
  useAgentPanelStore,
} from '@shared/stores/agentPanelStore'
import { useAgentConversationStore } from '@shared/stores/agentConversationStore'
import { UNTITLED, deriveTitle, relativeDate } from '@shared/utils/agentConversations'
import AgentChat from './AgentChat'
import { useConfirmQueue } from './ConfirmCard'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
}

function IconButton({ label, onClick, pressed, disabled, children }: {
  label: string
  onClick: () => void
  pressed?: boolean
  disabled?: boolean
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      className={`w-7 h-7 flex items-center justify-center rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
        pressed ? 'bg-accent/20 text-accent-light' : 'text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800'
      }`}
    >
      {children}
    </button>
  )
}

// ─── Conversation list ────────────────────────────────────────────────────────

function ConversationList({ onPicked }: { onPicked: () => void }): JSX.Element {
  const list      = useAgentConversationStore((s) => s.list)
  const currentId = useAgentConversationStore((s) => s.currentId)
  const busy      = useAgentConversationStore((s) => s.busy)
  const open      = useAgentConversationStore((s) => s.open)
  const remove    = useAgentConversationStore((s) => s.remove)
  // Delete takes two clicks: the first arms it.
  const [armedId, setArmedId] = useState<string | null>(null)
  const now = Date.now()

  if (list.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-6">
        <p className="text-[11px] text-zinc-600 text-center leading-relaxed">No saved conversations yet.</p>
      </div>
    )
  }

  return (
    <ul className="flex-1 overflow-y-auto py-1.5" onMouseLeave={() => setArmedId(null)}>
      {list.map((c) => {
        const active = c.id === currentId
        const locked = busy && !active
        return (
          <li key={c.id} className="group relative mx-1.5">
            <button
              onClick={() => { void open(c.id).then(onPicked) }}
              disabled={locked}
              className={`w-full flex flex-col gap-0.5 pl-3 pr-9 py-2 rounded-lg text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                active ? 'bg-accent/15' : 'hover:bg-zinc-800/70'
              }`}
            >
              <span className={`text-[12px] truncate ${active ? 'text-accent-light' : 'text-zinc-200'}`}>{c.title || UNTITLED}</span>
              <span className="text-[10px] text-zinc-500">{relativeDate(c.updatedAt, now)}</span>
            </button>
            <button
              onClick={() => {
                if (armedId !== c.id) { setArmedId(c.id); return }
                setArmedId(null)
                void remove(c.id)
              }}
              disabled={active && busy}
              title={armedId === c.id ? 'Click again to delete' : 'Delete conversation'}
              aria-label={armedId === c.id ? `Confirm delete ${c.title}` : `Delete ${c.title}`}
              className={`absolute right-1.5 top-1/2 -translate-y-1/2 h-6 flex items-center justify-center rounded transition-all disabled:hidden ${
                armedId === c.id
                  ? 'px-1.5 bg-red-600/90 text-white text-[10px] font-medium opacity-100'
                  : 'w-6 text-zinc-500 hover:text-red-400 hover:bg-zinc-700/60 opacity-0 group-hover:opacity-100 focus:opacity-100'
              }`}
            >
              {armedId === c.id ? 'Delete' : (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
              )}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

// ─── Panel ────────────────────────────────────────────────────────────────────

export default function AgentPanel(): JSX.Element {
  const open     = useAgentPanelStore((s) => s.open)
  const width    = useAgentPanelStore((s) => s.width)
  const setOpen  = useAgentPanelStore((s) => s.setOpen)
  const toggle   = useAgentPanelStore((s) => s.toggle)
  const setWidth = useAgentPanelStore((s) => s.setWidth)

  const messages        = useAgentConversationStore((s) => s.messages)
  const busy            = useAgentConversationStore((s) => s.busy)
  const newConversation = useAgentConversationStore((s) => s.newConversation)

  const [showList, setShowList]     = useState(false)
  const [dragWidth, setDragWidth]   = useState<number | null>(null)
  const panelRef                    = useRef<HTMLElement>(null)
  const dragRef                     = useRef<{ startX: number; startWidth: number } | null>(null)

  const shownWidth = dragWidth ?? width
  const title = messages.length > 0 ? deriveTitle(messages) : UNTITLED

  // Load the saved conversations and reopen the latest; save before quitting.
  useEffect(() => {
    const { init, flush } = useAgentConversationStore.getState()
    void init()
    const onUnload = () => { void flush() }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [])

  // A confirm card is waiting for a click: show it, even if the panel was
  // closed mid-turn or the conversation list covered the chat.
  useEffect(() => {
    const { setOnQueued } = useConfirmQueue.getState()
    setOnQueued(() => {
      setOpen(true)
      setShowList(false)
    })
    return () => setOnQueued(null)
  }, [setOpen])

  // Ctrl+L / Cmd+L toggles the panel, except while typing elsewhere.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'l') return
      const target = e.target as Node | null
      if (isEditable(e.target) && !panelRef.current?.contains(target)) return
      e.preventDefault()
      toggle()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [toggle])

  // Opening the panel puts the cursor in the chat input.
  useEffect(() => {
    if (!open || showList) return
    panelRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus()
  }, [open, showList])

  // ── Resize ──
  function onHandlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { startX: e.clientX, startWidth: width }
    setDragWidth(width)
  }

  function onHandlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag) return
    // The panel sits on the right: dragging left widens it.
    setDragWidth(clampPanelWidth(drag.startWidth + drag.startX - e.clientX))
  }

  function onHandlePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    dragRef.current = null
    if (dragWidth !== null) setWidth(dragWidth)
    setDragWidth(null)
  }

  function onHandleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? 64 : 16
    if (e.key === 'ArrowLeft')  { e.preventDefault(); setWidth(width + step) }
    if (e.key === 'ArrowRight') { e.preventDefault(); setWidth(width - step) }
  }

  const dragging = dragWidth !== null

  return (
    // The slot grows from 0 to the panel width, pushing the app aside, while
    // the panel slides in from the right. Closed, it stays mounted (a streaming
    // turn or a running workflow keeps going) but invisible, so it takes no
    // focus once the slide-out has ended.
    <div
      aria-hidden={!open}
      style={{
        width: open ? shownWidth : 0,
        transition: dragging ? 'none' : `width 220ms cubic-bezier(0.22, 1, 0.36, 1), visibility 0s linear ${open ? '0s' : '220ms'}`,
      }}
      className={`relative shrink-0 overflow-hidden motion-reduce:!transition-none ${open ? 'visible' : 'invisible'}`}
    >
    <aside
      ref={panelRef}
      aria-label="Agent"
      style={{ width: shownWidth }}
      className={`absolute inset-y-0 left-0 flex flex-col bg-surface-400 border-l border-zinc-800 min-h-0
        transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none
        ${open ? 'translate-x-0 opacity-100' : 'translate-x-6 opacity-0'}`}
    >
      {/* Resize handle */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize agent panel"
        aria-valuemin={AGENT_PANEL_MIN_WIDTH}
        aria-valuemax={AGENT_PANEL_MAX_WIDTH}
        aria-valuenow={shownWidth}
        tabIndex={0}
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={onHandlePointerUp}
        onPointerCancel={onHandlePointerUp}
        onDoubleClick={() => setWidth(AGENT_PANEL_DEFAULT_WIDTH)}
        onKeyDown={onHandleKeyDown}
        title="Drag to resize · double-click to reset"
        className="absolute left-0 top-0 bottom-0 w-2 z-20 cursor-col-resize group focus:outline-none"
      >
        <div className={`h-full w-px transition-colors ${
          dragWidth !== null ? 'bg-accent' : 'bg-transparent group-hover:bg-accent/60 group-focus-visible:bg-accent/60'
        }`} />
      </div>

      {/* Header */}
      <div className="shrink-0 h-10 flex items-center gap-2 pl-3.5 pr-1.5 border-b border-zinc-800">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="w-5 h-5 rounded-md bg-accent/15 border border-accent/25 flex items-center justify-center text-accent-light shrink-0">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <rect x="3" y="11" width="18" height="10" rx="2" />
              <circle cx="12" cy="5" r="2" /><path d="M12 7v4" />
            </svg>
          </span>
          <span className="text-xs font-semibold text-zinc-200 shrink-0">Agent</span>
          <span className="text-[11px] text-zinc-500 truncate" title={title}>{showList ? 'Conversations' : title}</span>
        </div>

        <IconButton
          label="Conversations"
          pressed={showList}
          onClick={() => {
            if (!showList) void useAgentConversationStore.getState().refreshList()
            setShowList((v) => !v)
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l3 2" />
          </svg>
        </IconButton>
        <IconButton
          label={busy ? 'Wait for the current answer to finish' : 'New conversation'}
          disabled={busy}
          onClick={() => { newConversation(); setShowList(false) }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
        </IconButton>
        <IconButton label="Close (Ctrl+L)" onClick={() => setOpen(false)}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </IconButton>
      </div>

      {/* Body: the chat stays mounted under the list */}
      <div className="relative flex flex-col flex-1 min-h-0">
        <AgentChat />
        {showList && (
          <div className="absolute inset-0 z-10 flex flex-col bg-surface-400">
            <ConversationList onPicked={() => setShowList(false)} />
          </div>
        )}
      </div>
    </aside>
    </div>
  )
}

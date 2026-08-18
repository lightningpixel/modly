import { useEffect, useRef, useState } from 'react'
import { useOutsideClick } from '@shared/hooks/useOutsideClick'
import { appliedSomething } from '@shared/services/agentHistory'
import { useAppStore } from '@shared/stores/appStore'
import { useAgentStore, providerBaseUrl } from '@shared/stores/agentStore'
import { ModelLibraryModal } from '@shared/components/ui/ModelLibraryModal'
import { useWorkflowsStore } from '@shared/stores/workflowsStore'
import { useWorkflowRunStore, pauseKind } from '@areas/workflows/workflowRunStore'
import {
  sendUserMessage, stopAgent, clearAgentChat,
  newConversation, switchConversation, deleteConversation,
} from '@shared/services/agentChat'

// ─── Types ────────────────────────────────────────────────────────────────────

import type { ThinkingMode } from '@shared/stores/agentStore'
import type { Workflow } from '@shared/types/electron.d'
import { useChatStore } from '@shared/stores/chatStore'
import type { ChatMessage as Message, ActionDone } from '@shared/stores/chatStore'

// ─── Constants ────────────────────────────────────────────────────────────────

const COLLAPSE_AFTER = 4

// ─── Prose renderer — basic markdown-like ────────────────────────────────────

function ProseMessage({ content }: { content: string }): JSX.Element {
  const blocks = content.split(/\n\n+/)
  return (
    <div className="flex flex-col gap-2.5 text-[12.5px] leading-relaxed text-zinc-200">
      {blocks.map((block, i) => {
        const lines = block.split('\n')
        const isList = lines.every((l) => /^[-•*]\s/.test(l.trim()) || l.trim() === '')
        if (isList) {
          return (
            <ul key={i} className="flex flex-col gap-1 pl-3">
              {lines.filter(Boolean).map((l, j) => (
                <li key={j} className="flex gap-2">
                  <span className="text-zinc-500 shrink-0 mt-px">•</span>
                  <span>{l.replace(/^[-•*]\s/, '')}</span>
                </li>
              ))}
            </ul>
          )
        }
        return (
          <p key={i} className="whitespace-pre-wrap">
            {block}
          </p>
        )
      })}
    </div>
  )
}

// ─── Actions card ─────────────────────────────────────────────────────────────

// Keep in sync with TOOLS in api/routers/agent.py — an unmapped tool falls back
// to its raw snake_case name in the actions card.
const TOOL_LABELS: Record<string, string> = {
  decimate_mesh:         'Decimated mesh',
  smooth_mesh:           'Smoothed mesh',
  scale_mesh:            'Scaled mesh',
  rotate_mesh:           'Rotated mesh',
  export_mesh:           'Exported mesh',
  unload_models:         'Unloaded models',
  list_workflows:        'Listed workflows',
  get_workflow_details:  'Inspected workflow',
  get_extension_params:  'Read extension params',
  get_extension_errors:  'Checked extension errors',
  run_workflow:          'Ran workflow',
  continue_workflow:     'Resumed workflow',
  create_workflow:       'Created workflow',
  update_workflow:       'Updated workflow',
  set_param:             'Set parameter',
  delete_workflow:       'Deleted workflow',
  fix_workflow_wiring:   'Connected nodes',
  remember:              'Saved to memory',
  recall:                'Read memory',
}

function ActionsCard({ actions, onUndo }: { actions: ActionDone[]; onUndo?: () => void }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const meshActions = actions.filter((a) => a.payload?.type === 'mesh_update')
  const canUndo = meshActions.length > 0 && !!onUndo

  return (
    <div className="rounded-xl border border-zinc-700/50 bg-zinc-800/40 overflow-hidden text-[11px]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-700/40">
        <span className="text-zinc-300 font-medium">
          {actions.length} action{actions.length > 1 ? 's' : ''} performed
        </span>
        <div className="flex items-center gap-2">
          {canUndo && (
            <button
              onClick={onUndo}
              className="flex items-center gap-1 text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 7v6h6" /><path d="M3 13a9 9 0 1 0 2.28-5.93" />
              </svg>
              Undo
            </button>
          )}
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
              className={`transition-transform ${expanded ? 'rotate-180' : ''}`}>
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        </div>
      </div>

      {/* Rows */}
      {expanded && (
        <div className="flex flex-col divide-y divide-zinc-700/30">
          {actions.map((a, i) => (
            <div key={i} className="flex items-center justify-between px-3 py-1.5">
              <span className="text-zinc-400">{TOOL_LABELS[a.tool] ?? a.tool.replace(/_/g, ' ')}</span>
              {a.payload?.type === 'mesh_update' && a.payload.face_count && (
                <span className="text-emerald-400 font-mono">{a.payload.face_count.toLocaleString()} faces</span>
              )}
              {a.payload?.type === 'run_workflow' && (
                <span className="text-violet-400">{a.payload.workflow_name}</span>
              )}
              {a.payload?.type === 'create_workflow' && a.payload.workflow && (
                <span className="text-violet-400">{a.payload.workflow.name}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Feedback row ─────────────────────────────────────────────────────────────

function FeedbackRow({ content, onRate }: { content: string; onRate?: (rating: 'good' | 'bad') => void }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const [rated, setRated]   = useState<'good' | 'bad' | null>(null)

  function handleCopy() {
    navigator.clipboard.writeText(content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  function handleRate(rating: 'good' | 'bad') {
    if (rated) return
    setRated(rating)
    onRate?.(rating)
  }

  return (
    <div className="flex items-center gap-2 pt-0.5">
      <button
        onClick={handleCopy}
        title="Copy"
        className="text-zinc-600 hover:text-zinc-400 transition-colors"
      >
        {copied ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
      </button>
      <button
        title="Good response"
        onClick={() => handleRate('good')}
        className={`transition-colors ${rated === 'good' ? 'text-emerald-400' : rated ? 'text-zinc-800' : 'text-zinc-600 hover:text-zinc-400'}`}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z" />
          <path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
        </svg>
      </button>
      <button
        title="Bad response"
        onClick={() => handleRate('bad')}
        className={`transition-colors ${rated === 'bad' ? 'text-red-400' : rated ? 'text-zinc-800' : 'text-zinc-600 hover:text-zinc-400'}`}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z" />
          <path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17" />
        </svg>
      </button>
    </div>
  )
}

// ─── Thinking block ───────────────────────────────────────────────────────────

function ThinkingBlock({ content }: { content: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="text-[11px]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-zinc-500 hover:text-zinc-400 transition-colors"
      >
        {/* brain icon */}
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/>
          <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"/>
        </svg>
        <span>Reasoning</span>
        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          className={`transition-transform ${open ? 'rotate-180' : ''}`}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="mt-2 pl-3 border-l-2 border-zinc-700">
          <p className="text-zinc-500 italic leading-relaxed whitespace-pre-wrap">{content}</p>
        </div>
      )}
    </div>
  )
}

// ─── Workflow progress card ────────────────────────────────────────────────────

function WorkflowProgressCard({ name }: { name: string }): JSX.Element {
  const runState        = useWorkflowRunStore((s) => s.runState)
  const waitStates      = useWorkflowRunStore((s) => s.waitStates)
  const runningBranchId = useWorkflowRunStore((s) => s.runningBranchId)
  const pct = runState.blockProgress

  // A Wait handoff and a loop boundary both report status 'paused'; only
  // pauseKind tells them apart, and resuming the wrong way is a silent no-op.
  const pause      = pauseKind({ runState, runningBranchId, waitStates })
  const loopPaused = pause?.kind === 'loop'
  const isPaused   = pause !== null

  function handleContinue() {
    const st = useWorkflowRunStore.getState()
    if (pause?.kind === 'loop')      st.continueWhile()
    else if (pause?.kind === 'wait') void st.continueRun(pause.waitId)
  }

  return (
    <div className="rounded-xl border border-zinc-700/50 bg-zinc-800/40 px-3 py-2.5 flex flex-col gap-2">
      <div className="flex items-center justify-between text-[11px]">
        <div className="flex items-center gap-2">
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isPaused ? 'bg-amber-400' : 'bg-accent animate-pulse'}`} />
          <span className="text-zinc-300 font-medium truncate">{name}</span>
        </div>
        <span className="text-zinc-500 shrink-0">{isPaused ? 'paused' : `${pct}%`}</span>
      </div>
      <div className="h-0.5 bg-zinc-700 rounded-full overflow-hidden">
        <div className="h-full bg-accent rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
      </div>
      {runState.blockStep && (
        <p className="text-[10px] text-zinc-500 truncate">{runState.blockStep}</p>
      )}
      {isPaused && (
        <div className="flex gap-2 pt-0.5">
          <button
            onClick={handleContinue}
            className="px-2.5 py-1 rounded-lg bg-accent/15 border border-accent/40 text-accent text-[10.5px] hover:bg-accent/25 transition-colors"
          >
            Continue
          </button>
          {loopPaused && (
            <button
              onClick={() => useWorkflowRunStore.getState().retryWhile()}
              className="px-2.5 py-1 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-300 text-[10.5px] hover:bg-zinc-700 transition-colors"
            >
              Retry
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Conversations menu ───────────────────────────────────────────────────────

/** Start / switch / delete a thread, and empty the open one. Owns its own
 *  open-close state: the panel above only needs to know when the visible
 *  conversation changed (`onLeave`). */
function ConversationsMenu({ onLeave }: { onLeave: () => void }): JSX.Element {
  const conversations = useChatStore((s) => s.conversations)
  const activeId      = useChatStore((s) => s.activeId)
  const isEmpty       = useChatStore((s) => s.messages.length === 0)

  const [open, setOpen] = useState(false)
  const ref             = useRef<HTMLDivElement>(null)
  useOutsideClick(ref, open, () => setOpen(false))

  const leave = (act: () => void) => () => { act(); setOpen(false); onLeave() }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        title="Conversations"
        className={`transition-colors ${open ? 'text-zinc-300' : 'text-zinc-600 hover:text-zinc-400'}`}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </button>

      {open && (
        <div className="absolute bottom-full mb-2 left-0 z-50 bg-zinc-900 border border-zinc-700/60 rounded-xl shadow-xl overflow-hidden min-w-[220px] max-w-[300px]">
          <button
            onClick={leave(newConversation)}
            className="w-full px-3 py-2 text-left text-[11px] text-accent hover:bg-zinc-800 transition-colors flex items-center gap-2 border-b border-zinc-800"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            New conversation
          </button>

          <div className="max-h-56 overflow-y-auto">
            {conversations.map((c) => (
              <div
                key={c.id}
                className={`group flex items-center gap-2 px-3 py-2 hover:bg-zinc-800 transition-colors ${c.id === activeId ? 'text-zinc-100' : 'text-zinc-400'}`}
              >
                <button
                  onClick={leave(() => switchConversation(c.id))}
                  className="flex-1 min-w-0 text-left text-[11px] truncate"
                >
                  {c.title || 'New conversation'}
                </button>
                {c.id === activeId && <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />}
                {/* Deleting the open thread falls back to the next one, so this
                  * is never a dead end — the menu can stay open. */}
                <button
                  onClick={() => deleteConversation(c.id)}
                  title="Delete conversation"
                  className="shrink-0 text-zinc-700 group-hover:text-zinc-500 hover:!text-red-400 transition-colors"
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            ))}
          </div>

          {!isEmpty && (
            <button
              onClick={leave(clearAgentChat)}
              className="w-full px-3 py-2 text-left text-[11px] text-zinc-500 hover:text-red-400 hover:bg-zinc-800 transition-colors border-t border-zinc-800"
            >
              Clear this conversation
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Main component ──────────────────────────────────────────────────────────

export default function ChatPanel(): JSX.Element {
  const { provider, localModel, external, defaultThinking } = useAgentStore()

  const externalCfg   = external[provider]
  const defaultModel  = provider === 'local' ? localModel : (externalCfg?.model ?? '')

  const messages      = useChatStore((s) => s.messages)

  // Live agent state — owned by the agentChat service so the stream and the
  // workflow watcher survive page switches; this component only renders it.
  const isLoading        = useChatStore((s) => s.isLoading)
  const statusText       = useChatStore((s) => s.statusText)
  const error            = useChatStore((s) => s.error)
  const pendingWorkflow  = useChatStore((s) => s.pendingWorkflow)
  const chatModel        = useChatStore((s) => s.chatModel)
  const thinkingOverride = useChatStore((s) => s.thinkingOverride)
  const setChatModel        = useChatStore((s) => s.setChatModel)
  const setThinkingOverride = useChatStore((s) => s.setThinkingOverride)
  const setAgentState       = useChatStore((s) => s.setAgentState)

  const model        = chatModel ?? defaultModel
  const thinkingMode: ThinkingMode = thinkingOverride ?? defaultThinking

  const [input, setInput]                     = useState('')
  const [showAll, setShowAll]                 = useState(false)
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [pickerModels, setPickerModels]       = useState<string[]>([])
  const [showLibrary, setShowLibrary]         = useState(false)
  const [attachments, setAttachments]         = useState<string[]>([]) // data URLs
  const [isDragging, setIsDragging]           = useState(false)
  const [showWfPicker, setShowWfPicker]       = useState(false)
  const wfPickerRef                           = useRef<HTMLDivElement>(null)
  const endRef                                = useRef<HTMLDivElement>(null)
  const textareaRef                           = useRef<HTMLTextAreaElement>(null)
  const modelPickerRef                        = useRef<HTMLDivElement>(null)
  const fileInputRef                          = useRef<HTMLInputElement>(null)
  const messagesRef                           = useRef<Message[]>([])
  messagesRef.current = messages
  const lastSentRef                           = useRef<{ text: string; attachments: string[] } | null>(null)

  const apiUrl   = useAppStore((s) => s.apiUrl)
  const undoMesh = useAppStore((s) => s.undoMesh)

  const workflows         = useWorkflowsStore((s) => s.workflows)
  const setActiveWorkflow = useWorkflowsStore((s) => s.setActive)
  const openIds           = useWorkflowsStore((s) => s.openIds)
  const activeWorkflowId  = useWorkflowsStore((s) => s.activeId)
  const openWorkflows = openIds
    .map((id) => workflows.find((w) => w.id === id))
    .filter((w): w is Workflow => !!w)
  const activeWorkflow = workflows.find((w) => w.id === activeWorkflowId)

  // A picked chat model belongs to one provider — drop the override when the
  // provider changes in Settings (skip mount so vision auto-switch stays sticky).
  const providerRef = useRef(provider)
  useEffect(() => {
    if (providerRef.current !== provider) { providerRef.current = provider; setChatModel(null) }
  }, [provider, setChatModel])

  useOutsideClick(modelPickerRef, showModelPicker, () => setShowModelPicker(false))
  useOutsideClick(wfPickerRef, showWfPicker, () => setShowWfPicker(false))

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isLoading, pendingWorkflow])

  function sendFeedback(msg: Message, rating: 'good' | 'bad') {
    const all = messagesRef.current
    const idx = all.findIndex((m) => m.id === msg.id)
    const lastUser = all.slice(0, idx === -1 ? all.length : idx).reverse().find((m) => m.role === 'user')
    void fetch(`${apiUrl}/agent/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rating,
        message: msg.content,
        user_message: lastUser?.content ?? '',
        model,
        provider,
        tools_used: msg.actions?.map((a) => a.tool) ?? [],
      }),
    }).catch(() => {})
  }

  function handleStop() {
    stopAgent()
  }

  /** What the panel itself has to forget when the visible conversation changes:
   *  the collapsed-history toggle, and the message the Retry button would
   *  otherwise re-send into a thread that never asked for it. */
  function resetPanelView() {
    setShowAll(false)
    lastSentRef.current = null
  }

  async function fetchPickerModels() {
    try {
      if (provider === 'local') {
        const res = await fetch(`${apiUrl}/llm/models`)
        const data: { models?: { id: string; downloaded: boolean; source?: string; tags?: string[] }[] } = await res.json()
        // Chat is for general/vision/custom models — code & CAD models are node tools
        setPickerModels(
          (data.models ?? [])
            .filter((m) => m.downloaded)
            .filter((m) => m.source === 'custom' || !(m.tags ?? []).some((t) => t === 'code' || t === 'cad'))
            .map((m) => m.id),
        )
      } else {
        const base = providerBaseUrl(provider, externalCfg)
        // POST, not a query string: a GET would put the API key in the uvicorn
        // access log, which ends up in runtime.log and in users' bug reports.
        const res = await fetch(`${apiUrl}/agent/external/models`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ base_url: base, api_key: externalCfg?.apiKey ?? '' }),
        })
        const data: { models?: string[] } = await res.json()
        setPickerModels(data.models ?? [])
      }
    } catch {
      setPickerModels([])
    }
  }

  function handleFiles(files: File[]) {
    files.forEach((file) => {
      if (!file.type.startsWith('image/')) return
      const reader = new FileReader()
      reader.onload = (e) => {
        const dataUrl = e.target?.result as string
        setAttachments((prev) => [...prev, dataUrl])
      }
      reader.readAsDataURL(file)
    })
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(true)
  }

  function handleDragLeave(e: React.DragEvent) {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setIsDragging(false)
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(false)
    handleFiles(Array.from(e.dataTransfer.files))
  }

  function adjustHeight() {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }

  async function handleSend() {
    const text = input.trim()
    if (!text || isLoading || pendingWorkflow) return

    const atts = [...attachments]
    setInput('')
    setAttachments([])
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    lastSentRef.current = { text, attachments: atts }
    await sendUserMessage(text, atts)
  }

  function handleDismissError() {
    setAgentState({ error: null })
  }

  async function handleRetry() {
    setAgentState({ error: null })
    const last = lastSentRef.current
    if (last) await sendUserMessage(last.text, last.attachments)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
  }

  // Collapsed history
  const collapsed = !showAll && messages.length > COLLAPSE_AFTER
  const hidden    = collapsed ? messages.length - COLLAPSE_AFTER : 0
  const visible   = collapsed ? messages.slice(-COLLAPSE_AFTER) : messages

  return (
    <div
      className="flex flex-col flex-1 min-h-0 relative"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center rounded-xl border-2 border-dashed border-accent/60 bg-accent/5 pointer-events-none">
          <p className="text-[12px] text-accent font-medium">Drop image here</p>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto min-h-0 flex flex-col">

        {/* Empty state */}
        {messages.length === 0 && (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 px-5 py-10">
            <div className="w-9 h-9 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center text-accent">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="3" y="11" width="18" height="10" rx="2" />
                <circle cx="12" cy="5" r="2" /><path d="M12 7v4" />
              </svg>
            </div>
            <p className="text-[11px] text-zinc-500 text-center leading-relaxed">
              Ask me to generate, optimize,<br />or run a workflow.
            </p>
          </div>
        )}

        {/* Previous messages pill */}
        {collapsed && (
          <button
            onClick={() => setShowAll(true)}
            className="mx-4 mt-4 mb-1 flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors self-start"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="6 9 12 15 18 9" />
            </svg>
            {hidden} previous message{hidden > 1 ? 's' : ''}
          </button>
        )}

        {/* Message list */}
        <div className="flex flex-col px-4 py-3 gap-5 select-text">
          {visible.map((msg) => (
            <div key={msg.id}>
              {msg.notice ? (
                /* Info line (model auto-switch, etc.) */
                <p className="text-[10.5px] text-zinc-500 italic text-center px-2">{msg.content}</p>
              ) : msg.role === 'user' ? (
                /* User message */
                <div className="flex flex-col items-end gap-1.5">
                  {msg.imageDataUrls && msg.imageDataUrls.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 justify-end max-w-[80%]">
                      {msg.imageDataUrls.map((url, i) => (
                        <img key={i} src={url} alt="" className="max-h-36 max-w-full rounded-xl object-cover border border-zinc-700/50" />
                      ))}
                    </div>
                  )}
                  <div className="max-w-[80%] px-3 py-2 rounded-2xl rounded-br-sm bg-zinc-800 border border-zinc-700/50 text-[12px] text-zinc-200 leading-relaxed">
                    {msg.content}
                  </div>
                </div>
              ) : (
                /* Assistant message */
                <div className="flex flex-col gap-3">
                  {msg.thinking && <ThinkingBlock content={msg.thinking} />}
                  {msg.imageUrls && msg.imageUrls.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {msg.imageUrls.map((url, i) => (
                        <img key={i} src={`${apiUrl}${url}`} alt="Workflow output"
                          className="h-36 max-w-full rounded-xl object-contain border border-zinc-700/50 bg-zinc-900/40"
                          style={{ imageRendering: 'pixelated' }} />
                      ))}
                    </div>
                  )}
                  {msg.content && <ProseMessage content={msg.content} />}
                  {msg.actions && msg.actions.length > 0 && (
                    <ActionsCard actions={msg.actions} onUndo={undoMesh} />
                  )}
                  {/* The model can describe an edit it never made — in a first-run
                    * session it claimed three in a row without calling a tool. The
                    * app knows the truth, so it says it: no payload, no change.
                    * Shown on chat-only replies too, which is the point — the user
                    * can tell talk from action without reading the wording. */}
                  {!msg.streaming && msg.content && !appliedSomething(msg.actions) && (
                    <p className="text-[11px] text-zinc-500 italic">No changes were applied.</p>
                  )}
                  {!msg.streaming && msg.content && (
                    <FeedbackRow content={msg.content} onRate={(rating) => sendFeedback(msg, rating)} />
                  )}
                </div>
              )}
            </div>
          ))}

          {/* Workflow progress card — visible while agent waits for workflow */}
          {pendingWorkflow && <WorkflowProgressCard name={pendingWorkflow.name} />}

          {/* Loading indicator */}
          {isLoading && (
            <div className="flex gap-2 items-center py-1">
              <div className="flex gap-1 items-center">
                {[0, 1, 2].map((i) => (
                  <span key={i}
                    className="w-1.5 h-1.5 rounded-full bg-zinc-600 animate-bounce"
                    style={{ animationDelay: `${i * 130}ms` }}
                  />
                ))}
              </div>
              {statusText && <span className="text-[11px] text-zinc-500">{statusText}</span>}
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="px-3 py-2 rounded-lg bg-red-950/40 border border-red-800/40 flex items-start justify-between gap-2">
              <p className="text-[11px] text-red-400 flex-1">{error}</p>
              <div className="flex items-center gap-2 shrink-0">
                {lastSentRef.current && (
                  <button
                    onClick={handleRetry}
                    className="text-[10.5px] text-red-300 hover:text-red-100 underline underline-offset-2 transition-colors"
                  >
                    Retry
                  </button>
                )}
                <button
                  onClick={handleDismissError}
                  aria-label="Dismiss error"
                  className="text-red-400/70 hover:text-red-200 transition-colors"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            </div>
          )}

          <div ref={endRef} />
        </div>
      </div>

      {/* Input bar */}
      <div className="shrink-0 px-3 pb-3 pt-2 border-t border-zinc-800">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => { if (e.target.files) handleFiles(Array.from(e.target.files)); e.target.value = '' }}
        />
        <div className="flex flex-col gap-1.5 bg-zinc-900 border border-zinc-700/60 rounded-2xl px-3 py-2.5">
          {/* Attachment previews */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {attachments.map((url, i) => (
                <div key={i} className="relative group">
                  <img src={url} alt="" className="h-14 w-14 object-cover rounded-lg border border-zinc-700/50" />
                  <button
                    onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                    className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-zinc-700 border border-zinc-600 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => { setInput(e.target.value); adjustHeight() }}
            onKeyDown={handleKeyDown}
            placeholder="Ask Modly…"
            rows={1}
            spellCheck={false}
            className="w-full bg-transparent text-[12.5px] text-zinc-200 placeholder-zinc-600 focus:outline-none resize-none leading-relaxed overflow-hidden"
          />
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
            {/* Attach image button */}
            <button
              onClick={() => fileInputRef.current?.click()}
              title="Attach image"
              className="text-zinc-600 hover:text-zinc-400 transition-colors"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="16" /><line x1="8" y1="12" x2="16" y2="12" />
              </svg>
            </button>
            <ConversationsMenu onLeave={resetPanelView} />
            {/* Thinking toggle */}
            <button
              onClick={() => setThinkingOverride(thinkingMode === 'auto' ? 'on' : thinkingMode === 'on' ? 'off' : 'auto')}
              title={`Thinking: ${thinkingMode}`}
              className={`transition-colors ${thinkingMode === 'on' ? 'text-accent' : thinkingMode === 'off' ? 'text-zinc-700' : 'text-zinc-600 hover:text-zinc-400'}`}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/>
                <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"/>
                {thinkingMode === 'off' && <line x1="4" y1="4" x2="20" y2="20" strokeWidth="2" />}
              </svg>
            </button>
            {/* Model selector */}
            <div className="relative" ref={modelPickerRef}>
              <button
                onClick={() => { setShowModelPicker((v) => !v); if (!showModelPicker) fetchPickerModels() }}
                className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                {model || 'no model'}
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>

              {showModelPicker && (
                <div className="absolute bottom-full mb-2 left-0 z-50 bg-zinc-900 border border-zinc-700/60 rounded-xl shadow-xl overflow-hidden min-w-[180px]">
                  {pickerModels.length === 0 ? (
                    <p className="px-3 py-2.5 text-[11px] text-zinc-500">
                      {provider === 'local'
                        ? 'No local models downloaded yet.'
                        : 'No models found — check the API key in Settings → Agent.'}
                    </p>
                  ) : (
                    pickerModels.map((m) => (
                      <button
                        key={m}
                        onClick={() => { setChatModel(m); setShowModelPicker(false) }}
                        className={`w-full px-3 py-2 text-left text-[11px] hover:bg-zinc-800 transition-colors flex items-center justify-between gap-3 ${m === model ? 'text-zinc-100' : 'text-zinc-400'}`}
                      >
                        <span className="truncate">{m}</span>
                        {m === model && (
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="shrink-0 text-accent">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                      </button>
                    ))
                  )}
                  {provider === 'local' && (
                    <button
                      onClick={() => { setShowModelPicker(false); setShowLibrary(true) }}
                      className="w-full px-3 py-2 text-left text-[11px] text-accent hover:bg-zinc-800 transition-colors border-t border-zinc-800"
                    >
                      Manage models…
                    </button>
                  )}
                </div>
              )}
            </div>
            {/* Current workflow selector */}
            <div className="relative" ref={wfPickerRef}>
              <button
                onClick={() => setShowWfPicker((v) => !v)}
                title="Current workflow — the one the assistant edits by default"
                className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors max-w-[130px]"
              >
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
                  <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
                  <path d="M10 6.5h5.5a2 2 0 0 1 2 2V14" />
                </svg>
                <span className="truncate">{activeWorkflow?.name ?? 'no workflow'}</span>
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="shrink-0">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>

              {showWfPicker && (
                <div className="absolute bottom-full mb-2 left-0 z-50 bg-zinc-900 border border-zinc-700/60 rounded-xl shadow-xl overflow-hidden min-w-[200px] max-w-[280px]">
                  {openWorkflows.length === 0 ? (
                    <p className="px-3 py-2.5 text-[11px] text-zinc-500">No open workflows — open one in the Workflows tab.</p>
                  ) : (
                    openWorkflows.map((w) => (
                      <button
                        key={w.id}
                        onClick={() => { setActiveWorkflow(w.id); setShowWfPicker(false) }}
                        className={`w-full px-3 py-2 text-left text-[11px] hover:bg-zinc-800 transition-colors flex items-center justify-between gap-3 ${w.id === activeWorkflowId ? 'text-zinc-100' : 'text-zinc-400'}`}
                      >
                        <span className="truncate">{w.name}</span>
                        {w.id === activeWorkflowId && (
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="shrink-0 text-accent">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
            </div>

            {isLoading ? (
              <button
                onClick={handleStop}
                title="Stop"
                className="group w-6 h-6 rounded-full bg-accent/15 border border-accent/40 hover:bg-red-500/20 hover:border-red-500/50 text-accent hover:text-red-400 flex items-center justify-center transition-colors shrink-0"
              >
                {/* Spinner — turns into a stop button on hover */}
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="animate-spin group-hover:hidden">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
                <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" className="hidden group-hover:block">
                  <rect x="5" y="5" width="14" height="14" rx="2" />
                </svg>
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!input.trim() || !!pendingWorkflow}
                title={pendingWorkflow ? `Waiting on workflow "${pendingWorkflow.name}"…` : undefined}
                className="w-6 h-6 rounded-full bg-accent hover:bg-accent-dark disabled:opacity-30 disabled:cursor-not-allowed text-white flex items-center justify-center transition-colors shrink-0"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" />
                </svg>
              </button>
            )}
          </div>
        </div>
        <p className="mt-1.5 text-[10px] text-zinc-700 text-center">Shift+Enter for new line</p>
      </div>

      {showLibrary && (
        <ModelLibraryModal onClose={() => { setShowLibrary(false); fetchPickerModels() }} />
      )}

    </div>
  )
}

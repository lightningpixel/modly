import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@shared/stores/appStore'
import { useWorkflowsStore } from '@shared/stores/workflowsStore'
import { useExtensionsStore } from '@shared/stores/extensionsStore'
import { useWorkflowRunStore } from '@areas/workflows/workflowRunStore'
import { buildAllWorkflowExtensions } from '@areas/workflows/mockExtensions'

// ─── Types ────────────────────────────────────────────────────────────────────

type ThinkingMode = 'auto' | 'on' | 'off'

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  thinking?: string
  imageDataUrls?: string[]
  actions?: ActionDone[]
}

interface ActionDone {
  tool: string
  result: string
  payload?: {
    type: string
    url?: string
    face_count?: number
    workflow_id?: string
    workflow_name?: string
  } | null
}

// ─── Constants ────────────────────────────────────────────────────────────────

const OLLAMA_URL  = 'http://localhost:11434'
const OLLAMA_MODEL = 'gemma4:e4b'
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

const TOOL_LABELS: Record<string, string> = {
  decimate_mesh:        'Decimated mesh',
  smooth_mesh:          'Smoothed mesh',
  list_models:          'Listed models',
  unload_models:        'Unloaded models',
  get_mesh_info:        'Inspected mesh',
  get_generation_status:'Checked generation',
  list_workflows:       'Listed workflows',
  run_workflow:         'Ran workflow',
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
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Feedback row ─────────────────────────────────────────────────────────────

function FeedbackRow({ content }: { content: string }): JSX.Element {
  const [copied, setCopied] = useState(false)

  function handleCopy() {
    navigator.clipboard.writeText(content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
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
      <button title="Good response" className="text-zinc-600 hover:text-zinc-400 transition-colors">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z" />
          <path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
        </svg>
      </button>
      <button title="Bad response" className="text-zinc-600 hover:text-zinc-400 transition-colors">
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
  const runState = useWorkflowRunStore((s) => s.runState)
  const pct = runState.blockProgress
  return (
    <div className="rounded-xl border border-zinc-700/50 bg-zinc-800/40 px-3 py-2.5 flex flex-col gap-2">
      <div className="flex items-center justify-between text-[11px]">
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse shrink-0" />
          <span className="text-zinc-300 font-medium truncate">{name}</span>
        </div>
        <span className="text-zinc-500 shrink-0">{pct}%</span>
      </div>
      <div className="h-0.5 bg-zinc-700 rounded-full overflow-hidden">
        <div className="h-full bg-accent rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
      </div>
      {runState.blockStep && (
        <p className="text-[10px] text-zinc-500 truncate">{runState.blockStep}</p>
      )}
    </div>
  )
}

// ─── Main component ──────────────────────────────────────────────────────────

export default function ChatPanel(): JSX.Element {
  const [messages, setMessages]               = useState<Message[]>([])
  const [input, setInput]                     = useState('')
  const [isLoading, setIsLoading]             = useState(false)
  const [error, setError]                     = useState<string | null>(null)
  const [showAll, setShowAll]                 = useState(false)
  const [model, setModel]                     = useState(OLLAMA_MODEL)
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [ollamaModels, setOllamaModels]       = useState<string[]>([])
  const [pendingWorkflow, setPendingWorkflow]  = useState<{ id: string; name: string } | null>(null)
  const [attachments, setAttachments]         = useState<string[]>([]) // data URLs
  const [isDragging, setIsDragging]           = useState(false)
  const [thinkingMode, setThinkingMode]       = useState<ThinkingMode>('auto')
  const endRef                                = useRef<HTMLDivElement>(null)
  const textareaRef                           = useRef<HTMLTextAreaElement>(null)
  const modelPickerRef                        = useRef<HTMLDivElement>(null)
  const fileInputRef                          = useRef<HTMLInputElement>(null)
  const messagesRef                           = useRef<Message[]>([])
  messagesRef.current = messages

  const apiUrl           = useAppStore((s) => s.apiUrl)
  const currentJob       = useAppStore((s) => s.currentJob)
  const meshStats        = useAppStore((s) => s.meshStats)
  const updateCurrentJob = useAppStore((s) => s.updateCurrentJob)
  const pushMeshUrl      = useAppStore((s) => s.pushMeshUrl)
  const undoMesh         = useAppStore((s) => s.undoMesh)

  const workflows     = useWorkflowsStore((s) => s.workflows)
  const { modelExtensions, processExtensions } = useExtensionsStore()
  const runWorkflow   = useWorkflowRunStore((s) => s.run)
  const runState      = useWorkflowRunStore((s) => s.runState)
  const allExtensions = useMemo(
    () => buildAllWorkflowExtensions(modelExtensions, processExtensions),
    [modelExtensions, processExtensions],
  )

  // Close model picker on outside click
  useEffect(() => {
    if (!showModelPicker) return
    const handler = (e: MouseEvent) => {
      if (modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node))
        setShowModelPicker(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showModelPicker])

  // Watch workflow completion → send follow-up to agent
  useEffect(() => {
    if (!pendingWorkflow) return
    if (runState.status !== 'done' && runState.status !== 'error') return

    const wf = pendingWorkflow
    setPendingWorkflow(null)

    if (runState.status === 'error') {
      setMessages((prev) => [...prev, {
        id: `sys-${Date.now()}`,
        role: 'assistant',
        content: `The workflow '${wf.name}' failed: ${runState.error ?? 'Unknown error'}`,
      }])
      return
    }

    // Update viewer with the generated mesh
    if (runState.outputUrl) {
      updateCurrentJob({ outputUrl: runState.outputUrl, status: 'done', progress: 100 })
      pushMeshUrl(runState.outputUrl)
    }

    // Send automatic follow-up to agent
    const completionCtx = `Workflow '${wf.name}' just completed.${runState.outputUrl ? ` Output mesh: ${runState.outputUrl}` : ''} Ask the user what they'd like to do next.`
    callAgent(messagesRef.current, { workflowCompletion: completionCtx })
  }, [runState.status, pendingWorkflow])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isLoading, pendingWorkflow])

  function buildContext(): Record<string, unknown> {
    const ctx: Record<string, unknown> = {}
    if (currentJob?.outputUrl) ctx.currentMeshPath = currentJob.outputUrl.replace('/workspace/', '')
    if (meshStats?.triangles)  ctx.meshTriangles   = meshStats.triangles
    if (workflows.length > 0)  ctx.workflows       = workflows.map((w) => ({ id: w.id, name: w.name }))
    return ctx
  }

  async function callAgent(msgs: Message[], extraContext: Record<string, unknown> = {}) {
    setIsLoading(true)
    setError(null)
    try {
      const context = { ...buildContext(), ...extraContext }

      // Inject workflow completion as a system hint if present
      const apiMessages = msgs.map((m) => {
        const entry: { role: string; content: string; images?: string[] } = {
          role: m.role,
          content: m.content,
        }
        if (m.imageDataUrls?.length) {
          entry.images = m.imageDataUrls.map((url) => url.split(',')[1])
        }
        return entry
      })
      if (extraContext.workflowCompletion) {
        apiMessages.push({ role: 'user', content: `[System] ${extraContext.workflowCompletion}` })
        delete context.workflowCompletion
      }

      const res = await fetch(`${apiUrl}/agent/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: apiMessages, ollama_url: OLLAMA_URL, model, context, thinking: thinkingMode }),
      })
      if (!res.ok) throw new Error(`API error ${res.status}`)

      const data: { message: string; actions: ActionDone[]; thinking?: string } = await res.json()

      setMessages((prev) => [...prev, {
        id: `a-${Date.now()}`,
        role: 'assistant',
        content: data.message,
        thinking: data.thinking ?? undefined,
        actions: data.actions?.length ? data.actions : undefined,
      }])

      // Extract base64 from the most recent user message that had an image attached
      const latestImageDataUrl = [...msgs].reverse()
        .find((m) => m.role === 'user' && m.imageDataUrls?.length)
        ?.imageDataUrls?.[0]
      const overrideImageData = latestImageDataUrl ? latestImageDataUrl.split(',')[1] : undefined

      for (const action of data.actions ?? []) {
        if (action.payload?.type === 'mesh_update' && action.payload.url) {
          updateCurrentJob({ outputUrl: action.payload.url })
          pushMeshUrl(action.payload.url)
        }
        if (action.payload?.type === 'run_workflow' && action.payload.workflow_id) {
          const wf = workflows.find((w) => w.id === action.payload!.workflow_id)
          if (wf) { runWorkflow(wf, allExtensions, overrideImageData); setPendingWorkflow({ id: wf.id, name: wf.name }) }
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg.includes('fetch') ? 'Cannot reach Modly API. Is the backend running?' : msg)
    } finally {
      setIsLoading(false)
    }
  }

  async function fetchOllamaModels() {
    try {
      const res = await fetch(`${apiUrl}/agent/models?ollama_url=${encodeURIComponent(OLLAMA_URL)}`)
      const data = await res.json()
      setOllamaModels(data.models ?? [])
    } catch {
      setOllamaModels([])
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

    const userMsg: Message = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: text,
      ...(attachments.length ? { imageDataUrls: [...attachments] } : {}),
    }
    const nextMessages = [...messages, userMsg]
    setMessages(nextMessages)
    setInput('')
    setAttachments([])
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    await callAgent(nextMessages)
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
        <div className="flex flex-col px-4 py-3 gap-5">
          {visible.map((msg) => (
            <div key={msg.id}>
              {msg.role === 'user' ? (
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
                  <ProseMessage content={msg.content} />
                  {msg.actions && msg.actions.length > 0 && (
                    <ActionsCard actions={msg.actions} onUndo={undoMesh} />
                  )}
                  <FeedbackRow content={msg.content} />
                </div>
              )}
            </div>
          ))}

          {/* Workflow progress card — visible while agent waits for workflow */}
          {pendingWorkflow && <WorkflowProgressCard name={pendingWorkflow.name} />}

          {/* Loading indicator */}
          {isLoading && (
            <div className="flex gap-1 items-center py-1">
              {[0, 1, 2].map((i) => (
                <span key={i}
                  className="w-1.5 h-1.5 rounded-full bg-zinc-600 animate-bounce"
                  style={{ animationDelay: `${i * 130}ms` }}
                />
              ))}
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="px-3 py-2 rounded-lg bg-red-950/40 border border-red-800/40">
              <p className="text-[11px] text-red-400">{error}</p>
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
            {/* Thinking toggle */}
            <button
              onClick={() => setThinkingMode((m) => m === 'auto' ? 'on' : m === 'on' ? 'off' : 'auto')}
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
                onClick={() => { setShowModelPicker((v) => !v); if (!showModelPicker) fetchOllamaModels() }}
                className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                {model}
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>

              {showModelPicker && (
                <div className="absolute bottom-full mb-2 left-0 z-50 bg-zinc-900 border border-zinc-700/60 rounded-xl shadow-xl overflow-hidden min-w-[180px]">
                  {ollamaModels.length === 0 ? (
                    <p className="px-3 py-2.5 text-[11px] text-zinc-500">No models found — is Ollama running?</p>
                  ) : (
                    ollamaModels.map((m) => (
                      <button
                        key={m}
                        onClick={() => { setModel(m); setShowModelPicker(false) }}
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
                </div>
              )}
            </div>
            </div>

            <button
              onClick={handleSend}
              disabled={!input.trim() || isLoading}
              className="w-6 h-6 rounded-full bg-accent hover:bg-accent-dark disabled:opacity-30 disabled:cursor-not-allowed text-white flex items-center justify-center transition-colors shrink-0"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" />
              </svg>
            </button>
          </div>
        </div>
        <p className="mt-1.5 text-[10px] text-zinc-700 text-center">Shift+Enter for new line</p>
      </div>

    </div>
  )
}

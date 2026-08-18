/**
 * Agent chat service — owns the SSE stream, the tool-action side effects and
 * the workflow watcher at module level, outside any React component.
 *
 * ChatPanel only renders chatStore state and calls send/stop/clearChat, so
 * navigating between pages (which unmounts the panel) never interrupts a
 * running agent turn or a workflow follow-up.
 */
import { useAppStore } from '@shared/stores/appStore'
import { useAgentStore, providerBaseUrl } from '@shared/stores/agentStore'
import { useWorkflowsStore } from '@shared/stores/workflowsStore'
import { useExtensionsStore } from '@shared/stores/extensionsStore'
import { useChatStore } from '@shared/stores/chatStore'
import { useLlmModelsStore } from '@shared/stores/llmModelsStore'
import { useWorkflowRunStore, pauseKind } from '@areas/workflows/workflowRunStore'
import { buildAllWorkflowExtensions } from '@areas/workflows/mockExtensions'
import { validateWorkflowPreflight, type WorkflowPreflightIssue } from '@areas/workflows/preflight'
import { autoWireWorkflow } from '@areas/workflows/autoWire'
import { markUnappliedTurn } from '@shared/services/agentHistory'
import type { ChatMessage as Message, ActionDone } from '@shared/stores/chatStore'
import type { ThinkingMode } from '@shared/stores/agentStore'
import type { Workflow } from '@shared/types/electron.d'

type AgentSseEvent =
  | { type: 'status'; message: string }
  | { type: 'thinking'; delta: string }
  | { type: 'token'; delta: string }
  | { type: 'reset' }
  | { type: 'tool_start'; name: string }
  | { type: 'action'; tool: string; result: string; payload: ActionDone['payload'] }
  | { type: 'done'; message: string; actions: ActionDone[] }
  | { type: 'error'; message: string }

let abortController: AbortController | null = null

// ─── Small helpers over the stores ───────────────────────────────────────────

const chat = () => useChatStore.getState()
const apiUrl = () => useAppStore.getState().apiUrl

function allExtensions() {
  const { modelExtensions, processExtensions } = useExtensionsStore.getState()
  return buildAllWorkflowExtensions(modelExtensions, processExtensions)
}

/** Model actually used for the next request: chat-picker override or Settings default. */
export function effectiveModel(): string {
  const { provider, localModel, external } = useAgentStore.getState()
  return chat().chatModel ?? (provider === 'local' ? localModel : (external[provider]?.model ?? ''))
}

/** Thinking mode for the next request: brain-icon override or Settings default. */
export function effectiveThinking(): ThinkingMode {
  return chat().thinkingOverride ?? useAgentStore.getState().defaultThinking
}

function providerConfig() {
  const { provider, external } = useAgentStore.getState()
  return provider === 'local'
    ? { type: 'local' }
    : { type: 'external', base_url: providerBaseUrl(provider, external[provider]), api_key: external[provider]?.apiKey ?? '' }
}

function pushNotice(content: string) {
  chat().setMessages((prev) => [...prev, { id: `n-${Date.now()}`, role: 'assistant', content, notice: true }])
}

const INPUT_NODE_TYPES: Record<string, string> = { imageNode: 'image', textNode: 'text', meshNode: 'mesh' }

/**
 * What the run engine is doing, in the five scalars the agent can act on.
 *
 * Sent every turn rather than exposed as a tool: it is small, it is relevant on
 * every turn while a run is alive, and a tool call would cost a round the model
 * often wouldn't spend. It is also what lets the agent answer "how far along is
 * it?" and diagnose a failure instead of being told about it after the fact.
 */
function runStateForAgent(workflows: Workflow[]): Record<string, unknown> | undefined {
  const st = useWorkflowRunStore.getState()
  const { status, blockIndex, blockTotal, blockStep, error } = st.runState
  if (status === 'idle') return undefined

  const wf = workflows.find((w) => w.id === st.activeWorkflowId)
  const pendingWait = Object.entries(st.waitStates).find(([, w]) => w === 'pending')?.[0]
  return {
    status,
    blockIndex,
    blockTotal,
    ...(blockStep ? { blockStep } : {}),
    ...(error ? { error } : {}),
    ...(wf ? { workflowName: wf.name } : {}),
    ...(pendingWait ? { pendingWait } : {}),
  }
}

function buildContext(): Record<string, unknown> {
  const { currentJob, meshStats } = useAppStore.getState()
  const { workflows, activeId } = useWorkflowsStore.getState()
  const extensions = allExtensions()

  const ctx: Record<string, unknown> = {}
  const runState = runStateForAgent(workflows)
  if (runState) ctx.runState = runState
  // Only workspace-relative meshes. A mesh brought in via /optimize/import-by-path
  // has outputUrl `/optimize/serve-file?path=…`, which the replace leaves intact:
  // the mesh tools were then offered and every one of them failed on the path.
  // Leaving it unset gates them out instead, which is the honest answer.
  if (currentJob?.outputUrl?.startsWith('/workspace/')) {
    ctx.currentMeshPath = currentJob.outputUrl.slice('/workspace/'.length)
  }
  if (meshStats?.triangles)  ctx.meshTriangles   = meshStats.triangles
  if (activeId)              ctx.activeWorkflowId = activeId

  // What is actually wrong with the selected workflow, recomputed every turn.
  // Sent as ground truth so the model answers from the current graph rather
  // than from an earlier refusal sitting in its own transcript.
  const active = activeId ? workflows.find((w) => w.id === activeId) : undefined
  if (active) {
    const issues = validateWorkflowPreflight(active, extensions, preflightOptions())
    if (issues.length > 0) ctx.wiringIssues = issues.map((i) => i.message)
  }
  if (workflows.length > 0)  ctx.workflows       = workflows.map((w) => ({
    id: w.id,
    name: w.name,
    ...(w.description ? { description: w.description } : {}),
    input_type: INPUT_NODE_TYPES[w.nodes.find((n) => INPUT_NODE_TYPES[n.type])?.type ?? ''],
    steps: w.nodes
      .filter((n) => n.type === 'extensionNode')
      .map((n) => ({ extension_id: n.data.extensionId, params: n.data.params })),
  }))
  // `type` and `terminal` are what let the backend tell a generator (the only
  // thing that can start an image→mesh chain) from a processing step, and pick
  // the right sink node for a chain that doesn't end in a mesh.
  // `description` is what separates two steps with the same signature: nothing
  // in `mesh→mesh` + "PyMeshLab" says whether it decimates, remeshes or stylises.
  // The backend caps and de-fangs it — it is third-party manifest text.
  if (extensions.length > 0) ctx.extensions = extensions.map((e) => ({
    id: e.id, name: e.name, type: e.type,
    input: e.inputs && e.inputs.length > 1 ? e.inputs.join('+') : e.input,
    output: e.output,
    ...(e.terminal ? { terminal: true } : {}),
    ...(e.description ? { description: e.description } : {}),
    params: e.params.map((p) => p.id),
  }))
  return ctx
}

// ─── Tool-action side effects ────────────────────────────────────────────────

/** Preflight options for agent-initiated checks — same inputs the Workflows tab
 *  uses, so the agent can't start a run the editor would have blocked. */
function preflightOptions() {
  return {
    currentMeshUrl:  useAppStore.getState().currentJob?.outputUrl ?? null,
    llmModels:       useLlmModelsStore.getState().models,
    defaultLlmModel: useAgentStore.getState().localModel,
  }
}

/**
 * Repair a workflow's missing connections, then report what's left.
 *
 * Wiring is a deterministic decision (`autoWireWorkflow`), so the agent path
 * makes it directly instead of asking the model to call a tool — small local
 * models used to answer "connect the nodes yourself in the Workflows tab"
 * instead, leaving the run blocked on something the app can fix on its own.
 *
 * Returns the graph to act on (the saved, wired one when anything changed),
 * the connections added, and the preflight issues auto-wiring can't solve
 * (missing scene mesh, empty For Each folder, undownloaded LLM model…).
 */
async function wireAndValidate(
  wf: Workflow,
): Promise<{ workflow: Workflow; added: string[]; issues: WorkflowPreflightIssue[] }> {
  const exts = allExtensions()
  const issues = validateWorkflowPreflight(wf, exts, preflightOptions())
  if (issues.length === 0) return { workflow: wf, added: [], issues }

  const { workflow: wired, added } = autoWireWorkflow(wf, exts)
  if (added.length === 0) return { workflow: wf, added, issues }

  const store = useWorkflowsStore.getState()
  const res = await store.save({ ...wired, updatedAt: new Date().toISOString() })
  if (!res.success) return { workflow: wf, added: [], issues }
  store.openWorkflow(wf.id)
  return { workflow: wired, added, issues: validateWorkflowPreflight(wired, exts, preflightOptions()) }
}

/**
 * Extra line for issues auto-wiring can never clear: a step is fed the wrong
 * data type, which means the pipeline is missing a step, not an edge. Without
 * it the agent kept calling fix_workflow_wiring, heard "no missing connections",
 * and repeated the same blocked message turn after turn.
 */
function blockedHint(issues: WorkflowPreflightIssue[]): string {
  return issues.some((i) => i.key.includes(':type:'))
    ? '\nThat is a missing step, not a missing connection — fix_workflow_wiring cannot repair it. '
      + 'Replace the pipeline with update_workflow so each step receives the type it expects '
      + '(a generator that outputs a mesh has to come before any mesh step).'
    : ''
}

async function handleAction(action: ActionDone, overrideImageData?: string) {
  const { updateCurrentJob, pushMeshUrl } = useAppStore.getState()
  const { workflows, save: saveWorkflow, openWorkflow } = useWorkflowsStore.getState()

  if (action.payload?.type === 'mesh_update' && action.payload.url) {
    updateCurrentJob({ outputUrl: action.payload.url })
    pushMeshUrl(action.payload.url)
  }
  if (action.payload?.type === 'run_workflow' && action.payload.workflow_id) {
    const wf = workflows.find((w) => w.id === action.payload!.workflow_id)
    if (wf) {
      // Same wiring gate as the Workflows/Generate pages — except the agent
      // path connects the missing inputs itself rather than sending the user
      // back to the editor to drag them.
      const { workflow: ready, added, issues } = await wireAndValidate(wf)
      if (added.length > 0) pushNotice(`Connected in '${wf.name}': ${added.join(' · ')}`)
      if (issues.length > 0) {
        chat().setMessages((prev) => [...prev, {
          id: `sys-${Date.now()}`,
          role: 'assistant',
          content:
            `The workflow '${wf.name}' was not started — fix this first:\n`
            + issues.map((i) => `- ${i.message}`).join('\n')
            + blockedHint(issues),
        }])
        return
      }
      useWorkflowRunStore.getState().run(ready, allExtensions(), overrideImageData)
      chat().setAgentState({ pendingWorkflow: { id: ready.id, name: ready.name } })
    }
  }
  if (action.payload?.type === 'continue_workflow') {
    const st    = useWorkflowRunStore.getState()
    const pause = pauseKind(st)
    if (pause?.kind === 'loop') {
      if (action.payload.mode === 'retry') st.retryWhile()
      else st.continueWhile()
    } else if (pause?.kind === 'wait') {
      void st.continueRun(pause.waitId)
    }
  }
  if (action.payload?.type === 'fix_workflow_wiring' && action.payload.workflow_id) {
    const wf = workflows.find((w) => w.id === action.payload!.workflow_id)
    if (!wf) return
    const { added, issues } = await wireAndValidate(wf)
    pushNotice(
      added.length > 0
        ? `Connected in '${wf.name}': ${added.join(' · ')}`
        : `No missing connections found in '${wf.name}'.`,
    )
    if (issues.length > 0) {
      pushNotice(
        `Still needs fixing:\n${issues.map((i) => `- ${i.message}`).join('\n')}${blockedHint(issues)}`,
      )
    }
  }
  if (action.payload?.type === 'export_mesh' && action.payload.path && action.payload.format) {
    // Same path the Generate panel's Export button takes: save dialog, fetch,
    // write — all already handled in the main process.
    const res = await window.electron.model.export({
      outputUrl: `/workspace/${action.payload.path}`,
      format:    action.payload.format,
    })
    pushNotice(
      res.success
        ? `Exported as ${action.payload.format.toUpperCase()}.`
        : `Export cancelled${res.error ? `: ${res.error}` : '.'}`,
    )
  }
  if (action.payload?.type === 'delete_workflow' && action.payload.workflow_id) {
    const name = action.payload.name ?? action.payload.workflow_id
    const res = await useWorkflowsStore.getState().remove(action.payload.workflow_id)
    pushNotice(res.success ? `Deleted workflow '${name}'.` : `Could not delete '${name}': ${res.error ?? 'unknown error'}`)
  }
  if (action.payload?.type === 'create_workflow' && action.payload.workflow) {
    const draft = action.payload.workflow as Omit<Workflow, 'id' | 'createdAt' | 'updatedAt'>
    const now = new Date().toISOString()
    // The agent builds linear chains — wire any extra required inputs (e.g. a
    // texture step's image) before the workflow ever reaches the user.
    const wf: Workflow = autoWireWorkflow(
      { ...draft, id: crypto.randomUUID(), createdAt: now, updatedAt: now },
      allExtensions(),
    ).workflow
    const res = await saveWorkflow(wf)
    if (res.success) openWorkflow(wf.id)
  }
  if (action.payload?.type === 'update_workflow' && action.payload.workflow_id) {
    const wf = workflows.find((w) => w.id === action.payload!.workflow_id)
    if (!wf) return
    const now = new Date().toISOString()
    let updated: Workflow
    if (action.payload.workflow) {
      // Full pipeline replacement — keep identity and browser metadata, then
      // wire any extra required inputs the linear chain can't express.
      const draft = action.payload.workflow as Omit<Workflow, 'id' | 'createdAt' | 'updatedAt'>
      updated = autoWireWorkflow(
        { ...wf, ...draft, id: wf.id, createdAt: wf.createdAt, updatedAt: now },
        allExtensions(),
      ).workflow
    } else {
      // Param / metadata patch — preserves the graph
      updated = { ...wf, nodes: wf.nodes.map((n) => ({ ...n, data: { ...n.data } })), updatedAt: now }
      if (action.payload.name) updated.name = action.payload.name
      if (action.payload.description !== undefined) updated.description = action.payload.description
      const extNodes = updated.nodes.filter((n) => n.type === 'extensionNode')
      const runStore = useWorkflowRunStore.getState()
      const runActive = runStore.activeWorkflowId === wf.id
      for (const u of action.payload.set_params ?? []) {
        const node = extNodes[u.step - 1]
        if (!node) continue
        node.data.params = { ...node.data.params, ...u.params }
        // A paused run re-reads live params when it resumes — feed it the change
        if (runActive) runStore.setLiveNodeParams(node.id, node.data.params)
      }
    }
    const res = await saveWorkflow(updated)
    if (res.success) openWorkflow(wf.id)
  }
}

// ─── Model resolution (vision auto-switch) ───────────────────────────────────

// The chat model the picker was on before an image auto-switched it to a VL
// model — undefined means no auto-switch is currently active. Restored on the
// next text-only turn so a single photo doesn't permanently pin the picker to
// a heavyweight vision model. Full message history (including the VL's own
// replies) is still sent afterwards; only the raw image bytes get gated out
// for models that don't support vision (see agent.py's vision_ok handling).
let _preVisionChatModel: string | null | undefined = undefined

/** Images need a vision model: auto-switch to the best downloaded VL model
 *  when an image is sent while a text-only local model is selected, reverting
 *  automatically once the conversation goes back to text-only turns. */
async function resolveModelForSend(hasImage: boolean): Promise<string> {
  if (!hasImage && _preVisionChatModel !== undefined) {
    chat().setChatModel(_preVisionChatModel)
    _preVisionChatModel = undefined
  }

  const model = effectiveModel()
  if (useAgentStore.getState().provider !== 'local' || !hasImage) return model
  try {
    const res = await fetch(`${apiUrl()}/llm/models?downloaded=true`)
    const data: { models?: { id: string; tags?: string[]; size_bytes?: number }[] } = await res.json()
    const models = data.models ?? []
    if (models.find((m) => m.id === model)?.tags?.includes('vision')) return model
    const vl = models
      .filter((m) => (m.tags ?? []).includes('vision'))
      .sort((a, b) => (b.size_bytes ?? 0) - (a.size_bytes ?? 0))[0]
    if (vl) {
      if (_preVisionChatModel === undefined) _preVisionChatModel = chat().chatModel
      chat().setChatModel(vl.id)
      pushNotice(`Image attached — switched to ${vl.id} so the assistant can see it.`)
      return vl.id
    }
    pushNotice('No vision model downloaded — the assistant cannot see the image (it is still used as workflow input). Download one from the Vision tab of the Model Library.')
    return model
  } catch {
    return model
  }
}

// ─── Core agent turn ─────────────────────────────────────────────────────────

/** Tail of the queued turns. Turns are serialised because a workflow started
 *  mid-stream can finish (or fail) before the model has finished its summary,
 *  and the run subscriber then fires a second turn. Two live readers shared one
 *  `abortController`, so Stop only aborted the newer one, the older one kept
 *  writing into the chat, and whichever finished first flipped `isLoading` off
 *  while text was still arriving. */
let turnQueue: Promise<void> = Promise.resolve()
/** Bumped by stopAgent so turns queued behind an aborted one don't then run. */
let turnGeneration = 0

async function callAgent(msgs: Message[], extraContext: Record<string, unknown> = {}, modelOverride?: string) {
  const generation = turnGeneration
  const previous   = turnQueue
  let release!: () => void
  turnQueue = new Promise<void>((r) => { release = r })
  try {
    await previous
    if (generation !== turnGeneration) return  // stopped while we waited
    await runTurn(msgs, extraContext, modelOverride)
  } finally {
    release()
  }
}

async function runTurn(msgs: Message[], extraContext: Record<string, unknown> = {}, modelOverride?: string) {
  const { setMessages, setAgentState } = chat()
  const generation = turnGeneration
  setAgentState({ isLoading: true, error: null, statusText: null })

  const controller = new AbortController()
  abortController = controller

  // Streaming assistant message, created lazily on the first delta
  const asstId = `a-${Date.now()}`
  let created = false
  const ensureMsg = () => {
    if (created) return
    created = true
    setMessages((prev) => [...prev, { id: asstId, role: 'assistant', content: '', streaming: true }])
  }
  const patchMsg = (patch: (m: Message) => Message) => {
    setMessages((prev) => prev.map((m) => (m.id === asstId ? patch(m) : m)))
  }

  try {
    const context = { ...buildContext(), ...extraContext }
    const { summary, compactedUpTo } = chat()

    // Older messages are covered by the compacted summary — send only the note + recent turns
    const apiMessages: { role: string; content: string; images?: string[] }[] = summary
      ? [{ role: 'system', content: `Summary of the earlier conversation (for context):\n${summary}` }]
      : []
    for (const m of msgs.slice(compactedUpTo)) {
      if (m.notice) continue
      // Image-only messages (workflow outputs) have no text to send to the LLM
      if (!m.content && !m.imageDataUrls?.length) continue
      const entry: { role: string; content: string; images?: string[] } = {
        role: m.role,
        content: markUnappliedTurn(m.role, m.content, m.actions),
      }
      if (m.imageDataUrls?.length) {
        entry.images = m.imageDataUrls.map((url) => url.split(',')[1])
      }
      apiMessages.push(entry)
    }
    if (extraContext.workflowCompletion) {
      apiMessages.push({
        role: 'user',
        content: `[System] ${extraContext.workflowCompletion}`,
        ...(Array.isArray(extraContext.workflowImages) ? { images: extraContext.workflowImages as string[] } : {}),
      })
      delete context.workflowCompletion
      delete context.workflowImages
    }

    const res = await fetch(`${apiUrl()}/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: apiMessages,
        model: modelOverride ?? effectiveModel(),
        provider: providerConfig(),
        context,
        thinking: effectiveThinking(),
      }),
      signal: controller.signal,
    })
    if (!res.ok || !res.body) throw new Error(`API error ${res.status}`)

    // Base64 of the most recent user message that had an image attached
    const latestImageDataUrl = [...msgs].reverse()
      .find((m) => m.role === 'user' && m.imageDataUrls?.length)
      ?.imageDataUrls?.[0]
    const overrideImageData = latestImageDataUrl ? latestImageDataUrl.split(',')[1] : undefined

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let finished = false

    while (!finished) {
      const { value, done: readerDone } = await reader.read()
      if (readerDone) break
      buffer += decoder.decode(value, { stream: true })
      const events = buffer.split('\n\n')
      buffer = events.pop() ?? ''

      for (const evt of events) {
        const line = evt.split('\n').find((l) => l.startsWith('data:'))
        if (!line) continue
        let data: AgentSseEvent
        try { data = JSON.parse(line.slice(5).trim()) } catch { continue }

        switch (data.type) {
          case 'status':
            setAgentState({ statusText: data.message })
            break
          case 'thinking':
            ensureMsg()
            patchMsg((m) => ({ ...m, thinking: (m.thinking ?? '') + data.delta }))
            break
          case 'token':
            ensureMsg()
            setAgentState({ statusText: null })
            patchMsg((m) => ({ ...m, content: m.content + data.delta }))
            break
          case 'reset':
            // The backend is retrying the round (the model declined something it
            // can actually do) — drop the text streamed so far so the discarded
            // answer doesn't stay above the real one.
            patchMsg((m) => ({ ...m, content: '', thinking: undefined }))
            break
          case 'tool_start':
            setAgentState({ statusText: `Running ${data.name.replace(/_/g, ' ')}…` })
            break
          case 'action': {
            ensureMsg()
            setAgentState({ statusText: null })
            const action: ActionDone = { tool: data.tool, result: data.result, payload: data.payload }
            patchMsg((m) => ({ ...m, actions: [...(m.actions ?? []), action] }))
            await handleAction(action, overrideImageData)
            break
          }
          case 'done':
            ensureMsg()
            patchMsg((m) => ({ ...m, content: data.message || m.content, streaming: false }))
            finished = true
            break
          case 'error':
            setAgentState({ error: data.message })
            finished = true
            break
        }
        if (finished) break
      }
    }
    if (created) patchMsg((m) => ({ ...m, streaming: false }))
  } catch (e: unknown) {
    // Any exit path must clear `streaming`, or the message keeps its spinner and
    // never gets its copy/feedback row for the rest of the session.
    if (created) patchMsg((m) => ({ ...m, streaming: false }))
    if (!(e instanceof DOMException && e.name === 'AbortError')) {
      const msg = e instanceof Error ? e.message : String(e)
      setAgentState({ error: msg.includes('fetch') ? 'Cannot reach Modly API. Is the backend running?' : msg })
    }
  } finally {
    if (abortController === controller) abortController = null
    setAgentState({ isLoading: false, statusText: null })
    // Not after a stop or a conversation switch: compaction reads whatever is
    // open now, so an aborted turn would summarise — and load a model for — the
    // thread the user just moved to.
    if (generation === turnGeneration) void maybeCompact()
  }
}

// ─── Context compaction ──────────────────────────────────────────────────────

// Fold older turns into a compact LLM-written note once the live window grows.
const COMPACT_THRESHOLD = 16
const COMPACT_KEEP      = 8

async function maybeCompact() {
  const { messages: all, summary: prevSummary, compactedUpTo: upTo, setCompaction } = chat()
  if (all.length - upTo < COMPACT_THRESHOLD) return
  // Never load the LLM while a workflow owns the GPU
  const wfStatus = useWorkflowRunStore.getState().runState.status
  if (wfStatus === 'running' || wfStatus === 'paused') return

  const cutoff = all.length - COMPACT_KEEP
  try {
    const res = await fetch(`${apiUrl()}/agent/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: all.slice(upTo, cutoff).filter((m) => !m.notice).map((m) => ({ role: m.role, content: m.content })),
        previous_summary: prevSummary,
        model: effectiveModel(),
        provider: providerConfig(),
      }),
    })
    if (!res.ok) return
    const data: { summary?: string } = await res.json()
    if (!data.summary) return
    // The summariser takes seconds. If the user hit "Clear chat" meanwhile, the
    // transcript is now empty and writing compactedUpTo=cutoff would make every
    // later request send the stale summary and NO user message at all — and it
    // persists, so a reload doesn't fix it.
    const now = chat()
    if (now.messages.length < cutoff || now.compactedUpTo !== upTo) return
    setCompaction(data.summary, cutoff)
  } catch {
    // keep the full history — compaction retries after the next turn
  }
}

// ─── Workflow watcher — notify the agent on pause / completion ───────────────

/** Latest intermediate image of the current run, as a data URL (null if none). */
async function latestRunImageDataUrl(): Promise<string | null> {
  const outs = Object.values(useWorkflowRunStore.getState().nodeImageOutputs)
  const url = outs[outs.length - 1]
  if (!url) return null
  try {
    const res = await fetch(`${apiUrl()}${url}`)
    const blob = await res.blob()
    return await new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

/** Tell the agent the run is paused, attaching the latest intermediate image when possible. */
async function notifyPause(text: string) {
  const img = await latestRunImageDataUrl()
  const sendModel = await resolveModelForSend(!!img)
  await callAgent(chat().messages, {
    workflowCompletion: text,
    ...(img ? { workflowImages: [img.split(',')[1]] } : {}),
  }, sendModel)
}

const notifiedWaits = new Set<string>()
let lastRunStatus: string | null = null
/** Error the agent was last asked to diagnose — so a run that keeps failing the
 *  same way can't bounce the agent and the GPU back and forth unattended. */
let lastNotifiedError: string | null = null

// Module-level subscription: keeps reacting to run transitions even while
// ChatPanel is unmounted (user browsing another page).
useWorkflowRunStore.subscribe((state) => {
  const status = state.runState.status
  const statusChanged = status !== lastRunStatus
  lastRunStatus = status
  if (!statusChanged) return

  const pending = chat().pendingWorkflow

  if (status === 'running') {
    notifiedWaits.clear()
    return
  }

  // Cancel (and reset) drop straight back to idle without passing through
  // 'done'. Leaving pendingWorkflow set here disabled the chat input and the
  // send button for the rest of the session — only "Clear chat" recovered.
  if (status === 'idle') {
    if (pending) chat().setAgentState({ pendingWorkflow: null })
    return
  }

  // A failure is reported whoever started the run — the agent is the only place
  // that can say WHY. Everything else below stays scoped to runs the agent
  // started: resuming a loop the user is driving by hand is not its business.
  if (status === 'error') {
    const err = state.runState.error ?? 'Unknown error'
    const name = pending?.name
      ?? useWorkflowsStore.getState().workflows.find((w) => w.id === state.activeWorkflowId)?.name
      ?? 'the workflow'
    chat().setAgentState({ pendingWorkflow: null })
    if (err === lastNotifiedError) {
      chat().setMessages((prev) => [...prev, {
        id: `sys-${Date.now()}`, role: 'assistant', notice: true,
        content: `'${name}' failed again with the same error: ${err}`,
      }])
      return
    }
    lastNotifiedError = err
    // The run state (status, failing step, error) rides along in buildContext,
    // so the agent diagnoses from the real state rather than from this sentence.
    void callAgent(chat().messages, {
      workflowCompletion:
        `Workflow '${name}' FAILED: ${err}. `
        + `Diagnose it: get_extension_errors lists extensions that failed to load, and `
        + `get_workflow_details shows the failing step's params. Tell the user what went wrong `
        + `in one or two sentences and propose a concrete fix — do not just repeat the error.`,
    })
    return
  }

  if (!pending) return

  // Both pauses report 'paused'; only pauseKind separates a loop boundary from
  // a Wait handoff, and the two need different wording and different resumes.
  const pause = pauseKind(state)
  if (pause?.kind === 'wait') {
    if (notifiedWaits.has(pause.waitId)) return
    notifiedWaits.add(pause.waitId)
    void notifyPause(
      `Workflow '${pending.name}' reached a Wait node and is paused. Review the intermediate result `
      + `(image attached if available; the mesh triangle count is in the context). If the remaining `
      + `steps' params need fixing, use set_param, then call continue_workflow to proceed.`,
    )
    return
  }
  if (pause?.kind === 'loop') {
    void notifyPause(
      `Workflow '${pending.name}' is paused at a loop boundary. Review the intermediate result `
      + `(image attached if available). If params need fixing, use set_param, then call `
      + `continue_workflow to proceed (or mode 'retry' to re-run the last iteration).`,
    )
    return
  }

  if (status !== 'done') return

  chat().setAgentState({ pendingWorkflow: null })

  // Update viewer with the generated mesh
  const { outputUrl } = state.runState
  if (outputUrl) {
    useAppStore.getState().updateCurrentJob({ outputUrl, status: 'done', progress: 100 })
    useAppStore.getState().pushMeshUrl(outputUrl)
  }

  // Show the final generated image in the chat (meshes go to the 3D viewer instead).
  // nodeImageOutputs is in execution order — the last entry is the final image output.
  const imageUrls = Object.values(state.nodeImageOutputs).slice(-1)
  if (imageUrls.length > 0) {
    chat().setMessages((prev) => [...prev, { id: `img-${Date.now()}`, role: 'assistant', content: '', imageUrls }])
  }

  // Send automatic follow-up to agent
  const outputNote =
    (outputUrl ? ` Output mesh: ${outputUrl}.` : '')
    + (imageUrls.length > 0 ? ` Output image: ${imageUrls.join(', ')} (shown to the user in the chat).` : '')
  const completionCtx = `Workflow '${pending.name}' just completed.${outputNote} Ask the user what they'd like to do next.`
  void callAgent(chat().messages, { workflowCompletion: completionCtx })
})

// ─── Public API ──────────────────────────────────────────────────────────────

/** Send a user message (with optional image attachments as data URLs). */
export async function sendUserMessage(text: string, attachments: string[] = []) {
  lastNotifiedError = null  // the user is back in the loop — diagnose again if it fails again
  const userMsg: Message = {
    id: `u-${Date.now()}`,
    role: 'user',
    content: text,
    ...(attachments.length ? { imageDataUrls: [...attachments] } : {}),
  }
  // Show the message BEFORE resolving the model: the input is already cleared by
  // the panel, and resolveModelForSend can spend a /llm/models round trip, during
  // which the user's text had simply vanished from the screen.
  chat().setMessages((prev) => [...prev, userMsg])
  const sendModel = await resolveModelForSend(attachments.length > 0)
  await callAgent([...chat().messages], {}, sendModel)
}

/** Stop the live turn and drop anything queued behind it. */
function abortTurn() {
  turnGeneration++
  abortController?.abort()
}

export function stopAgent() {
  abortTurn()
}

export function clearAgentChat() {
  abortTurn()
  chat().clear()
}

/** Abort whatever the agent is doing before the open conversation changes under
 *  it. A stream left running keeps calling setMessages, so its remaining tokens
 *  — and its `done` event — would land in the conversation the user just moved
 *  to, under a question that was never asked there. */
function detachAgent() {
  abortTurn()
  chat().setAgentState({ isLoading: false, statusText: null, error: null })
}

/** Start a fresh thread (no-op when the current one is already empty). */
export function newConversation() {
  detachAgent()
  chat().newConversation()
}

export function switchConversation(id: string) {
  if (id === chat().activeId) return
  detachAgent()
  chat().switchConversation(id)
}

export function deleteConversation(id: string) {
  if (id === chat().activeId) detachAgent()
  chat().deleteConversation(id)
}

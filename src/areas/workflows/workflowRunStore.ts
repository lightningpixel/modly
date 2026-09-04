import { create } from 'zustand'
import axios, { AxiosInstance } from 'axios'
import { useAppStore } from '@shared/stores/appStore'
import { getWorkflowExtension } from './mockExtensions'
import { showCompletionNotification } from '@shared/utils/notification'
import type { WorkflowExtension } from './mockExtensions'
import type { Workflow, WFNode, WFEdge } from '@shared/types/electron.d'
import { isBranchStarter, isSceneOutput, resolveDataSource, reachesSceneOutput, nearestUpstreamWaits } from './nodeBehaviors'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WorkflowRunState {
  status:        'idle' | 'running' | 'paused' | 'done' | 'error'
  blockIndex:    number
  blockTotal:    number
  blockProgress: number
  blockStep:     string
  outputUrl?:    string
  outputPath?:   string
  error?:        string
}

export type WaitState = 'blocked' | 'pending' | 'running' | 'done' | 'error'

const IDLE: WorkflowRunState = {
  status: 'idle', blockIndex: 0, blockTotal: 0, blockProgress: 0, blockStep: '',
}

// ─── Module-level run context (survives between run() and continueRun(id)) ───

const _cancel      = { current: false }
const _activeJobId = { current: null as string | null }
// While container (manual mode) pause/resume — set by continueWhile()/retryWhile().
const _resume      = { current: null as (() => void) | null }
const _retry       = { current: false }
// For Each auto-loop: the user asked to pause at the next iteration boundary.
const _pauseRequested = { current: false }
// Live node params — the UI pushes edits here so a looping/paused run re-reads the
// latest values when a body node starts (instead of the snapshot from run start).
const _liveParams  = { current: new Map<string, Record<string, unknown>>() }

function flushResume(): void {
  const fn = _resume.current
  _resume.current = null
  if (fn) fn()
}

interface NodeOutput { filePath?: string; text?: string; outputType?: string }

function isSceneMeshOutput(output: NodeOutput | undefined): output is NodeOutput & { filePath: string } {
  return output?.outputType === 'mesh' && typeof output.filePath === 'string'
}

// ─── For Each iterator (image / text / mesh) ───────────────────────────────────
// A "For Each" node walks a folder alphabetically and emits one file per loop
// iteration. Its loop body = the executable nodes reachable downstream, which
// re-run for every file. The `mode` param picks what it emits and which files it
// matches.

const FOR_EACH_MODES: Record<string, { exts: string[]; outputType: 'image' | 'text' | 'mesh' }> = {
  image: { exts: ['png', 'jpg', 'jpeg', 'webp'],              outputType: 'image' },
  text:  { exts: ['txt', 'md', 'prompt'],                     outputType: 'text'  },
  mesh:  { exts: ['glb', 'gltf', 'obj', 'stl', 'ply', 'fbx'], outputType: 'mesh'  },
}

function iteratorConfig(node: WFNode): { exts: string[]; outputType: 'image' | 'text' | 'mesh' } {
  return FOR_EACH_MODES[(node.data.params?.mode as string) ?? 'image'] ?? FOR_EACH_MODES.image
}

function isIterator(type: string | undefined): boolean {
  return type === 'forEachNode'
}

/** True for nodes the runner executes (and can re-run inside a loop body). */
function isExecutable(node: WFNode): boolean {
  if (isIterator(node.type)) return true
  return node.type === 'extensionNode' && !!node.data.enabled
}

/** Absolute, alphabetically-sorted paths of an iterator's files (listFiles sorts). */
async function listIteratorFiles(dir: string, exts: string[]): Promise<string[]> {
  const names = await window.electron.fs.listFiles(dir, exts)
  const norm  = dir.replace(/\\/g, '/').replace(/\/+$/, '')
  return names.map((n) => `${norm}/${n}`)
}

/** Read a UTF-8 text file through the base64 IPC bridge. */
async function readTextFile(filePath: string): Promise<string> {
  const b64 = await window.electron.fs.readFileBase64(filePath)
  return new TextDecoder('utf-8').decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
}

/**
 * Executable nodes reachable downstream from `startId` (its loop body). Traversal
 * stops at Wait boundaries — those nodes belong to branches, not the pre-phase loop.
 */
function reachableExecutable(startId: string, edges: WFEdge[], nodeMap: Map<string, WFNode>): Set<string> {
  const body = new Set<string>([startId])
  const stack = [startId]
  const seen = new Set<string>([startId])
  while (stack.length > 0) {
    const id = stack.pop()!
    for (const e of edges) {
      if (e.source !== id || seen.has(e.target)) continue
      seen.add(e.target)
      const t = nodeMap.get(e.target)
      if (!t || isBranchStarter(t.type)) continue
      if (isExecutable(t)) body.add(e.target)
      stack.push(e.target)
    }
  }
  return body
}

function toWorkspaceUrl(filePath: string, workspaceDir: string): string | undefined {
  const norm = filePath.replace(/\\/g, '/')
  if (!norm.startsWith(workspaceDir)) return undefined
  return `/workspace/${norm.slice(workspaceDir.length).replace(/^\//, '')}`
}

// Inverse of toWorkspaceUrl — used by node components that read a `/workspace/...`
// output URL back off disk (e.g. to build a data: URL for a preview).
export function fromWorkspaceUrl(url: string, workspaceDir: string): string {
  const wsDir = workspaceDir.replace(/\\/g, '/').replace(/\/+$/, '')
  const rel   = url.replace(/^\/workspace\//, '')
  return `${wsDir}/${rel}`
}

interface RunContext {
  workflow:           Workflow
  allExtensions:      WorkflowExtension[]
  client:             AxiosInstance
  workspaceDir:       string
  selectedImagePath:  string | undefined
  selectedImageData?: string
  overrideImageData?: string
  nodeOutputs:        Map<string, NodeOutput>
  nodeMap:            Map<string, WFNode>
  /** nodes in execution (topological) order */
  ordered:            WFNode[]
  branches:           Map<string, WFNode[]>
  waitIds:            string[]
  /** waitId → nearest upstream waitId (null = top-level, runnable from the start) */
  parentWait:         Map<string, string | null>
  /** iterator node id → its resolved file paths, one per loop iteration */
  iteratorFiles:      Map<string, string[]>
  /** workspace URL of the most recently pushed scene mesh (last branch the user ran wins) */
  lastSceneMesh?:     string
}
const _ctx = { current: null as RunContext | null }

// ─── Topological sort (DFS preorder, branch-first) ───────────────────────────

function topoSort(nodes: WFNode[], edges: WFEdge[]): WFNode[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]))
  const adj     = new Map(nodes.map((n) => [n.id, [] as string[]]))
  const inDeg   = new Map(nodes.map((n) => [n.id, 0]))
  for (const e of edges) {
    if (!nodeMap.has(e.source) || !nodeMap.has(e.target)) continue
    adj.get(e.source)!.push(e.target)
    inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + 1)
  }

  const visited = new Set<string>()
  const result: WFNode[] = []

  const visit = (id: string): void => {
    if (visited.has(id)) return
    for (const e of edges) {
      if (e.target === id && !visited.has(e.source) && nodeMap.has(e.source)) return
    }
    const node = nodeMap.get(id)
    if (!node) return
    visited.add(id)
    result.push(node)
    for (const childId of adj.get(id) ?? []) visit(childId)
  }

  for (const node of nodes) if ((inDeg.get(node.id) ?? 0) === 0) visit(node.id)
  for (const node of nodes) if (!visited.has(node.id)) visit(node.id)
  return result
}

// ─── While container geometry ──────────────────────────────────────────────────
// Body membership can't rely on parentId alone: React Flow only assigns it when a
// node is dragged into the container, so a While resized around existing nodes (or
// nodes added by palette click) leaves them unparented. We therefore also test
// on-canvas containment at run time.

interface WhileBounds { x: number; y: number; w: number; h: number }

function nodeSize(n: WFNode): { w: number; h: number } {
  const measured = (n as { measured?: { width?: number; height?: number } }).measured
  const styleW = n.style?.width
  const styleH = n.style?.height
  return {
    w: measured?.width  ?? n.width  ?? (typeof styleW === 'number' ? styleW : 200),
    h: measured?.height ?? n.height ?? (typeof styleH === 'number' ? styleH : 80),
  }
}

function whileBounds(w: WFNode): WhileBounds {
  const s = nodeSize(w)
  return { x: w.position.x, y: w.position.y, w: s.w, h: s.h }
}

function isInsideWhile(n: WFNode, whileId: string, b: WhileBounds): boolean {
  if (n.parentId === whileId) return true
  if (n.parentId) return false   // explicit child of another container
  const s = nodeSize(n)
  const cx = n.position.x + s.w / 2
  const cy = n.position.y + s.h / 2
  return cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h
}

// ─── Branch identification ────────────────────────────────────────────────────
// A node belongs to Wait W's branch if its single nearest upstream Wait is W
// (dominance). Nodes with no upstream Wait — or with multiple (merges) — execute
// in the pre-phase before any user pause.

function identifyBranches(workflow: Workflow): {
  preExecExtNodes: WFNode[]
  branches:        Map<string, WFNode[]>
  waitIds:         string[]
  parentWait:      Map<string, string | null>
  ordered:         WFNode[]
} {
  const ordered = topoSort(workflow.nodes, workflow.edges)
  const nodeMap = new Map(workflow.nodes.map((n) => [n.id, n]))
  const waitIds = ordered.filter((n) => isBranchStarter(n.type)).map((n) => n.id)

  // A node is owned by its single nearest upstream Wait (dominance). This lets
  // Wait → … → Wait chains nest: nodes after the 2nd Wait belong to it, not the 1st.
  const branchOwner = new Map<string, string>()
  for (const node of workflow.nodes) {
    if (isBranchStarter(node.type) || !isExecutable(node)) continue
    const nearest = nearestUpstreamWaits(node.id, workflow.edges, nodeMap)
    if (nearest.size === 1) branchOwner.set(node.id, [...nearest][0])
  }

  // Each Wait's parent = its own nearest upstream Wait (null if top-level).
  const parentWait = new Map<string, string | null>()
  for (const w of waitIds) {
    const nearest = nearestUpstreamWaits(w, workflow.edges, nodeMap)
    parentWait.set(w, nearest.size === 1 ? [...nearest][0] : null)
  }

  const branches = new Map<string, WFNode[]>()
  for (const w of waitIds) branches.set(w, [])
  const preExecExtNodes: WFNode[] = []
  for (const node of ordered) {
    if (!isExecutable(node)) continue
    const owner = branchOwner.get(node.id)
    if (owner) branches.get(owner)!.push(node)
    else preExecExtNodes.push(node)
  }

  return { preExecExtNodes, branches, waitIds, parentWait, ordered }
}

// ─── For Each iterator execution ───────────────────────────────────────────────
// Emits the current iteration's file. Image iterators emit an image path; text
// iterators read the file and emit its text. The iteration index comes from the
// loop's progress (its own node id keys the loop).

async function executeIteratorNode(
  node:        WFNode,
  ctx:         RunContext,
  setRunState: (updater: (s: WorkflowRunState) => WorkflowRunState) => void,
): Promise<void> {
  const files   = ctx.iteratorFiles.get(node.id) ?? []
  const current = useWorkflowRunStore.getState().whileProgress[node.id]?.current ?? 1
  const path    = files[current - 1]
  if (!path) throw new Error('For Each: no file for this iteration')

  const kind = iteratorConfig(node)
  const name = path.split(/[\\/]/).pop()
  setRunState((s) => ({ ...s, blockProgress: 30, blockStep: `Reading ${name}` }))

  if (kind.outputType === 'text') {
    const text = await readTextFile(path)
    ctx.nodeOutputs.set(node.id, { text, outputType: 'text' })
  } else {
    ctx.nodeOutputs.set(node.id, { filePath: path, outputType: kind.outputType })
  }
  setRunState((s) => ({ ...s, blockProgress: 100, blockStep: `Loaded ${name}` }))
}

// ─── Per-node execution ──────────────────────────────────────────────────────
// Resolves inputs (walking through Wait passthroughs), runs the extension
// (model or process), updates nodeOutputs, and pushes the mesh to the scene
// if it feeds an Add-to-Scene through Waits.

async function executeExtensionNode(
  node:        WFNode,
  ctx:         RunContext,
  setRunState: (updater: (s: WorkflowRunState) => WorkflowRunState) => void,
): Promise<void> {
  if (isIterator(node.type)) {
    await executeIteratorNode(node, ctx, setRunState)
    return
  }

  const { workflow, allExtensions, client, workspaceDir, nodeOutputs, nodeMap,
          selectedImagePath, selectedImageData } = ctx

  const ext = getWorkflowExtension(node.data.extensionId ?? '', allExtensions)
  // Freshest params at the moment the node starts (so loop iterations / Retry pick
  // up edits made while paused, not the values captured at run start).
  const liveParams = _liveParams.current.get(node.id) ?? node.data.params ?? {}

  const resolveSource = (sourceId: string): NodeOutput | undefined => {
    const realId = resolveDataSource(sourceId, workflow.edges, nodeMap)
    return realId ? nodeOutputs.get(realId) : undefined
  }

  let nodeInputPath:     string | undefined
  let nodeInputText:     string | undefined
  let nodeInputMeshPath: string | undefined
  // Per-slot texts for multi-text-input nodes (e.g. positive/negative prompts).
  // Indexed by target handle: input-0 → texts[0], input-1 → texts[1].
  const nodeInputTexts: (string | undefined)[] = []
  // Every image beyond the first resolved slot, for extensions that take several
  // (e.g. a texture node taking a mesh plus multiple reference images).
  const extraImagePaths: string[] = []

  const incomingEdges = workflow.edges.filter((e) => e.target === node.id)

  if (ext?.inputs && ext.inputs.length > 1) {
    const inputTypes  = ext.inputs
    // Resolved by target handle first, then typed by that slot's declared input --
    // not by the arrival order of `incomingEdges`, which does not match slot order.
    const inputPaths  = new Array<string | undefined>(inputTypes.length).fill(undefined)

    for (const edge of incomingEdges) {
      const src = resolveSource(edge.source)
      if (!src) continue
      const slotMatch = /^input-(\d+)$/.exec(edge.targetHandle ?? '')
      const slot = slotMatch ? Number(slotMatch[1]) : 0
      if (src.filePath !== undefined && slot < inputTypes.length) inputPaths[slot] = src.filePath
      if (src.text !== undefined && src.text.trim().length > 0) {
        nodeInputText = src.text
        if (slotMatch) nodeInputTexts[slot] = src.text
      }
    }

    for (let i = 0; i < inputTypes.length; i++) {
      const fp = inputPaths[i]
      if (!fp) continue
      if (inputTypes[i] === 'mesh') {
        nodeInputMeshPath = fp
      } else if (inputTypes[i] === 'image') {
        if (!nodeInputPath) nodeInputPath = fp
        else extraImagePaths.push(fp)
      }
    }
  } else {
    for (const edge of incomingEdges) {
      const src = resolveSource(edge.source)
      if (src?.filePath !== undefined) nodeInputPath = src.filePath
      if (src?.text !== undefined && src.text.trim().length > 0) nodeInputText = src.text
    }
  }

  const isModelNode = ext?.type === 'model'

  if (isModelNode) {
    const isTextInput = ext?.inputs ? ext.inputs.every((i) => i === 'text') : ext?.input === 'text'
    const activeImagePath = isTextInput ? undefined : (nodeInputPath ?? selectedImagePath)
    if (!isTextInput && !selectedImageData && (!activeImagePath || activeImagePath.trim().length === 0)) {
      throw new Error('No input image selected for model node')
    }

    let blob: Blob
    let fname: string
    if (isTextInput || (selectedImageData && nodeInputPath === undefined)) {
      const base64 = selectedImageData && nodeInputPath === undefined
        ? selectedImageData
        : 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' // 1x1 transparent PNG
      fname = 'placeholder.png'
      blob = new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: 'image/png' })
    } else {
      const base64 = await window.electron.fs.readFileBase64(activeImagePath as string)
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      blob = new Blob([bytes], { type: 'image/png' })
      fname = activeImagePath?.split(/[\\/]/).pop() ?? 'image.png'
    }

    const extraParams: Record<string, unknown> = {}
    if (nodeInputMeshPath) {
      const norm = nodeInputMeshPath.replace(/\\/g, '/')
      extraParams.mesh_path = norm.startsWith(workspaceDir)
        ? norm.slice(workspaceDir.length).replace(/^\//, '')
        : norm
    }
    if (nodeInputText !== undefined && nodeInputText.trim().length > 0) {
      extraParams.prompt = nodeInputText
      extraParams.text   = nodeInputText
    }
    if (extraImagePaths.length > 0) {
      extraParams.extra_image_paths = extraImagePaths
    }

    const schemaDefaults = Object.fromEntries(
      (ext.params ?? []).map((p) => [p.id, p.default]),
    )
    const effectiveParams = { ...schemaDefaults, ...liveParams }

    const fd = new FormData()
    fd.append('image', blob, fname)
    fd.append('model_id', node.data.extensionId ?? '')
    fd.append('collection', 'Workflows')
    fd.append('remesh', 'none')
    fd.append('enable_texture', 'false')
    fd.append('texture_resolution', '1024')
    fd.append('params', JSON.stringify({ ...effectiveParams, ...extraParams }))

    setRunState((s) => ({ ...s, blockProgress: 5, blockStep: 'Submitting to model…' }))

    const { data } = await client.post<{ job_id: string }>(
      '/generate/from-image', fd,
      { headers: { 'Content-Type': 'multipart/form-data' } },
    )
    _activeJobId.current = data.job_id

    while (true) {
      if (_cancel.current) {
        await client.post(`/generate/cancel/${_activeJobId.current}`).catch(() => {})
        _activeJobId.current = null
        throw new Error('Cancelled')
      }
      await new Promise((r) => setTimeout(r, 1200))

      const { data: st } = await client.get<{
        status: string; progress?: number; step?: string; output_url?: string; error?: string
      }>(`/generate/status/${_activeJobId.current}`)

      if (st.status === 'done' && st.output_url) {
        const rel = st.output_url.replace(/^\/workspace\//, '')
        nodeInputPath = `${workspaceDir}/${rel}`
        _activeJobId.current = null
        setRunState((s) => ({ ...s, blockProgress: 100, blockStep: 'Generation complete' }))
        break
      }
      if (st.status === 'error') throw new Error(st.error ?? 'Generation failed')

      setRunState((s) => ({ ...s, blockProgress: st.progress ?? s.blockProgress, blockStep: st.step ?? 'Generating…' }))
      useAppStore.getState().updateCurrentJob({ status: 'generating', progress: st.progress, step: st.step })
    }
  } else {
    if (ext?.input === 'mesh'  && !nodeInputPath) throw new Error(`${ext.name} needs an incoming mesh connection`)
    if (ext?.input === 'image' && !nodeInputPath) throw new Error(`${ext.name} needs an incoming image connection`)
    if (ext?.input === 'audio' && !nodeInputPath) throw new Error(`${ext.name} needs an incoming audio connection`)
    if (ext?.input === 'text'  && !nodeInputText) throw new Error(`${ext.name} needs an incoming text connection`)

    const parts  = (node.data.extensionId ?? '').split('/')
    const extId  = parts[0]
    const nid    = parts[1] ?? ''

    // Freshest params (liveParams), same as the model-node branch above, so a
    // multi-image process node re-run inside a loop also picks up edits made while
    // paused rather than the snapshot captured at run start.
    const processParams: Record<string, unknown> = { ...liveParams }
    if (nodeInputMeshPath && nodeInputPath) {
      // Texture node: mesh is filePath, all images in extra_image_paths
      processParams.extra_image_paths = [nodeInputPath, ...extraImagePaths]
    } else if (extraImagePaths.length > 0) {
      processParams.extra_image_paths = extraImagePaths
    }

    const result = await window.electron.extensions.runProcess(
      extId,
      {
        filePath: nodeInputMeshPath ?? nodeInputPath,
        text:     nodeInputText,
        texts:    nodeInputTexts.length > 0 ? nodeInputTexts : undefined,
        nodeId:   nid,
      },
      processParams,
    )
    if (!result.success) throw new Error(result.error ?? 'Process extension failed')
    nodeInputPath = result.result?.filePath ?? nodeInputPath
    nodeInputText = result.result?.text     ?? nodeInputText
    setRunState((s) => ({ ...s, blockProgress: 100, blockStep: 'Done' }))
  }

  const outputType = ext?.output ?? (nodeInputPath ? 'mesh' : undefined)
  nodeOutputs.set(node.id, { filePath: nodeInputPath, text: nodeInputText, outputType })

  const output = nodeOutputs.get(node.id)
  const url = isSceneMeshOutput(output) ? toWorkspaceUrl(output.filePath, workspaceDir) : undefined
  if (url && reachesSceneOutput(node.id, workflow.edges, nodeMap)) {
    ctx.lastSceneMesh = url   // remember it so finalize() keeps the last-run branch in view
    useAppStore.getState().updateCurrentJob({ status: 'done', progress: 100, outputUrl: url })
  }
}

// ─── Wait dependency helpers ───────────────────────────────────────────────────

/** All Waits nested (transitively) under `rootId`, via the parentWait chain. */
function descendantWaits(rootId: string, ctx: RunContext): Set<string> {
  const out = new Set<string>()
  let frontier = new Set<string>([rootId])
  while (frontier.size > 0) {
    const next = new Set<string>()
    for (const w of ctx.waitIds) {
      const parent = ctx.parentWait.get(w)
      if (parent && frontier.has(parent) && !out.has(w)) { out.add(w); next.add(w) }
    }
    frontier = next
  }
  return out
}

/**
 * Push the mesh of every scene output owned by `waitId`'s branch to the viewer.
 * A branch whose only scene output has no in-branch processing (e.g. Wait → Add
 * to Scene) gets no immediate push during execution, so the display has to be
 * driven here, when the user continues that branch.
 */
function pushBranchSceneMesh(ctx: RunContext, waitId: string): void {
  for (const node of ctx.ordered) {
    if (!isSceneOutput(node.type)) continue
    const owners = nearestUpstreamWaits(node.id, ctx.workflow.edges, ctx.nodeMap)
    if (owners.size !== 1 || [...owners][0] !== waitId) continue
    const inEdge = ctx.workflow.edges.find((e) => e.target === node.id)
    if (!inEdge) continue
    const srcId = resolveDataSource(inEdge.source, ctx.workflow.edges, ctx.nodeMap)
    const sourceOutput = srcId ? ctx.nodeOutputs.get(srcId) : undefined
    const url = isSceneMeshOutput(sourceOutput) ? toWorkspaceUrl(sourceOutput.filePath, ctx.workspaceDir) : undefined
    if (url) {
      ctx.lastSceneMesh = url
      useAppStore.getState().updateCurrentJob({ status: 'done', progress: 100, outputUrl: url })
    }
  }
}

// ─── Store ────────────────────────────────────────────────────────────────────

interface WorkflowRunStore {
  runState:         WorkflowRunState
  activeNodeId:     string | null
  activeWorkflowId: string | null
  nodeImageOutputs: Record<string, string>
  waitStates:       Record<string, WaitState>
  runningBranchId:  string | null
  /** whileId → current iteration / total (total null = manual/unbounded) */
  whileProgress:    Record<string, { current: number; total: number | null }>
  /** iterator ids paused together at a shared boundary (lockstep For Each group) */
  pausedGroup:      string[]

  run:         (workflow: Workflow, allExtensions: WorkflowExtension[], overrideImageData?: string) => Promise<void>
  cancel:      () => void
  reset:       () => void
  continueRun: (waitId: string) => Promise<void>
  /** While container: resume past the loop (Continue) */
  continueWhile: () => void
  /** While container: resume and re-run the loop body once more (Retry) */
  retryWhile:    () => void
  /** For Each container: request a pause at the next file boundary */
  pauseWhile:    () => void
  /** UI → runner: push the latest params for a node so a looping run uses them */
  setLiveNodeParams: (nodeId: string, params: Record<string, unknown>) => void
}

export const useWorkflowRunStore = create<WorkflowRunStore>((set, get) => {
  const setRunState = (updater: (s: WorkflowRunState) => WorkflowRunState): void => {
    set((s) => ({ runState: updater(s.runState) }))
  }

  const collectImageOutputs = (ctx: RunContext): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const [nodeId, o] of ctx.nodeOutputs) {
      if (o.outputType === 'image' && o.filePath) {
        const norm = o.filePath.replace(/\\/g, '/')
        if (norm.startsWith(ctx.workspaceDir)) {
          out[nodeId] = `/workspace/${norm.slice(ctx.workspaceDir.length).replace(/^\//, '')}`
        }
      }
    }
    return out
  }

  const finalize = (ctx: RunContext, finalWaitStates?: Record<string, WaitState>): void => {
    // Prefer the mesh of the last branch the user actually ran — it's already in the
    // viewer, and topo order must not override the user's last action.
    let outputUrl:  string | undefined = ctx.lastSceneMesh
    let outputPath: string | undefined

    const lastOutputNode = outputUrl ? undefined : [...ctx.ordered].reverse().find((n) => isSceneOutput(n.type))
    if (lastOutputNode) {
      for (const edge of ctx.workflow.edges.filter((e) => e.target === lastOutputNode.id)) {
        const src = ctx.nodeOutputs.get(edge.source)
        if (isSceneMeshOutput(src)) {
          outputUrl = toWorkspaceUrl(src.filePath, ctx.workspaceDir)
        }
      }
    }
    if (!outputUrl) {
      for (const [, o] of ctx.nodeOutputs) {
        if (o.filePath) {
          if (o.outputType === 'audio') {
            outputPath = o.filePath
            continue
          }
          const workspaceUrl = toWorkspaceUrl(o.filePath, ctx.workspaceDir)
          if (workspaceUrl) outputUrl = workspaceUrl
          else outputPath = o.filePath
        }
      }
    }

    set((s) => ({
      activeNodeId:     null,
      runningBranchId:  null,
      whileProgress:    {},
      pausedGroup:      [],
      waitStates:       finalWaitStates ?? s.waitStates,
      nodeImageOutputs: collectImageOutputs(ctx),
      runState: {
        status:        'done',
        blockIndex:    0,
        blockTotal:    0,
        blockProgress: 100,
        blockStep:     'Done',
        outputUrl,
        outputPath,
      },
    }))
    useAppStore.getState().updateCurrentJob({ status: 'done', progress: 100, outputUrl })
    void showCompletionNotification('Workflow run complete')
  }

  return {
    runState:         IDLE,
    activeNodeId:     null,
    activeWorkflowId: null,
    nodeImageOutputs: {},
    waitStates:       {},
    runningBranchId:  null,
    whileProgress:    {},
    pausedGroup:      [],

    async run(workflow, allExtensions, overrideImageData?) {
      _cancel.current = false
      _pauseRequested.current = false
      // Seed live params from the snapshot; UI edits during the run override these.
      _liveParams.current = new Map(workflow.nodes.map((n) => [n.id, { ...(n.data.params ?? {}) }]))

      const appState = useAppStore.getState()
      const apiUrl   = appState.apiUrl

      const { preExecExtNodes, branches, waitIds, parentWait, ordered } = identifyBranches(workflow)
      const branchSteps = waitIds.reduce((acc, w) => acc + (branches.get(w)?.length ?? 0), 0)

      const nodeMap = new Map(workflow.nodes.map((n) => [n.id, n]))

      // ── For Each iterators → resolve their folders up front ────────────────────
      // The loop count is driven by the folder contents, so the listing must resolve
      // before the loop table (and its progress totals) below.
      const iteratorFiles = new Map<string, string[]>()
      for (const w of workflow.nodes) {
        if (!isIterator(w.type)) continue
        const dir = (w.data.params?.dir as string | undefined)?.trim()
        const fail = (msg: string, step: string): void => {
          set((s) => ({ runState: { ...s.runState, status: 'error', error: msg, blockStep: step }, activeNodeId: null }))
        }
        if (!dir) { fail('For Each: pick a folder first', 'No folder selected'); return }
        try {
          const files = await listIteratorFiles(dir, iteratorConfig(w).exts)
          if (files.length === 0) { fail(`For Each: no matching files in ${dir}`, 'Empty folder'); return }
          iteratorFiles.set(w.id, files)
        } catch (err) {
          fail(String(err), 'Failed to read folder'); return
        }
      }

      // ── Loop table ─────────────────────────────────────────────────────────────
      // While containers loop their geometric body N× (or manually). For Each
      // iterators loop the executable nodes reachable downstream, once per file.
      // Replays filter by bodyIds membership (not a contiguous range), so unrelated
      // pre-phase nodes sorting between body members aren't replayed.
      interface LoopInfo { whileId: string; kind: 'while' | 'forEach'; firstIdx: number; lastIdx: number; bodyIds: Set<string>; iterations: number | null }
      const loops: LoopInfo[] = []
      const indexOf = new Map(preExecExtNodes.map((n, i) => [n.id, i]))

      for (const w of workflow.nodes) {
        if (w.type !== 'whileNode') continue
        const bounds = whileBounds(w)
        const idxs = preExecExtNodes.reduce<number[]>((acc, n, idx) => {
          if (isInsideWhile(n, w.id, bounds)) acc.push(idx)
          return acc
        }, [])
        if (idxs.length === 0) continue
        const iters = Number(w.data?.iterations)
        loops.push({
          whileId:  w.id,
          kind:     'while',
          firstIdx: Math.min(...idxs),
          lastIdx:  Math.max(...idxs),
          bodyIds:  new Set(idxs.map((i) => preExecExtNodes[i].id)),
          iterations: Number.isFinite(iters) && iters > 0 ? Math.floor(iters) : null,
        })
      }

      for (const [iterId, files] of iteratorFiles) {
        const bodyIds = new Set([...reachableExecutable(iterId, workflow.edges, nodeMap)].filter((id) => indexOf.has(id)))
        const idxs = [...bodyIds].map((id) => indexOf.get(id)!)
        if (idxs.length === 0) continue
        loops.push({
          whileId:    iterId,
          kind:       'forEach',
          firstIdx:   Math.min(...idxs),
          lastIdx:    Math.max(...idxs),
          bodyIds,
          iterations: files.length,   // one pass per file
        })
      }
      const loopCounters = new Map(loops.map((l) => [l.whileId, l.iterations]))
      // Auto-mode loops replay their body N times; count the extra passes so the
      // progress total reflects the real work (manual loops stay unbounded). While
      // loops are independent. For Each loops sharing a boundary (same lastIdx) run
      // in lockstep over the union of their bodies, so that union is replayed once
      // per pass — count it once, for max(files) − 1 extra passes.
      const forEachGroups = new Map<number, LoopInfo[]>()
      let loopExtraSteps = 0
      for (const l of loops) {
        if (l.kind === 'while') {
          loopExtraSteps += l.iterations != null ? (l.iterations - 1) * l.bodyIds.size : 0
        } else {
          const g = forEachGroups.get(l.lastIdx) ?? []
          g.push(l)
          forEachGroups.set(l.lastIdx, g)
        }
      }
      for (const group of forEachGroups.values()) {
        const union = new Set<string>()
        let maxIter = 0
        for (const l of group) {
          l.bodyIds.forEach((id) => union.add(id))
          if (l.iterations != null) maxIter = Math.max(maxIter, l.iterations)
        }
        if (maxIter > 0) loopExtraSteps += (maxIter - 1) * union.size
      }
      const totalSteps = preExecExtNodes.length + branchSteps + loopExtraSteps

      const selectedImagePath = appState.selectedImagePath ?? undefined
      const selectedImageData = overrideImageData ?? appState.selectedImageData ?? undefined
      const currentMeshUrl    = appState.currentJob?.outputUrl

      set({
        activeWorkflowId: workflow.id,
        nodeImageOutputs: {},
        // Top-level Waits are pending; nested Waits start blocked until their parent finishes.
        waitStates:       Object.fromEntries(waitIds.map((id) => [id, parentWait.get(id) ? 'blocked' as WaitState : 'pending' as WaitState])),
        runningBranchId:  null,
        whileProgress:    Object.fromEntries(loops.map((l) => [l.whileId, { current: 1, total: l.iterations }])),
        pausedGroup:      [],
        runState: {
          status: 'running', blockIndex: 0, blockTotal: totalSteps,
          blockProgress: 0, blockStep: 'Starting…',
        },
      })

      appState.setCurrentJob({
        id:        crypto.randomUUID(),
        imageFile: selectedImagePath ?? '__workflow__',
        status:    'generating',
        progress:  0,
        createdAt: Date.now(),
      })

      try {
        const client       = axios.create({ baseURL: apiUrl })
        const settings     = await window.electron.settings.get()
        const workspaceDir = settings.workspaceDir.replace(/\\/g, '/')

        const tmpAbsPath = settings.workspaceDir.replace(/[\\/]+$/, '') + '/tmp'
        window.electron.fs.deleteDirectory(tmpAbsPath).catch(() => {})

        const nodeOutputs = new Map<string, NodeOutput>()

        // Pre-populate source nodes
        for (const node of ordered) {
          if (node.type === 'imageNode') {
            const fp = node.data.params?.filePath as string | undefined
            const resolvedPath = overrideImageData ? undefined : (fp ?? selectedImagePath ?? undefined)
            nodeOutputs.set(node.id, { filePath: resolvedPath, outputType: 'image' })
          }
          if (node.type === 'textNode') {
            nodeOutputs.set(node.id, { text: node.data.params?.text as string | undefined })
          }
          if (node.type === 'meshNode') {
            const source = node.data.params?.source as 'file' | 'current' | undefined
            if (source === 'current' && currentMeshUrl) {
              let meshFilePath: string
              if (currentMeshUrl.includes('serve-file?path=')) {
                const encoded = currentMeshUrl.split('serve-file?path=')[1]
                meshFilePath = decodeURIComponent(encoded).replace(/\\/g, '/')
              } else {
                const rel = currentMeshUrl.replace(/^\/workspace\//, '')
                meshFilePath = `${workspaceDir}/${rel}`
              }
              nodeOutputs.set(node.id, { filePath: meshFilePath, outputType: 'mesh' })
            } else {
              const fp = node.data.params?.filePath as string | undefined
              if (fp) nodeOutputs.set(node.id, { filePath: fp, outputType: 'mesh' })
            }
          }
        }

        const ctx: RunContext = {
          workflow, allExtensions, client, workspaceDir, selectedImagePath, selectedImageData,
          overrideImageData, nodeOutputs, nodeMap, ordered, branches, waitIds, parentWait, iteratorFiles,
        }
        _ctx.current = ctx

        // While the runner is replaying a loop body, this holds the body nodes of the
        // active loop (or the union of several For Each loops sharing a boundary);
        // re-iterations then execute only those members and skip everything else in
        // the range. null = first pass / no active loop (run all nodes once).
        let activeLoopBody: Set<string> | null = null

        // End-of-body handler for While containers. Called after each pre-phase node;
        // when the index is a loop's last body node, it either jumps back (auto N× or
        // Retry) or pauses for Continue/Retry. Returns the index to resume at,
        // 'cancel', or undefined to continue normally.
        const bumpWhileProgress = (whileId: string): void => set((s) => {
          const prev = s.whileProgress[whileId]
          return { whileProgress: { ...s.whileProgress, [whileId]: { current: (prev?.current ?? 1) + 1, total: prev?.total ?? null } } }
        }
        )

        const handleLoopEnd = async (idx: number): Promise<number | 'cancel' | undefined> => {
          const forEachLoops = loops.filter((l) => l.lastIdx === idx && l.kind === 'forEach')
          const whileLoop    = loops.find((l) => l.lastIdx === idx && l.kind === 'while')

          // ── For Each: run through every file automatically. Several iterators can
          // share the same downstream body (e.g. an image folder + a mesh folder both
          // feeding one node); they advance together, in lockstep. It only stops if
          // the user hit Pause; then Continue advances to the next file(s) and Retry
          // re-runs the current one. No forced pause at the end — it just finishes.
          if (forEachLoops.length > 0) {
            const groupBody = new Set<string>()
            let jumpTo = Infinity
            for (const loop of forEachLoops) {
              loop.bodyIds.forEach((id) => groupBody.add(id))
              jumpTo = Math.min(jumpTo, loop.firstIdx)
            }

            if (_pauseRequested.current) {
              _pauseRequested.current = false
              _retry.current = false
              // Pause every iterator of the group together (they show the same state).
              const groupIds = forEachLoops.map((l) => l.whileId)
              set({ activeNodeId: groupIds[0], runningBranchId: groupIds[0], pausedGroup: groupIds })
              setRunState((s) => ({ ...s, status: 'paused', blockStep: 'Paused — Continue or Retry' }))
              await new Promise<void>((resolve) => { _resume.current = resolve })
              if (_cancel.current) return 'cancel'
              set({ runningBranchId: null, pausedGroup: [] })
              setRunState((s) => ({ ...s, status: 'running' }))
              if (_retry.current) {   // re-run the current file(s), no advance
                _retry.current = false
                activeLoopBody = groupBody
                return jumpTo
              }
              // Continue → fall through to the normal advance below
            }

            // Advance every iterator that still has files left; they move together.
            let anyMore = false
            for (const loop of forEachLoops) {
              const remaining = loopCounters.get(loop.whileId)
              if (remaining != null && remaining > 1) {
                loopCounters.set(loop.whileId, remaining - 1)
                bumpWhileProgress(loop.whileId)
                anyMore = true
              }
            }
            if (anyMore) {
              setRunState((s) => ({ ...s, blockStep: 'Next file…' }))
              activeLoopBody = groupBody
              return jumpTo
            }
            activeLoopBody = null
            return undefined
          }

          if (!whileLoop) return undefined
          const remaining = loopCounters.get(whileLoop.whileId)

          // Auto mode with iterations left → loop back automatically.
          if (remaining != null && remaining > 1) {
            loopCounters.set(whileLoop.whileId, remaining - 1)
            bumpWhileProgress(whileLoop.whileId)
            setRunState((s) => ({ ...s, blockStep: `Looping… ${remaining - 1} left` }))
            activeLoopBody = whileLoop.bodyIds
            return whileLoop.firstIdx
          }
          // Otherwise the auto counter is exhausted (or it's manual mode): pause on
          // the While and wait for Continue (proceed) or Retry (run the body again).
          // runningBranchId blocks Wait branches while the pre-phase is parked here.
          _retry.current = false
          set({ activeNodeId: whileLoop.whileId, runningBranchId: whileLoop.whileId })
          setRunState((s) => ({ ...s, status: 'paused', blockStep: 'Loop finished — Continue or Retry' }))
          await new Promise<void>((resolve) => { _resume.current = resolve })
          if (_cancel.current) return 'cancel'
          set({ runningBranchId: null })
          setRunState((s) => ({ ...s, status: 'running' }))
          if (_retry.current) {
            _retry.current = false
            bumpWhileProgress(whileLoop.whileId)
            activeLoopBody = whileLoop.bodyIds
            return whileLoop.firstIdx
          }
          activeLoopBody = null   // Continue → resume normal forward execution
          return undefined
        }

        // Pre-phase: nodes that don't belong to any single branch (sources + merges).
        let stepsDone = 0
        for (let i = 0; i < preExecExtNodes.length; i++) {
          if (_cancel.current) { _ctx.current = null; set({ runState: IDLE, activeNodeId: null }); return }
          const node = preExecExtNodes[i]
          // During a loop replay, only re-run the active loop's body members.
          if (activeLoopBody && !activeLoopBody.has(node.id)) continue
          set((s) => ({
            activeNodeId: node.id,
            runState: { ...s.runState, blockIndex: stepsDone, blockProgress: 0, blockStep: 'Starting…' },
          }))
          await executeExtensionNode(node, ctx, setRunState)
          stepsDone++

          const jump = await handleLoopEnd(i)
          if (jump === 'cancel') { _ctx.current = null; set({ runState: IDLE, activeNodeId: null }); return }
          if (jump !== undefined) { i = jump - 1 }
        }

        if (waitIds.length > 0) {
          // Hand off to the user — branches run on demand via continueRun(id).
          set((s) => ({
            activeNodeId: null,
            runState: { ...s.runState, status: 'paused', blockStep: 'Pick a branch and click Continue' },
          }))
          return
        }

        finalize(ctx)
      } catch (err) {
        if (!_cancel.current) {
          set((s) => ({ runState: { ...s.runState, status: 'error', error: String(err) }, activeNodeId: null }))
          useAppStore.getState().updateCurrentJob({ status: 'error', error: String(err) })
        }
      }
    },

    async continueRun(waitId) {
      const state = get()
      if (state.runningBranchId !== null) return
      // Only runnable Waits: blocked (parent not done) and running are not.
      const ws = state.waitStates[waitId]
      if (ws !== 'pending' && ws !== 'done' && ws !== 'error') return
      // A pending Wait only runs after a clean handoff. If the run errored in the
      // pre-phase, it never handed off — don't start a branch with missing inputs.
      if (ws === 'pending' && state.runState.status === 'error') return
      const ctx = _ctx.current
      if (!ctx) {
        console.warn('continueRun: no active run context — was the module hot-reloaded mid-run?')
        return
      }

      const branch = ctx.branches.get(waitId) ?? []
      // Re-running a Wait invalidates everything downstream: descendant branches
      // were computed against the old output, so drop their outputs and reset
      // them to blocked until this branch produces a fresh result.
      const descendants = descendantWaits(waitId, ctx)

      _cancel.current = false

      // Reset outputs for this branch's nodes so Retry re-executes cleanly.
      for (const node of branch) ctx.nodeOutputs.delete(node.id)
      for (const d of descendants) for (const node of ctx.branches.get(d) ?? []) ctx.nodeOutputs.delete(node.id)

      set((s) => {
        const waitStates = { ...s.waitStates, [waitId]: 'running' as WaitState }
        for (const d of descendants) waitStates[d] = 'blocked'
        return {
          runningBranchId: waitId,
          waitStates,
          runState: { ...s.runState, status: 'running', blockIndex: 0, blockTotal: branch.length, blockProgress: 0, blockStep: branch.length === 0 ? 'Done' : 'Starting…' },
        }
      })

      const finishBranch = (next: WaitState, err?: string): void => {
        if (_cancel.current) return
        const newWaitStates = { ...get().waitStates, [waitId]: next }
        // Unblock nested Waits whose parent branch just finished, and push this
        // branch's scene output to the viewer.
        if (next === 'done') {
          for (const w of ctx.waitIds) {
            if (ctx.parentWait.get(w) === waitId && newWaitStates[w] === 'blocked') newWaitStates[w] = 'pending'
          }
          pushBranchSceneMesh(ctx, waitId)
        }
        // A failed branch can never feed its descendants — surface them as error
        // too, otherwise they stay 'blocked' and the run hangs on 'paused' forever.
        if (next === 'error') {
          for (const d of descendantWaits(waitId, ctx)) {
            if (newWaitStates[d] === 'blocked') newWaitStates[d] = 'error'
          }
        }
        const allFinished = ctx.waitIds.every((id) => newWaitStates[id] === 'done' || newWaitStates[id] === 'error')
        const anyError    = ctx.waitIds.some((id) => newWaitStates[id] === 'error')

        if (allFinished && !anyError) {
          finalize(ctx, newWaitStates)
        } else {
          set((s) => ({
            activeNodeId:    null,
            runningBranchId: null,
            waitStates:      newWaitStates,
            runState: {
              ...s.runState,
              status:    allFinished ? 'error' : 'paused',
              error:     anyError ? (err ?? s.runState.error) : undefined,
              blockStep: err ? `Branch failed: ${err}` : 'Pick a branch and click Continue',
            },
          }))
        }
      }

      try {
        for (let i = 0; i < branch.length; i++) {
          if (_cancel.current) return
          const node = branch[i]
          set((s) => ({
            activeNodeId: node.id,
            runState: { ...s.runState, blockIndex: i, blockProgress: 0, blockStep: 'Starting…' },
          }))
          await executeExtensionNode(node, ctx, setRunState)
        }
        finishBranch('done')
      } catch (err) {
        finishBranch('error', String(err))
      }
    },

    cancel() {
      _cancel.current = true
      _pauseRequested.current = false
      flushResume()   // unblock a manual While pause so the run can tear down
      if (_activeJobId.current) {
        const apiUrl = useAppStore.getState().apiUrl
        axios.create({ baseURL: apiUrl }).post(`/generate/cancel/${_activeJobId.current}`).catch(() => {})
        _activeJobId.current = null
      }
      _ctx.current = null
      set({ runState: IDLE, activeNodeId: null, activeWorkflowId: null, nodeImageOutputs: {}, waitStates: {}, runningBranchId: null, whileProgress: {}, pausedGroup: [] })
      useAppStore.getState().setCurrentJob(null)
    },

    reset() {
      _ctx.current = null
      set({ runState: IDLE, activeNodeId: null, activeWorkflowId: null, nodeImageOutputs: {}, waitStates: {}, runningBranchId: null, whileProgress: {}, pausedGroup: [] })
    },

    continueWhile() {
      flushResume()
    },

    retryWhile() {
      _retry.current = true
      flushResume()
    },

    pauseWhile() {
      _pauseRequested.current = true
    },

    setLiveNodeParams(nodeId, params) {
      _liveParams.current.set(nodeId, params)
    },
  }
})

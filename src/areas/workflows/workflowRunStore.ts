import { create } from 'zustand'
import axios from 'axios'
import { useAppStore } from '@shared/stores/appStore'
import { getWorkflowExtension } from './mockExtensions'
import type { WorkflowExtension } from './mockExtensions'
import type { Workflow, WFNode, WFEdge } from '@shared/types/electron.d'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WorkflowRunState {
  status:        'idle' | 'running' | 'done' | 'error'
  blockIndex:    number
  blockTotal:    number
  blockProgress: number
  blockStep:     string
  outputUrl?:    string
  outputPath?:   string
  error?:        string
}

const IDLE: WorkflowRunState = {
  status: 'idle', blockIndex: 0, blockTotal: 0, blockProgress: 0, blockStep: '',
}

// Module-level refs — survive component unmounts / navigation
const _cancel      = { current: false }
const _activeJobId = { current: null as string | null }

// ─── Topological sort ─────────────────────────────────────────────────────────

function topoSort(nodes: WFNode[], edges: WFEdge[]): WFNode[] {
  const nodeMap  = new Map(nodes.map((n) => [n.id, n]))
  const inDegree = new Map(nodes.map((n) => [n.id, 0]))
  const adj      = new Map(nodes.map((n) => [n.id, [] as string[]]))
  for (const e of edges) {
    if (!nodeMap.has(e.source) || !nodeMap.has(e.target)) continue
    adj.get(e.source)!.push(e.target)
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1)
  }
  const queue  = nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0)
  const result: WFNode[] = []
  while (queue.length > 0) {
    const node = queue.shift()!
    result.push(node)
    for (const neighbor of adj.get(node.id) ?? []) {
      const deg = (inDegree.get(neighbor) ?? 0) - 1
      inDegree.set(neighbor, deg)
      if (deg === 0) queue.push(nodeMap.get(neighbor)!)
    }
  }
  return result
}

// ─── Store ────────────────────────────────────────────────────────────────────

interface WorkflowRunStore {
  runState:         WorkflowRunState
  activeNodeId:     string | null
  activeWorkflowId: string | null
  /** nodeId → workspace URL for image outputs (populated after each run) */
  nodeImageOutputs: Record<string, string>

  run:    (workflow: Workflow, allExtensions: WorkflowExtension[]) => Promise<void>
  cancel: () => void
  reset:  () => void
}

export const useWorkflowRunStore = create<WorkflowRunStore>((set) => ({
  runState:         IDLE,
  activeNodeId:     null,
  activeWorkflowId: null,
  nodeImageOutputs: {},

  async run(workflow, allExtensions) {
    _cancel.current = false

    const appState     = useAppStore.getState()
    const apiUrl       = appState.apiUrl
    const ordered      = topoSort(workflow.nodes, workflow.edges)
    const execNodes    = ordered.filter((n) => n.type === 'extensionNode' && n.data.enabled)

    const selectedImagePath = appState.selectedImagePath ?? ''
    const selectedImageData = appState.selectedImageData ?? undefined
    const currentMeshUrl    = appState.currentJob?.outputUrl

    set({
      activeWorkflowId: workflow.id,
      nodeImageOutputs: {},
      runState: { status: 'running', blockIndex: 0, blockTotal: execNodes.length, blockProgress: 0, blockStep: 'Starting…' },
    })

    appState.setCurrentJob({
      id: crypto.randomUUID(),
      imageFile: selectedImagePath,
      status: 'generating',
      progress: 0,
      createdAt: Date.now(),
    })

    try {
      const client   = axios.create({ baseURL: apiUrl })
      const settings = await window.electron.settings.get()
      const workspaceDir = settings.workspaceDir.replace(/\\/g, '/')

      // Clean up tmp folder from previous run
      const tmpAbsPath = settings.workspaceDir.replace(/[\\/]+$/, '') + '/tmp'
      window.electron.fs.deleteDirectory(tmpAbsPath).catch(() => {})

      // nodeId → { filePath, text, outputType }
      const nodeOutputs = new Map<string, { filePath?: string; text?: string; outputType?: string }>()

      // Pre-populate source nodes
      for (const node of ordered) {
        if (node.type === 'imageNode') {
          const fp = node.data.params?.filePath as string | undefined
          nodeOutputs.set(node.id, { filePath: fp ?? selectedImagePath, outputType: 'image' })
        }
        if (node.type === 'textNode') {
          nodeOutputs.set(node.id, { text: node.data.params?.text as string | undefined })
        }
        if (node.type === 'meshNode') {
          const source = node.data.params?.source as 'file' | 'current' | undefined
          if (source === 'current' && currentMeshUrl) {
            let meshFilePath: string
            if (currentMeshUrl.includes('serve-file?path=')) {
              // URL like /optimize/serve-file?path=D%3A%5C... → extract and decode the real path
              const encoded = currentMeshUrl.split('serve-file?path=')[1]
              meshFilePath = decodeURIComponent(encoded).replace(/\\/g, '/')
            } else {
              // URL like /workspace/Workflows/file.glb → resolve to absolute path
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

      for (let i = 0; i < execNodes.length; i++) {
        if (_cancel.current) { set({ runState: IDLE, activeNodeId: null }); return }

        const node = execNodes[i]
        const ext  = getWorkflowExtension(node.data.extensionId ?? '', allExtensions)

        // ── Resolve inputs ────────────────────────────────────────────────
        let nodeInputPath:     string | undefined
        let nodeInputText:     string | undefined
        let nodeInputMeshPath: string | undefined

        const incomingEdges = workflow.edges.filter((e) => e.target === node.id)

        if (ext?.inputs && ext.inputs.length > 1) {
          // Multi-input: route each incoming edge by the source node's outputType
          for (const edge of incomingEdges) {
            const src = nodeOutputs.get(edge.source)
            if (!src) continue
            if (src.outputType === 'mesh')        nodeInputMeshPath = src.filePath
            else if (src.outputType === 'image')  nodeInputPath     = src.filePath
            else if (src.filePath !== undefined)  nodeInputPath     = src.filePath
            if (src.text !== undefined)           nodeInputText     = src.text
          }
        } else {
          // Single-input
          for (const edge of incomingEdges) {
            const src = nodeOutputs.get(edge.source)
            if (src?.filePath !== undefined) nodeInputPath = src.filePath
            if (src?.text     !== undefined) nodeInputText = src.text
          }
        }

        set((s) => ({
          activeNodeId: node.id,
          runState: { ...s.runState, blockIndex: i, blockProgress: 0, blockStep: 'Starting…' },
        }))

        // ── Model extensions → HTTP API ───────────────────────────────────
        // Process extensions → IPC runProcess
        const isModelNode = ext?.type === 'model'

        if (isModelNode) {
          const activeImagePath = nodeInputPath ?? selectedImagePath
          const base64 = selectedImageData && nodeInputPath === undefined
            ? selectedImageData
            : await window.electron.fs.readFileBase64(activeImagePath)
          const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
          const blob  = new Blob([bytes], { type: 'image/png' })
          const fname = activeImagePath.split(/[\\/]/).pop() ?? 'image.png'

          // For multi-input nodes: inject mesh path as params.mesh_path
          const extraParams: Record<string, unknown> = {}
          if (nodeInputMeshPath) {
            const norm = nodeInputMeshPath.replace(/\\/g, '/')
            extraParams.mesh_path = norm.startsWith(workspaceDir)
              ? norm.slice(workspaceDir.length).replace(/^\//, '')
              : norm
          }

          // Merge schema defaults (with per-variant paramDefaults already applied)
          // under user overrides so Python receives the effective values, not an
          // empty dict that falls back to hardcoded defaults in the generator.
          const schemaDefaults = Object.fromEntries(
            (ext.params ?? []).map((p) => [p.id, p.default]),
          )
          const effectiveParams = { ...schemaDefaults, ...(node.data.params ?? {}) }

          const fd = new FormData()
          fd.append('image', blob, fname)
          fd.append('model_id', node.data.extensionId ?? '')
          fd.append('collection', 'Workflows')
          fd.append('remesh', 'none')
          fd.append('enable_texture', 'false')
          fd.append('texture_resolution', '1024')
          fd.append('params', JSON.stringify({ ...effectiveParams, ...extraParams }))

          set((s) => ({ runState: { ...s.runState, blockProgress: 5, blockStep: 'Submitting to model…' } }))

          const { data } = await client.post<{ job_id: string }>(
            '/generate/from-image', fd,
            { headers: { 'Content-Type': 'multipart/form-data' } },
          )
          _activeJobId.current = data.job_id

          while (true) {
            if (_cancel.current) {
              await client.post(`/generate/cancel/${_activeJobId.current}`).catch(() => {})
              _activeJobId.current = null
              set({ runState: IDLE, activeNodeId: null })
              return
            }
            await new Promise((r) => setTimeout(r, 1200))

            const { data: st } = await client.get<{
              status: string; progress?: number; step?: string; output_url?: string; error?: string
            }>(`/generate/status/${_activeJobId.current}`)

            if (st.status === 'done' && st.output_url) {
              const rel = st.output_url.replace(/^\/workspace\//, '')
              nodeInputPath = `${workspaceDir}/${rel}`
              _activeJobId.current = null
              set((s) => ({ runState: { ...s.runState, blockProgress: 100, blockStep: 'Generation complete' } }))
              break
            }
            if (st.status === 'error') throw new Error(st.error ?? 'Generation failed')

            const total   = execNodes.length
            const overall = total > 0
              ? Math.round((i / total) * 100 + (st.progress ?? 0) / total)
              : st.progress ?? 0
            set((s) => ({
              runState: { ...s.runState, blockProgress: st.progress ?? s.runState.blockProgress, blockStep: st.step ?? 'Generating…' },
            }))
            useAppStore.getState().updateCurrentJob({ status: 'generating', progress: overall, step: st.step })
          }

        } else {
          // ── Process extension → IPC ─────────────────────────────────────
          if (ext?.input === 'mesh' && !nodeInputPath) {
            throw new Error(`${ext.name} needs an incoming mesh connection`)
          }
          if (ext?.input === 'image' && !nodeInputPath) {
            throw new Error(`${ext.name} needs an incoming image connection`)
          }
          if (ext?.input === 'text' && !nodeInputText) {
            throw new Error(`${ext.name} needs an incoming text connection`)
          }
          const parts  = (node.data.extensionId ?? '').split('/')
          const extId  = parts[0]
          const nodeId = parts[1] ?? ''
          const result = await window.electron.extensions.runProcess(
            extId,
            { filePath: nodeInputPath, text: nodeInputText, nodeId },
            node.data.params as Record<string, unknown>,
          )
          if (!result.success) throw new Error(result.error ?? 'Process extension failed')
          nodeInputPath = result.result?.filePath ?? nodeInputPath
          nodeInputText = result.result?.text     ?? nodeInputText
          set((s) => ({ runState: { ...s.runState, blockProgress: 100, blockStep: 'Done' } }))
        }

        // Store output with type for downstream routing
        const outputType = ext?.output ?? (nodeInputPath ? 'mesh' : undefined)
        nodeOutputs.set(node.id, { filePath: nodeInputPath, text: nodeInputText, outputType })
      }

      // ── Collect image outputs for preview nodes ───────────────────────
      const imageOutputs: Record<string, string> = {}
      for (const [nodeId, out] of nodeOutputs) {
        if (out.outputType === 'image' && out.filePath) {
          const norm = out.filePath.replace(/\\/g, '/')
          if (norm.startsWith(workspaceDir)) {
            imageOutputs[nodeId] = `/workspace/${norm.slice(workspaceDir.length).replace(/^\//, '')}`
          }
        }
      }

      // ── Resolve final output URL ──────────────────────────────────────
      let outputUrl:  string | undefined
      let outputPath: string | undefined

      const outputNodeDef = ordered.find((n) => n.type === 'outputNode')
      if (outputNodeDef) {
        for (const edge of workflow.edges.filter((e) => e.target === outputNodeDef.id)) {
          const src = nodeOutputs.get(edge.source)
          if (src?.filePath) {
            const norm = src.filePath.replace(/\\/g, '/')
            if (norm.startsWith(workspaceDir)) {
              outputUrl = `/workspace/${norm.slice(workspaceDir.length).replace(/^\//, '')}`
            }
          }
        }
      }
      if (!outputUrl) {
        for (const node of execNodes) {
          const out = nodeOutputs.get(node.id)
          if (out?.filePath) {
            const norm = out.filePath.replace(/\\/g, '/')
            if (norm.startsWith(workspaceDir)) {
              outputUrl = `/workspace/${norm.slice(workspaceDir.length).replace(/^\//, '')}`
            } else {
              outputPath = out.filePath
            }
          }
        }
      }

      set({
        activeNodeId:     null,
        nodeImageOutputs: imageOutputs,
        runState: {
          status:        'done',
          blockIndex:    execNodes.length > 0 ? execNodes.length - 1 : 0,
          blockTotal:    execNodes.length,
          blockProgress: 100,
          blockStep:     'Done',
          outputUrl,
          outputPath,
        },
      })
      useAppStore.getState().updateCurrentJob({ status: 'done', progress: 100, outputUrl })

    } catch (err) {
      if (!_cancel.current) {
        set((s) => ({ runState: { ...s.runState, status: 'error', error: String(err) }, activeNodeId: null }))
        useAppStore.getState().updateCurrentJob({ status: 'error', error: String(err) })
      }
    }
  },

  cancel() {
    _cancel.current = true
    if (_activeJobId.current) {
      const apiUrl = useAppStore.getState().apiUrl
      axios.create({ baseURL: apiUrl }).post(`/generate/cancel/${_activeJobId.current}`).catch(() => {})
      _activeJobId.current = null
    }
    set({ runState: IDLE, activeNodeId: null, activeWorkflowId: null, nodeImageOutputs: {} })
    // Clear the generation HUD so it doesn't show stale progress after cancel.
    // The backend's subprocess hard-kill is asynchronous; the UI shouldn't wait.
    useAppStore.getState().setCurrentJob(null)
  },

  reset() {
    set({ runState: IDLE, activeNodeId: null, activeWorkflowId: null, nodeImageOutputs: {} })
  },
}))

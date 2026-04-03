import { useState, useCallback, useRef } from 'react'
import axios from 'axios'
import { useAppStore } from '@shared/stores/appStore'
import type { Workflow, WFNode, WFEdge } from '@shared/types/electron.d'
import { getWorkflowExtension } from './mockExtensions'
import type { WorkflowExtension } from './mockExtensions'

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

// ─── Topological sort (Kahn's algorithm) ─────────────────────────────────────

function topoSort(nodes: WFNode[], edges: WFEdge[]): WFNode[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]))
  const inDegree = new Map(nodes.map((n) => [n.id, 0]))
  const adj = new Map(nodes.map((n) => [n.id, [] as string[]]))

  for (const e of edges) {
    if (!nodeMap.has(e.source) || !nodeMap.has(e.target)) continue
    adj.get(e.source)!.push(e.target)
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1)
  }

  const queue = nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0)
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

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useWorkflowRunner(allExtensions: WorkflowExtension[]) {
  const apiUrl      = useAppStore((s) => s.apiUrl)
  const [runState, setRunState] = useState<WorkflowRunState>(IDLE)
  const cancelRef   = useRef(false)
  const activeJobId = useRef<string | null>(null)

  const run = useCallback(async (
    workflow:        Workflow,
    imagePath:       string,
    imageData?:      string,
    currentMeshUrl?: string,   // outputUrl of the mesh currently in the scene (before job is replaced)
  ) => {
    cancelRef.current = false

    const ordered = topoSort(workflow.nodes, workflow.edges)
    const execNodes = ordered.filter((n) => n.type === 'extensionNode' && n.data.enabled)

    setRunState({
      status: 'running', blockIndex: 0, blockTotal: execNodes.length,
      blockProgress: 0, blockStep: 'Starting…',
    })

    try {
      const client       = axios.create({ baseURL: apiUrl })
      const settings     = await window.electron.settings.get()
      const workspaceDir = settings.workspaceDir.replace(/\\/g, '/')

      // Track outputs per node so branches each get the correct predecessor output
      const nodeOutputs = new Map<string, { filePath?: string; text?: string }>()

      // Pre-populate source nodes
      for (const node of ordered) {
        if (node.type === 'imageNode') nodeOutputs.set(node.id, { filePath: imagePath })
        if (node.type === 'textNode')  nodeOutputs.set(node.id, { text: node.data.params?.text as string | undefined })
        if (node.type === 'meshNode') {
          const source = node.data.params?.source as 'file' | 'current' | undefined
          if (source === 'current') {
            if (currentMeshUrl) {
              const rel = currentMeshUrl.replace(/^\/workspace\//, '')
              nodeOutputs.set(node.id, { filePath: `${workspaceDir}/${rel}` })
            }
          } else {
            const fp = node.data.params?.filePath as string | undefined
            if (fp) nodeOutputs.set(node.id, { filePath: fp })
          }
        }
      }

      for (let i = 0; i < execNodes.length; i++) {
        if (cancelRef.current) { setRunState(IDLE); return }

        const node = execNodes[i]
        const ext  = getWorkflowExtension(node.data.extensionId ?? '', allExtensions)

        // Resolve this node's input from its actual predecessors in the graph
        let nodeInputPath: string | undefined
        let nodeInputText: string | undefined
        for (const edge of workflow.edges.filter((e) => e.target === node.id)) {
          const src = nodeOutputs.get(edge.source)
          if (src?.filePath !== undefined) nodeInputPath = src.filePath
          if (src?.text     !== undefined) nodeInputText = src.text
        }
        // Fallback: if no edge supplied a file/text, use the previous node's output
        if (nodeInputPath === undefined && nodeInputText === undefined && i > 0) {
          const prev = nodeOutputs.get(execNodes[i - 1].id)
          if (prev?.filePath !== undefined) nodeInputPath = prev.filePath
          if (prev?.text     !== undefined) nodeInputText = prev.text
        }

        setRunState((s) => ({ ...s, blockIndex: i, blockProgress: 0, blockStep: 'Starting…' }))

        if (ext?.input === 'image' && ext?.output === 'mesh') {
          // ── Generator: call Python FastAPI ──────────────────────────────────
          const base64 = imageData ?? await window.electron.fs.readFileBase64(imagePath)
          const bytes  = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
          const blob   = new Blob([bytes], { type: 'image/png' })
          const fname  = imagePath.split(/[\\/]/).pop() ?? 'image.png'

          const fd = new FormData()
          fd.append('image', blob, fname)
          fd.append('model_id', node.data.extensionId ?? '')
          fd.append('collection', 'Workflows')
          fd.append('remesh', 'none')
          fd.append('enable_texture', 'false')
          fd.append('texture_resolution', '1024')
          fd.append('params', JSON.stringify(node.data.params))

          setRunState((s) => ({ ...s, blockProgress: 5, blockStep: 'Submitting to model…' }))

          const { data } = await client.post<{ job_id: string }>(
            '/generate/from-image', fd,
            { headers: { 'Content-Type': 'multipart/form-data' } },
          )
          const jobId = data.job_id
          activeJobId.current = jobId

          while (true) {
            if (cancelRef.current) {
              await client.post(`/generate/cancel/${jobId}`).catch(() => {})
              activeJobId.current = null
              setRunState(IDLE)
              return
            }
            await new Promise((r) => setTimeout(r, 1200))

            const { data: st } = await client.get<{
              status: string; progress?: number; step?: string
              output_url?: string; error?: string
            }>(`/generate/status/${jobId}`)

            if (st.status === 'done' && st.output_url) {
              const rel = st.output_url.replace(/^\/workspace\//, '')
              nodeInputPath = `${workspaceDir}/${rel}`
              activeJobId.current = null
              setRunState((s) => ({ ...s, blockProgress: 100, blockStep: 'Generation complete' }))
              break
            }
            if (st.status === 'error') throw new Error(st.error ?? 'Generation failed')

            setRunState((s) => ({
              ...s,
              blockProgress: st.progress ?? s.blockProgress,
              blockStep:     st.step     ?? 'Generating…',
            }))
          }

        } else {
          // ── Process extension ────────────────────────────────────────────────
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
          setRunState((s) => ({ ...s, blockProgress: 100, blockStep: 'Done' }))
        }

        // Store this node's output so downstream nodes (including other branches) can read it
        nodeOutputs.set(node.id, { filePath: nodeInputPath, text: nodeInputText })
      }

      // Determine outputUrl: prefer what feeds the outputNode (Add to Scene)
      let outputUrl:  string | undefined
      let outputPath: string | undefined

      const outputNodeDef = ordered.find((n) => n.type === 'outputNode')
      if (outputNodeDef) {
        for (const edge of workflow.edges.filter((e) => e.target === outputNodeDef.id)) {
          const src = nodeOutputs.get(edge.source)
          if (src?.filePath) {
            const norm = src.filePath.replace(/\\/g, '/')
            if (norm.startsWith(workspaceDir)) {
              const rel = norm.slice(workspaceDir.length).replace(/^\//, '')
              outputUrl = `/workspace/${rel}`
            }
          }
        }
      }

      // Fallback: scan all nodes for a workspace file (last one wins)
      if (!outputUrl) {
        for (const node of execNodes) {
          const out = nodeOutputs.get(node.id)
          if (out?.filePath) {
            const norm = out.filePath.replace(/\\/g, '/')
            if (norm.startsWith(workspaceDir)) {
              const rel = norm.slice(workspaceDir.length).replace(/^\//, '')
              outputUrl = `/workspace/${rel}`
            } else {
              outputPath = out.filePath
            }
          }
        }
      }

      setRunState({
        status: 'done',
        blockIndex:    execNodes.length - 1,
        blockTotal:    execNodes.length,
        blockProgress: 100,
        blockStep:     'Done',
        outputUrl,
        outputPath,
      })

    } catch (err) {
      if (!cancelRef.current) {
        setRunState((s) => ({ ...s, status: 'error', error: String(err) }))
      }
    }
  }, [apiUrl, allExtensions])

  const cancel = useCallback(() => {
    cancelRef.current = true
    if (activeJobId.current) {
      const client = axios.create({ baseURL: apiUrl })
      client.post(`/generate/cancel/${activeJobId.current}`).catch(() => {})
      activeJobId.current = null
    }
    setRunState(IDLE)
  }, [apiUrl])

  const reset = useCallback(() => setRunState(IDLE), [])

  return { runState, run, cancel, reset }
}

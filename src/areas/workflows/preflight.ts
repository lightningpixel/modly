import type { Workflow, WFNode } from '@shared/types/electron.d'
import { getWorkflowExtension, type WorkflowExtension } from './mockExtensions'
import { isPassthrough, isBranchConsumer, resolveDataSource, nearestUpstreamWaits } from './nodeBehaviors'

export type DataType = 'image' | 'text' | 'mesh' | 'audio'

export interface WorkflowPreflightIssue {
  key: string
  message: string
  nodeId?: string
  /** Absent means blocking: an issue has to opt out of stopping the run, never
   *  into it, so a new check can't silently become advisory. */
  severity?: 'blocking' | 'warning'
  /** Set only on issues `autoWireWorkflow` can actually resolve — a missing
   *  edge. Opt-in, so a new check never claims to be repairable by a tool that
   *  would find nothing to do. What the agent is told to do about an issue
   *  hangs off this: an unset file is for the user to pick, not for wiring. */
  autoWirable?: true
}

/** The issues that must stop a run. Warnings are still shown — they just don't
 *  stand between the user and the Run button. */
export function blockingIssues(issues: WorkflowPreflightIssue[]): WorkflowPreflightIssue[] {
  return issues.filter((issue) => issue.severity !== 'warning')
}

export function nodeLabel(node: WFNode, allExtensions: WorkflowExtension[]): string {
  if (node.type === 'imageNode') return 'Image'
  if (node.type === 'textNode') return 'Text'
  if (node.type === 'meshNode') return 'Load 3D Mesh'
  if (node.type === 'outputNode') return 'Add to Scene'
  if (node.type === 'previewNode') return 'Preview Views'
  if (node.type === 'forEachNode') {
    const mode = (node.data.params?.mode as string) ?? 'image'
    return mode === 'text' ? 'For Each Text' : mode === 'mesh' ? 'For Each Mesh' : 'For Each Image'
  }
  if (node.type === 'extensionNode') {
    return getWorkflowExtension(node.data.extensionId ?? '', allExtensions)?.name ?? 'Extension'
  }
  return 'Node'
}

function formatType(type: DataType): string {
  if (type === 'mesh') return 'mesh'
  if (type === 'image') return 'image'
  if (type === 'audio') return 'audio'
  return 'text'
}

function formatRequiredTypes(types: DataType[]): string {
  if (types.length === 1) return formatType(types[0])
  if (types.length === 2) return `${formatType(types[0])} and ${formatType(types[1])}`
  return `${types.slice(0, -1).map(formatType).join(', ')}, and ${formatType(types[types.length - 1])}`
}

export function getNodeOutputType(node: WFNode, allExtensions: WorkflowExtension[]): DataType | undefined {
  if (node.type === 'imageNode') return 'image'
  if (node.type === 'textNode') return 'text'
  if (node.type === 'meshNode' || node.type === 'outputNode') return 'mesh'
  if (node.type === 'previewNode') return 'image'
  if (node.type === 'forEachNode') {
    const mode = (node.data.params?.mode as DataType | undefined) ?? 'image'
    return mode === 'text' || mode === 'mesh' ? mode : 'image'
  }
  if (node.type === 'extensionNode') {
    return getWorkflowExtension(node.data.extensionId ?? '', allExtensions)?.output
  }
  return undefined
}

function pushIssue(issues: WorkflowPreflightIssue[], issue: WorkflowPreflightIssue): void {
  if (!issues.some((existing) => existing.key === issue.key)) issues.push(issue)
}

/** Minimal view of the local LLM library preflight needs (see llmModelsStore). */
export interface LlmModelRef { id: string; name: string; downloaded: boolean }

/**
 * Why a chosen local model can't serve a run. Returns undefined when the model
 * is fine — or when the library isn't known yet, so a slow/failed `/llm/models`
 * never blocks the user with a phantom issue.
 */
function llmModelProblem(
  modelId: string | undefined,
  models:  LlmModelRef[] | undefined,
): { reason: 'none' | 'unknown' | 'not-downloaded'; name?: string } | undefined {
  if (!modelId || modelId.trim().length === 0) return { reason: 'none' }
  if (!models || models.length === 0) return undefined
  const found = models.find((m) => m.id === modelId)
  if (!found) return { reason: 'unknown' }
  if (!found.downloaded) return { reason: 'not-downloaded', name: found.name }
  return undefined
}

/**
 * The extension steps fed by `sourceId`, walking through passthrough nodes
 * (a Wait carries its input straight on). Cycles are possible — a While loop
 * closes one — so visited ids are tracked.
 */
function consumerSteps(
  sourceId: string,
  workflow: Workflow,
  nodeMap: Map<string, WFNode>,
): WFNode[] {
  const steps: WFNode[] = []
  const seen  = new Set([sourceId])
  const queue = [sourceId]
  while (queue.length > 0) {
    const id = queue.shift()!
    for (const edge of workflow.edges) {
      if (edge.source !== id || seen.has(edge.target)) continue
      seen.add(edge.target)
      const target = nodeMap.get(edge.target)
      if (!target) continue
      if (target.type === 'extensionNode') steps.push(target)
      else if (isPassthrough(target.type)) queue.push(target.id)
    }
  }
  return steps
}

export function validateWorkflowPreflight(
  workflow: Workflow,
  allExtensions: WorkflowExtension[],
  options?: {
    currentMeshUrl?: string | null
    /** True when the run has an image to fall back on for an Image node that
     *  carries no file of its own: the one picked in the Generate panel, a blob
     *  dropped on it, or an image attached to the chat turn — the runner treats
     *  all three the same (`overrideImageData ?? selectedImageData`, then
     *  `selectedImagePath`). It rescues a MODEL step only. */
    hasFallbackImage?: boolean
    llmModels?:      LlmModelRef[]
    /** The card's VRAM in GB, when it could be measured. A step declaring more
     *  than this is warned about before the run rather than discovered as an
     *  out-of-memory crash halfway through. */
    vramGb?: number
  },
): WorkflowPreflightIssue[] {
  const issues: WorkflowPreflightIssue[] = []
  const nodeMap = new Map(workflow.nodes.map((node) => [node.id, node]))

  const outputTypes = new Map<string, DataType | undefined>()
  for (const node of workflow.nodes) {
    outputTypes.set(node.id, getNodeOutputType(node, allExtensions))
  }
  // Passthrough nodes inherit their resolved upstream source's type.
  for (const node of workflow.nodes) {
    if (!isPassthrough(node.type)) continue
    const realSourceId = resolveDataSource(node.id, workflow.edges, nodeMap)
    if (realSourceId && realSourceId !== node.id) outputTypes.set(node.id, outputTypes.get(realSourceId))
  }

  for (const node of workflow.nodes) {
    if (node.type === 'meshNode' && node.data.params?.source === 'current' && !options?.currentMeshUrl) {
      pushIssue(issues, {
        key: `${node.id}:current-mesh`,
        nodeId: node.id,
        message: `${nodeLabel(node, allExtensions)} is set to Current Scene, but no mesh is loaded.`,
      })
    }

    // An Image node with nothing chosen used to reach the run engine, which
    // threw "No input image selected for model node" several steps in. Only
    // when a step actually consumes it: a leftover Image node wired to nothing,
    // or feeding only a preview, costs the run nothing.
    //
    // The panel's image is a fallback, but a narrow one — the runner reaches for
    // it only on a MODEL step (`nodeInputPath ?? selectedImagePath`). A process
    // step takes the strict path and throws "… needs an incoming image
    // connection" however full the panel is, so one process consumer is enough
    // to make the empty node a problem.
    if (
      node.type === 'imageNode' &&
      !((node.data.params?.filePath as string | undefined)?.trim())
    ) {
      const steps = consumerSteps(node.id, workflow, nodeMap)
      const everyConsumerFallsBack = steps.every(
        (step) => getWorkflowExtension(step.data.extensionId ?? '', allExtensions)?.type === 'model',
      )
      if (steps.length > 0 && !(options?.hasFallbackImage && everyConsumerFallsBack)) {
        pushIssue(issues, {
          key: `${node.id}:no-image-file`,
          nodeId: node.id,
          message: `${nodeLabel(node, allExtensions)} needs a file selected.`,
        })
      }
    }

    if (node.type === 'forEachNode' && !((node.data.params?.dir as string | undefined)?.trim())) {
      pushIssue(issues, {
        key: `${node.id}:foreach-no-folder`,
        nodeId: node.id,
        message: `${nodeLabel(node, allExtensions)} needs a folder selected.`,
      })
    }

    // A node fed by two different Wait branches can't be scheduled into a single
    // branch — it would run before either branch produces its mesh.
    if (
      isBranchConsumer(node.type) &&
      nearestUpstreamWaits(node.id, workflow.edges, nodeMap).size > 1
    ) {
      pushIssue(issues, {
        key: `${node.id}:wait-merge`,
        nodeId: node.id,
        message: `${nodeLabel(node, allExtensions)} merges two Wait branches, which isn't supported. Route it through a single Wait.`,
      })
    }

    if (node.type !== 'extensionNode') continue

    const ext = getWorkflowExtension(node.data.extensionId ?? '', allExtensions)
    if (!ext) {
      pushIssue(issues, {
        key: `${node.id}:missing-extension`,
        nodeId: node.id,
        message: `${nodeLabel(node, allExtensions)} is unavailable. Reload extensions or remove the node.`,
      })
      continue
    }

    const incomingEdges = workflow.edges.filter((edge) => edge.target === node.id)
    const requiredInputs = (ext.inputs ?? [ext.input]) as DataType[]

    // A step that declares more VRAM than the card has usually fails, and it
    // fails late — after the earlier steps have already run. A warning, not a
    // block: offloading and quantization routinely fit a step into less than it
    // declares, and a manifest that overstates its cost must not make an
    // extension unusable. Only when both numbers are known: an undeclared cost
    // or an unmeasurable card stays silent.
    if (typeof ext.vramGb === 'number' && typeof options?.vramGb === 'number'
        && options.vramGb > 0 && ext.vramGb > options.vramGb) {
      pushIssue(issues, {
        key: `${node.id}:vram`,
        nodeId: node.id,
        severity: 'warning',
        message: `${ext.name} expects about ${ext.vramGb} GB of VRAM, and this card has `
          + `${options.vramGb} GB. It may run out of memory partway through.`,
      })
    }

    // Every `llm-model` param must resolve to a model that's actually on disk —
    // otherwise the extension only finds out mid-run, as an HTTP 404 from /llm/chat.
    for (const param of ext.params ?? []) {
      if (param.type !== 'llm-model') continue
      const modelId = (node.data.params?.[param.id] ?? param.default) as string | undefined
      const problem = llmModelProblem(modelId, options?.llmModels)
      if (!problem) continue
      pushIssue(issues, {
        key: `${node.id}:llm-model:${param.id}`,
        nodeId: node.id,
        message: problem.reason === 'none'
          ? `${ext.name} needs a model selected for "${param.label}".`
          : problem.reason === 'unknown'
          ? `${ext.name} points at an unknown model "${modelId}" for "${param.label}". Pick one from the list.`
          : `${ext.name} uses ${problem.name ?? modelId}, which isn't downloaded. Get it in Settings → Agent.`,
      })
    }

    // Per SLOT, not per distinct type. A node declaring inputs ['text','text']
    // (positive + negative prompt) counted as fully wired with a single text
    // edge, so a run started with slot 1 empty and the extension silently
    // received one prompt. Slot 0 accepts an untagged edge because the single-
    // input case has always been wired without a targetHandle.
    requiredInputs.forEach((requiredType, slot) => {
      const filled = incomingEdges.some((edge) => {
        if (outputTypes.get(edge.source) !== requiredType) return false
        const handle = edge.targetHandle ?? ''
        return handle === `input-${slot}` || (slot === 0 && !handle.startsWith('input-'))
      })
      if (filled) return
      // The slot only enters the key when the same type is declared more than
      // once — otherwise a node's issue key would change shape for every
      // existing single-input extension.
      const duplicated = requiredInputs.filter((t) => t === requiredType).length > 1
      const which = duplicated ? ` (input ${slot + 1} of ${requiredInputs.length})` : ''
      pushIssue(issues, {
        key: duplicated ? `${node.id}:missing:${slot}:${requiredType}` : `${node.id}:missing:${requiredType}`,
        nodeId: node.id,
        autoWirable: true,
        message: `${ext.name} needs an incoming ${formatType(requiredType)} connection${which}.`,
      })
    })

    const acceptedTypes = [...new Set(requiredInputs)]
    for (const edge of incomingEdges) {
      const sourceNode = nodeMap.get(edge.source)
      const sourceType = outputTypes.get(edge.source)
      if (!sourceNode || !sourceType || acceptedTypes.includes(sourceType)) continue
      pushIssue(issues, {
        key: `${node.id}:type:${edge.id}`,
        nodeId: node.id,
        message: `${ext.name} expects ${formatRequiredTypes(acceptedTypes)}, but ${nodeLabel(sourceNode, allExtensions)} outputs ${formatType(sourceType)}.`,
      })
    }
  }

  return issues
}

import type { Workflow, WFNode } from '@shared/types/electron.d'
import { getWorkflowExtension, type WorkflowExtension } from './mockExtensions'
import { isPassthrough, isBranchConsumer, resolveDataSource, nearestUpstreamWaits,
         isLlmPortHandle, isProviderOnlyLlm, LLM_PORT_PREFIX } from './nodeBehaviors'

export type DataType = 'image' | 'text' | 'mesh' | 'audio'

export interface WorkflowPreflightIssue {
  key: string
  message: string
  nodeId?: string
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
  if (node.type === 'llmNode') return 'LLM'
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
  if (node.type === 'llmNode') return 'text'
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

export function validateWorkflowPreflight(
  workflow: Workflow,
  allExtensions: WorkflowExtension[],
  options?: {
    currentMeshUrl?: string | null
    llmModels?:      LlmModelRef[]
    /** Agent's model, used by any LLM node that hasn't picked one — the runner
     *  falls back to it, so preflight must check it too (its default is a
     *  catalog id that is NOT downloaded on a fresh install). */
    defaultLlmModel?: string
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

    if (node.type === 'llmNode') {
      // A provider-only LLM node (wired to another node's model port) configures
      // a model instead of generating, so it needs no prompt.
      const providerOnly = isProviderOnlyLlm(node.id, workflow.edges)
      if (!providerOnly) {
        const hasIncomingText = workflow.edges.some(
          (edge) => edge.target === node.id && outputTypes.get(edge.source) === 'text',
        )
        const hasPrompt = !!(node.data.params?.prompt as string | undefined)?.trim()
        if (!hasIncomingText && !hasPrompt) {
          pushIssue(issues, {
            key: `${node.id}:llm-no-prompt`,
            nodeId: node.id,
            message: `${nodeLabel(node, allExtensions)} needs a prompt or an incoming text connection.`,
          })
        }
      }

      // An unset model falls back to the agent's at run time, so validate that
      // one — it's the fresh-install case where nothing is downloaded yet.
      const model = (node.data.params?.model as string | undefined) || options?.defaultLlmModel
      const problem = llmModelProblem(model, options?.llmModels)
      if (problem) {
        pushIssue(issues, {
          key: `${node.id}:llm-model`,
          nodeId: node.id,
          message: problem.reason === 'none'
            ? `${nodeLabel(node, allExtensions)} needs a model selected.`
            : problem.reason === 'unknown'
            ? `${nodeLabel(node, allExtensions)} points at an unknown model "${model}". Pick one from the list.`
            : `${nodeLabel(node, allExtensions)} uses ${problem.name ?? model}, which isn't downloaded. Get it in Settings → Agent.`,
        })
      }
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

    // Model-provider edges set an `llm-model` param, they're not data inputs.
    const allIncoming   = workflow.edges.filter((edge) => edge.target === node.id)
    const llmPortEdges  = allIncoming.filter((edge) => isLlmPortHandle(edge.targetHandle))
    const incomingEdges = allIncoming.filter((edge) => !isLlmPortHandle(edge.targetHandle))
    const requiredInputs = (ext.inputs ?? [ext.input]) as DataType[]

    // Every `llm-model` param must resolve to a model that's actually on disk —
    // otherwise the extension only finds out mid-run, as an HTTP 404 from /llm/chat.
    for (const param of ext.params ?? []) {
      if (param.type !== 'llm-model') continue
      // Driven by a connected LLM node: that node's own check owns the model, so
      // flagging it here too would just duplicate the message.
      const wired = llmPortEdges.some((edge) =>
        (edge.targetHandle ?? '').slice(LLM_PORT_PREFIX.length) === param.id,
      )
      if (wired) continue
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

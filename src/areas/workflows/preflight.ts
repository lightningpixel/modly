import type { Workflow, WFNode } from '@shared/types/electron.d'
import { getWorkflowExtension, type WorkflowExtension } from './mockExtensions'
import { isPassthrough, isBranchConsumer, resolveDataSource, nearestUpstreamWaits } from './nodeBehaviors'
import { normalizeVideoSource } from './workflowVideoSource'

type DataType = 'image' | 'text' | 'mesh' | 'audio' | 'scene' | 'video'

export interface WorkflowPreflightIssue {
  key: string
  message: string
  nodeId?: string
}

function nodeLabel(node: WFNode, allExtensions: WorkflowExtension[]): string {
  if (node.type === 'imageNode') return 'Image'
  if (node.type === 'textNode') return 'Text'
  if (node.type === 'meshNode') return 'Load 3D Mesh'
  if (node.type === 'sceneNode') return 'Load Scene'
  if (node.type === 'videoNode') return 'Load Video'
  if (node.type === 'outputNode') return 'Add to Scene'
  if (node.type === 'previewNode') return 'Preview Views'
  if (node.type === 'imagePreviewNode') return 'Preview Image'
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
  if (type === 'scene') return 'scene'
  if (type === 'video') return 'video'
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

function getNodeOutputType(node: WFNode, allExtensions: WorkflowExtension[]): DataType | undefined {
  if (node.type === 'imageNode') return 'image'
  if (node.type === 'textNode') return 'text'
  if (node.type === 'meshNode' || node.type === 'outputNode') return 'mesh'
  if (node.type === 'sceneNode') return 'scene'
  if (node.type === 'videoNode') return 'video'
  if (node.type === 'previewNode') return 'image'
  if (node.type === 'imagePreviewNode') return 'image'
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

export function validateWorkflowPreflight(
  workflow: Workflow,
  allExtensions: WorkflowExtension[],
  options?: { currentMeshUrl?: string | null },
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

    if (node.type === 'sceneNode' && !((node.data.params?.manifestPath as string | undefined)?.trim())) {
      pushIssue(issues, {
        key: `${node.id}:scene-invalid`, nodeId: node.id,
        message: 'Load Scene needs a validated scene directory.',
      })
    }
    if (node.type === 'videoNode' && !normalizeVideoSource(
      node.data.params?.workspacePath as string | undefined, '/workspace',
    )) {
      pushIssue(issues, {
        key: `${node.id}:video-invalid`, nodeId: node.id,
        message: 'Load Video needs an imported workspace video file.',
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

    const usesSceneInput = ext.input === 'scene' || ext.inputs?.includes('scene') === true
    const unsupportedSceneShape =
      (ext.type === 'process' && (usesSceneInput || ext.output === 'scene'))
      || (ext.type === 'model' && usesSceneInput
        && (ext.inputs !== undefined || ext.input !== 'scene'))
    if (unsupportedSceneShape) {
      pushIssue(issues, {
        key: `${node.id}:unsupported-scene-shape`,
        nodeId: node.id,
        message: `${ext.name} uses an unsupported scene input or output declaration.`,
      })
      continue
    }
    const usesVideoInput = ext.input === 'video' || ext.inputs?.includes('video') === true
    const unsupportedVideoShape = ext.output === 'video'
      || (ext.type === 'process' && usesVideoInput)
      || (ext.type === 'model' && usesVideoInput
        && (ext.inputs !== undefined || ext.input !== 'video'))
    if (unsupportedVideoShape) {
      pushIssue(issues, {
        key: `${node.id}:unsupported-video-shape`,
        nodeId: node.id,
        message: `${ext.name} uses an unsupported video input or output declaration.`,
      })
      continue
    }

    const incomingEdges = workflow.edges.filter((edge) => edge.target === node.id)
    const requiredTypes = [...new Set((ext.inputs ?? [ext.input]) as DataType[])]

    for (const requiredType of requiredTypes) {
      const hasMatchingInput = incomingEdges.some((edge) => outputTypes.get(edge.source) === requiredType)
      if (!hasMatchingInput) {
        pushIssue(issues, {
          key: `${node.id}:missing:${requiredType}`,
          nodeId: node.id,
          message: `${ext.name} needs an incoming ${formatType(requiredType)} connection.`,
        })
      }
    }

    for (const edge of incomingEdges) {
      const sourceNode = nodeMap.get(edge.source)
      const sourceType = outputTypes.get(edge.source)
      if (!sourceNode || !sourceType || requiredTypes.includes(sourceType)) continue
      pushIssue(issues, {
        key: `${node.id}:type:${edge.id}`,
        nodeId: node.id,
        message: `${ext.name} expects ${formatRequiredTypes(requiredTypes)}, but ${nodeLabel(sourceNode, allExtensions)} outputs ${formatType(sourceType)}.`,
      })
    }
  }

  return issues
}

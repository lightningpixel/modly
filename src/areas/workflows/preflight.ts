import type { Workflow, WFNode } from '@shared/types/electron.d'
import { getWorkflowExtension, type WorkflowExtension } from './mockExtensions'

type DataType = 'image' | 'text' | 'mesh'

export interface WorkflowPreflightIssue {
  key: string
  message: string
  nodeId?: string
}

function nodeLabel(node: WFNode, allExtensions: WorkflowExtension[]): string {
  if (node.type === 'imageNode') return 'Image'
  if (node.type === 'textNode') return 'Text'
  if (node.type === 'meshNode') return 'Load 3D Mesh'
  if (node.type === 'outputNode') return 'Add to Scene'
  if (node.type === 'previewNode') return 'Preview Views'
  if (node.type === 'extensionNode') {
    return getWorkflowExtension(node.data.extensionId ?? '', allExtensions)?.name ?? 'Extension'
  }
  return 'Node'
}

function formatType(type: DataType): string {
  if (type === 'mesh') return 'mesh'
  if (type === 'image') return 'image'
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
  if (node.type === 'previewNode') return 'image'
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

  for (const node of workflow.nodes) {
    if (node.type === 'meshNode' && node.data.params?.source === 'current' && !options?.currentMeshUrl) {
      pushIssue(issues, {
        key: `${node.id}:current-mesh`,
        nodeId: node.id,
        message: `${nodeLabel(node, allExtensions)} is set to Current Scene, but no mesh is loaded.`,
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

import { getBezierPath, useReactFlow, useEdges } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'
import { useExtensionsStore } from '@shared/stores/extensionsStore'
import { buildAllWorkflowExtensions } from '../mockExtensions'
import { HANDLE_COLOR, FALLBACK_COLOR } from '../portColors'
import { slotInputType } from '../nodeInputs'

export default function WorkflowEdge({
  id, source, target,
  sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition,
}: EdgeProps) {
  const { getNode } = useReactFlow()
  const edges       = useEdges()
  const { modelExtensions, processExtensions } = useExtensionsStore()
  const allExtensions = buildAllWorkflowExtensions(modelExtensions, processExtensions)

  const sourceNode = getNode(source)
  const targetNode = getNode(target)

  // Read the handles directly from the edge store — reliable regardless of EdgeProps version
  const thisEdge     = edges.find((e) => e.id === id)
  const targetHandle = thisEdge?.targetHandle

  const sourceColor = sourceNode?.type === 'imageNode'
    ? HANDLE_COLOR.image
    : sourceNode?.type === 'textNode'
    ? HANDLE_COLOR.text
    : sourceNode?.type === 'meshNode'
    ? HANDLE_COLOR.mesh
    : (HANDLE_COLOR[allExtensions.find((e) => e.id === sourceNode?.data?.extensionId)?.output ?? ''] ?? FALLBACK_COLOR)

  // For multi-input nodes pick the color of the specific connected handle
  const targetExt = allExtensions.find((e) => e.id === targetNode?.data?.extensionId)
  const targetInputType = slotInputType(targetExt, targetHandle)

  const targetColor = targetNode?.type === 'outputNode'
    ? HANDLE_COLOR.mesh
    : targetNode?.type === 'previewNode'
    ? HANDLE_COLOR.image
    : (HANDLE_COLOR[targetInputType ?? ''] ?? FALLBACK_COLOR)

  const [edgePath] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
  const gradientId = `wf-edge-${id}`

  return (
    <>
      <defs>
        <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1={sourceX} y1={sourceY} x2={targetX} y2={targetY}>
          <stop offset="0%"   stopColor={sourceColor} />
          <stop offset="100%" stopColor={targetColor} />
        </linearGradient>
      </defs>
      <path
        d={edgePath}
        fill="none"
        style={{ stroke: `url(#${gradientId})`, strokeWidth: 2.5 }}
        className="react-flow__edge-path"
      />
    </>
  )
}

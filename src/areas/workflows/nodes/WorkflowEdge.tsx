import { getBezierPath, useReactFlow } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'
import { useExtensionsStore } from '@shared/stores/extensionsStore'
import { buildAllWorkflowExtensions } from '../mockExtensions'

const HANDLE_COLOR: Record<string, string> = {
  image: '#38bdf8',
  mesh:  '#a78bfa',
  text:  '#fbbf24',
}

export default function WorkflowEdge({
  id, source, target,
  sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition,
}: EdgeProps) {
  const { getNode } = useReactFlow()
  const { modelExtensions, processExtensions } = useExtensionsStore()
  const allExtensions = buildAllWorkflowExtensions(modelExtensions, processExtensions)

  const sourceNode = getNode(source)
  const targetNode = getNode(target)

  const sourceColor = sourceNode?.type === 'imageNode'
    ? HANDLE_COLOR.image
    : sourceNode?.type === 'textNode'
    ? HANDLE_COLOR.text
    : sourceNode?.type === 'meshNode'
    ? HANDLE_COLOR.mesh
    : (HANDLE_COLOR[allExtensions.find((e) => e.id === sourceNode?.data?.extensionId)?.output ?? ''] ?? '#52525b')

  const targetColor = targetNode?.type === 'outputNode'
    ? HANDLE_COLOR.mesh
    : (HANDLE_COLOR[allExtensions.find((e) => e.id === targetNode?.data?.extensionId)?.input ?? ''] ?? '#52525b')

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

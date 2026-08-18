import { getBezierPath, useReactFlow, useEdges } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'
import { useExtensionsStore } from '@shared/stores/extensionsStore'
import { buildAllWorkflowExtensions } from '../mockExtensions'
import { HANDLE_COLOR, FALLBACK_COLOR } from '../portColors'

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
  const sourceHandle = thisEdge?.sourceHandle

  // Model-provider link (LLM node → an extension's llm-model param): one colour
  // end to end, it carries no data type.
  const isLlmLink = sourceHandle === 'llm' || (targetHandle ?? '').startsWith('llm-')

  const sourceColor = isLlmLink
    ? HANDLE_COLOR.llm
    : sourceNode?.type === 'imageNode'
    ? HANDLE_COLOR.image
    : sourceNode?.type === 'textNode' || sourceNode?.type === 'llmNode'
    ? HANDLE_COLOR.text
    : sourceNode?.type === 'meshNode'
    ? HANDLE_COLOR.mesh
    : (HANDLE_COLOR[allExtensions.find((e) => e.id === sourceNode?.data?.extensionId)?.output ?? ''] ?? FALLBACK_COLOR)

  // For multi-input nodes pick the color of the specific connected handle
  const targetExt = allExtensions.find((e) => e.id === targetNode?.data?.extensionId)
  const targetInputType = (() => {
    if (targetExt?.inputs && targetExt.inputs.length > 1 && targetHandle) {
      const idx = parseInt(targetHandle.replace('input-', ''), 10)
      return targetExt.inputs[isNaN(idx) ? 0 : idx] ?? targetExt.input
    }
    return targetExt?.input
  })()

  const targetColor = isLlmLink
    ? HANDLE_COLOR.llm
    : targetNode?.type === 'outputNode'
    ? HANDLE_COLOR.mesh
    : targetNode?.type === 'previewNode'
    ? HANDLE_COLOR.image
    : targetNode?.type === 'llmNode'
    ? HANDLE_COLOR.text
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

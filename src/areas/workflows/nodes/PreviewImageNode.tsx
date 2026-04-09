import { Handle, Position, useReactFlow } from '@xyflow/react'
import { useWorkflowRunStore } from '../workflowRunStore'
import BaseNode from './BaseNode'

const INPUT_COLOR = '#38bdf8'

/**
 * Preview node for multi-view image outputs (e.g. MV-Adapter Generate Views).
 *
 * Expects a vertical strip PNG where N views are stacked top→bottom.
 * Displays them in a 2×3 grid using CSS background-position cropping.
 */
export default function PreviewImageNode({ id, selected }: { id: string; selected?: boolean }) {
  const nodeImageOutputs = useWorkflowRunStore((s) => s.nodeImageOutputs)
  const { getEdges }     = useReactFlow()

  // Find the image URL fed into this node (first matching incoming edge)
  const incomingEdge = getEdges().find((e) => e.target === id)
  const imageUrl     = incomingEdge ? nodeImageOutputs[incomingEdge.source] : undefined

  return (
    <BaseNode
      id={id}
      selected={selected}
      title="Preview Views"
      minWidth={200}
      icon={
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={INPUT_COLOR} strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <polyline points="21 15 16 10 5 21"/>
        </svg>
      }
      subheader={
        <div className="flex items-center gap-1.5 px-3 py-2">
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border border-sky-500/30 bg-sky-500/10 text-sky-400">image</span>
          <span className="text-[9px] text-zinc-600">→ preview</span>
        </div>
      }
      handles={
        <Handle
          type="target"
          position={Position.Left}
          style={{ background: INPUT_COLOR, width: 14, height: 14, border: '2.5px solid #18181b' }}
        />
      }
    >
      <div className="px-2 pb-2 pt-1">
        {imageUrl ? (
          <div
            className="nodrag grid gap-0.5 rounded overflow-hidden"
            style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}
          >
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div
                key={i}
                style={{
                  aspectRatio: '1',
                  backgroundImage: `url(${imageUrl})`,
                  backgroundSize: '100% 600%',
                  backgroundPosition: `0 ${i * 20}%`,
                  backgroundRepeat: 'no-repeat',
                  borderRadius: '2px',
                }}
              />
            ))}
          </div>
        ) : (
          <p className="py-2 text-center text-[10px] text-zinc-600 italic">
            Connect a multi-view image to preview.
          </p>
        )}
      </div>
    </BaseNode>
  )
}

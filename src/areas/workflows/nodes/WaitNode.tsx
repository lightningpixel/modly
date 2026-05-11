import { Handle, Position } from '@xyflow/react'
import type { WFNodeData } from '@shared/types/electron.d'
import { useWorkflowRunStore } from '../workflowRunStore'
import BaseNode from './BaseNode'

const HANDLE_STYLE = { background: '#71717a', width: 14, height: 14, border: '2.5px solid #18181b' }

export default function WaitNode({ id, data, selected }: { id: string; data: WFNodeData; selected?: boolean }) {
  const status       = useWorkflowRunStore((s) => s.runState.status)
  const activeNodeId = useWorkflowRunStore((s) => s.activeNodeId)
  const continueRun  = useWorkflowRunStore((s) => s.continueRun)
  const isPaused     = status === 'paused' && activeNodeId === id

  return (
    <BaseNode
      id={id}
      selected={selected}
      title="Wait"
      minWidth={170}
      showInGenerate={data.showInGenerate ?? false}
      icon={
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#71717a" strokeWidth="2">
          <circle cx="12" cy="12" r="10"/>
          <polyline points="12 6 12 12 16 14"/>
        </svg>
      }
      subheader={isPaused ? (
        <button
          onClick={continueRun}
          className="nodrag w-full flex items-center justify-center gap-1.5 px-2.5 py-2 bg-amber-500/15 border-y border-amber-500/30 text-amber-400 hover:bg-amber-500/25 transition-colors text-[10px] font-medium animate-pulse"
        >
          <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
          Continue
        </button>
      ) : undefined}
      handles={
        <>
          <Handle type="target" position={Position.Left}  style={HANDLE_STYLE} />
          <Handle type="source" position={Position.Right} style={HANDLE_STYLE} />
        </>
      }
    >
      <div className="px-3 pb-3 pt-2.5">
        <p className="text-[10px] text-zinc-500 italic">
          {isPaused ? 'Workflow paused — click Continue to resume.' : 'Pauses the workflow until you click Continue.'}
        </p>
      </div>
    </BaseNode>
  )
}

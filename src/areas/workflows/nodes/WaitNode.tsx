import { Handle, Position } from '@xyflow/react'
import type { WFNodeData } from '@shared/types/electron.d'
import { useWaitButton } from '../useWaitButton'
import BaseNode from './BaseNode'

const HANDLE_STYLE = { background: '#71717a', width: 14, height: 14, border: '2.5px solid #18181b' }

export default function WaitNode({ id, data, selected }: { id: string; data: WFNodeData; selected?: boolean }) {
  const { waitState, canContinue, isRunning, label, buttonClass, statusText, onContinue } = useWaitButton(id)

  const subheader = waitState ? (
    <button
      onClick={onContinue}
      disabled={!canContinue}
      className={`nodrag w-full flex items-center justify-center gap-1.5 px-2.5 py-2 border-y transition-colors text-[10px] font-medium ${buttonClass} ${
        canContinue ? (waitState === 'pending' ? 'animate-pulse' : '') : 'opacity-40 cursor-not-allowed'
      }`}
    >
      {isRunning ? (
        <>
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="animate-spin">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
          Running…
        </>
      ) : (
        <>
          <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
          {label}
        </>
      )}
    </button>
  ) : undefined

  return (
    <BaseNode
      id={id}
      selected={selected}
      title={String(data.label ?? 'Continue this workflow')}
      minWidth={170}
      showInGenerate={data.showInGenerate ?? false}
      icon={
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#71717a" strokeWidth="2">
          <circle cx="12" cy="12" r="10"/>
          <polyline points="12 6 12 12 16 14"/>
        </svg>
      }
      subheader={subheader}
      handles={
        <>
          <Handle type="target" position={Position.Left}  style={HANDLE_STYLE} />
          <Handle type="source" position={Position.Right} style={HANDLE_STYLE} />
        </>
      }
    >
      <div className="px-3 pb-3 pt-2.5">
        <p className="text-[10px] text-zinc-500 italic">{statusText}</p>
      </div>
    </BaseNode>
  )
}

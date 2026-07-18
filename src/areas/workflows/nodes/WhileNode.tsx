import { NodeResizer, useReactFlow } from '@xyflow/react'
import type { WFNodeData } from '@shared/types/electron.d'
import { useWorkflowRunStore } from '../workflowRunStore'

// While container — a resizable frame that wraps the loop-body nodes.
// Drop nodes inside it (they become children) to define the body; the runner
// re-runs that body either N times (iterations) or via the manual buttons.
export default function WhileNode({ id, data, selected }: { id: string; data: WFNodeData; selected?: boolean }) {
  const { updateNodeData, deleteElements } = useReactFlow()
  const status       = useWorkflowRunStore((s) => s.runState.status)
  const activeNodeId = useWorkflowRunStore((s) => s.activeNodeId)
  const continueWhile = useWorkflowRunStore((s) => s.continueWhile)
  const retryWhile    = useWorkflowRunStore((s) => s.retryWhile)
  const progress     = useWorkflowRunStore((s) => s.whileProgress[id])
  const isPaused     = status === 'paused' && activeNodeId === id
  const isRunning    = status === 'running' && activeNodeId === id
  // Lock the iteration count while a run is active so it can't change mid-loop.
  const locked       = status === 'running' || status === 'paused'

  return (
    <div
      style={{ width: '100%', height: '100%' }}
      className={`relative rounded-xl border-2 border-dashed flex flex-col
        ${isPaused || isRunning ? 'border-amber-500 bg-amber-500/[0.07]'
        : selected ? 'border-amber-500/70 bg-amber-500/[0.04]'
        : 'border-amber-500/40 bg-amber-500/[0.03]'}`}
    >
      <NodeResizer
        minWidth={260} minHeight={140}
        lineStyle={{ borderColor: 'transparent' }}
        handleStyle={{ background: '#f59e0b', border: 'none', width: 10, height: 10, borderRadius: 3 }}
        isVisible={selected}
      />

      {/* ── Header bar (drag handle) ─────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-3 py-2 shrink-0 bg-amber-500/10 rounded-t-[10px] border-b border-amber-500/20">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2">
          <polyline points="17 1 21 5 17 9"/>
          <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
          <polyline points="7 23 3 19 7 15"/>
          <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
        </svg>
        <span className="text-[11px] font-semibold text-amber-300 leading-none">While</span>

        {/* Iterations counter — 0 / empty = manual only */}
        <label className="nodrag flex items-center gap-1 ml-1 text-[9px] text-amber-400/70">
          <span>loop</span>
          <input
            type="number" min={0}
            value={data.iterations ?? 0}
            disabled={locked}
            onChange={(e) => updateNodeData(id, { iterations: Math.max(0, Number(e.target.value) || 0) })}
            onPointerDown={(e) => e.stopPropagation()}
            className={`nodrag w-11 px-1 py-0.5 bg-zinc-900/80 border border-amber-500/30 rounded text-amber-200 text-center outline-none focus:border-amber-500 ${locked ? 'opacity-50 cursor-not-allowed' : ''}`}
          />
          <span>×</span>
          {progress && (
            <span className="ml-1 px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-200 tabular-nums">
              {progress.total != null ? `${progress.current}/${progress.total}` : progress.current}
            </span>
          )}
        </label>

        <div className="flex-1" />

        {/* Continue / Retry — only while paused on this node */}
        {isPaused && (
          <div className="nodrag flex items-center gap-1">
            <button
              onClick={continueWhile}
              className="flex items-center gap-1 px-2 py-1 rounded bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/30 transition-colors text-[9px] font-medium"
            >
              <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              Continue
            </button>
            <button
              onClick={retryWhile}
              className="flex items-center gap-1 px-2 py-1 rounded bg-amber-500/20 border border-amber-500/40 text-amber-300 hover:bg-amber-500/30 transition-colors text-[9px] font-medium"
            >
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="23 4 23 10 17 10"/>
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
              </svg>
              Retry
            </button>
          </div>
        )}

        {/* Delete */}
        <button
          onClick={() => deleteElements({ nodes: [{ id }] })}
          className="nodrag p-0.5 rounded text-amber-500/50 hover:text-red-400 transition-colors shrink-0"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      {/* ── Body drop zone (children render here, on top) ────────────────── */}
      <div className="flex-1 min-h-0 flex items-center justify-center pointer-events-none">
        <span className="text-[10px] text-amber-500/30 italic select-none">
          Drop nodes here to loop them
        </span>
      </div>
    </div>
  )
}

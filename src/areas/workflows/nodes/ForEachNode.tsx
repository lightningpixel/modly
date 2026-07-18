import { useLayoutEffect, useRef, useState } from 'react'
import { Handle, Position, useReactFlow } from '@xyflow/react'
import type { WFNodeData } from '@shared/types/electron.d'
import BaseNode from './BaseNode'
import { useWorkflowRunStore } from '../workflowRunStore'

// For Each — an iterator source. It walks a folder alphabetically and emits one
// file per loop pass; every node wired downstream re-runs for each file. Runs to
// completion unless the user hits Stop, with an optional Pause (then Continue →
// next file / Retry → same file). A dropdown picks what it emits: image / text / mesh.
type Mode = 'image' | 'text' | 'mesh'

const MODES: Record<Mode, { title: string; color: string; hint: string }> = {
  image: { title: 'For Each Image', color: '#38bdf8', hint: 'images' },
  text:  { title: 'For Each Text',  color: '#fbbf24', hint: 'text files' },
  mesh:  { title: 'For Each Mesh',  color: '#a78bfa', hint: 'meshes' },
}

export default function ForEachNode({ id, data, selected }: { id: string; data: WFNodeData; selected?: boolean }) {
  const { updateNodeData } = useReactFlow()
  const mode    = ((data.params.mode as Mode | undefined) ?? 'image')
  const variant = MODES[mode] ?? MODES.image

  const status        = useWorkflowRunStore((s) => s.runState.status)
  const activeNodeId  = useWorkflowRunStore((s) => s.activeNodeId)
  const continueWhile = useWorkflowRunStore((s) => s.continueWhile)
  const retryWhile    = useWorkflowRunStore((s) => s.retryWhile)
  const pauseWhile    = useWorkflowRunStore((s) => s.pauseWhile)
  const progress      = useWorkflowRunStore((s) => s.whileProgress[id])
  const pausedGroup   = useWorkflowRunStore((s) => s.pausedGroup)
  const isPaused      = status === 'paused' && (activeNodeId === id || pausedGroup.includes(id))
  const isLooping     = status === 'running' && progress != null && !isPaused
  const locked        = status === 'running' || status === 'paused'

  const ioRowRef = useRef<HTMLDivElement>(null)
  const [handleTop, setHandleTop] = useState('50%')
  useLayoutEffect(() => {
    if (ioRowRef.current) setHandleTop(`${ioRowRef.current.offsetTop + ioRowRef.current.offsetHeight / 2}px`)
  }, [])

  const dir = (data.params.dir as string | undefined) ?? ''
  const dirLabel = dir ? dir.split(/[\\/]/).filter(Boolean).pop() : 'Pick folder…'

  const pickDir = async (): Promise<void> => {
    const picked = await window.electron.fs.selectDirectory(dir || undefined)
    if (picked) updateNodeData(id, { params: { ...data.params, dir: picked } })
  }

  return (
    <BaseNode
      id={id}
      selected={selected}
      running={isLooping || isPaused}
      title={variant.title}
      showInGenerate={data.showInGenerate ?? false}
      minWidth={200}
      autoHeight
      icon={
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={variant.color} strokeWidth="2">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
      }
      subheader={
        <div ref={ioRowRef} className="flex items-center justify-end px-3 py-2">
          {progress && (
            <span className="mr-auto px-1.5 py-0.5 rounded bg-zinc-700/60 text-zinc-300 tabular-nums text-[9px]">
              {progress.total != null ? `${progress.current}/${progress.total}` : progress.current}
            </span>
          )}
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border"
            style={{ borderColor: `${variant.color}55`, background: `${variant.color}18`, color: variant.color }}>
            {mode}
          </span>
        </div>
      }
      handles={
        <Handle type="source" position={Position.Right}
          style={{ background: variant.color, width: 14, height: 14, border: '2.5px solid #18181b', top: handleTop }} />
      }
    >
      <div className="px-3 pb-3 pt-2.5 flex flex-col gap-2">
        {/* Iterated type */}
        <select
          value={mode}
          disabled={locked}
          onChange={(e) => updateNodeData(id, { params: { ...data.params, mode: e.target.value as Mode, dir: undefined } })}
          className={`nodrag w-full bg-zinc-800 border border-zinc-700 rounded-lg px-2.5 py-2 text-[11px] text-zinc-200 focus:outline-none focus:border-zinc-600 ${locked ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          <option value="image">Image</option>
          <option value="text">Text</option>
          <option value="mesh">Mesh</option>
        </select>

        <button
          onClick={pickDir}
          disabled={locked}
          className={`nodrag w-full flex items-center gap-1.5 bg-zinc-800 border border-zinc-700 rounded-lg px-2.5 py-2 text-[11px] text-zinc-200 ${locked ? 'opacity-50 cursor-not-allowed' : 'hover:border-zinc-600'}`}
          title={dir || `Folder of ${variant.hint}`}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-zinc-500">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
          <span className="truncate">{dirLabel}</span>
        </button>

        {/* Run controls */}
        {isLooping && (
          <button
            onClick={pauseWhile}
            className="nodrag flex items-center justify-center gap-1 px-2 py-1 rounded bg-amber-500/20 border border-amber-500/40 text-amber-300 hover:bg-amber-500/30 transition-colors text-[10px] font-medium"
          >
            <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
            Pause
          </button>
        )}
        {isPaused && (
          <div className="nodrag flex items-center gap-1.5">
            <button
              onClick={continueWhile}
              className="flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/30 transition-colors text-[10px] font-medium"
            >
              <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              Continue
            </button>
            <button
              onClick={retryWhile}
              className="flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded bg-sky-500/20 border border-sky-500/40 text-sky-300 hover:bg-sky-500/30 transition-colors text-[10px] font-medium"
            >
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
              </svg>
              Retry
            </button>
          </div>
        )}
      </div>
    </BaseNode>
  )
}

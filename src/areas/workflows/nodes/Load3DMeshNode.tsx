import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { Handle, Position, useReactFlow } from '@xyflow/react'
import type { WFNodeData } from '@shared/types/electron.d'
import BaseNode from './BaseNode'

const OUTPUT_COLOR = '#a78bfa'

export default function Load3DMeshNode({ id, data, selected }: { id: string; data: WFNodeData; selected?: boolean }) {
  const { updateNodeData } = useReactFlow()
  const ioRowRef           = useRef<HTMLDivElement>(null)
  const [handleTop, setHandleTop] = useState('50%')

  useLayoutEffect(() => {
    if (ioRowRef.current) {
      const center = ioRowRef.current.offsetTop + ioRowRef.current.offsetHeight / 2
      setHandleTop(`${center}px`)
    }
  }, [])

  const source   = (data.params.source as 'file' | 'current') ?? 'file'
  const fileName = data.params.fileName as string | undefined

  const browse = useCallback(async () => {
    const p = await window.electron.fs.selectMeshFile()
    if (!p) return
    const name = p.split(/[\\/]/).pop() ?? p
    updateNodeData(id, { params: { ...data.params, filePath: p, fileName: name } })
  }, [id, data.params, updateNodeData])

  const toggleSource = useCallback(() => {
    const next = source === 'file' ? 'current' : 'file'
    updateNodeData(id, { params: { ...data.params, source: next } })
  }, [id, data.params, source, updateNodeData])

  return (
    <BaseNode
      id={id}
      selected={selected}
      title="Load 3D Mesh"
      showInGenerate={data.showInGenerate ?? false}
      minWidth={180}
      icon={
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={OUTPUT_COLOR} strokeWidth="2">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
        </svg>
      }
      subheader={
        <div ref={ioRowRef} className="flex items-center justify-end px-3 py-2">
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border border-violet-500/30 bg-violet-500/10 text-violet-400">mesh</span>
        </div>
      }
      handles={
        <Handle type="source" position={Position.Right}
          style={{ background: OUTPUT_COLOR, width: 14, height: 14, border: '2.5px solid #18181b', top: handleTop }} />
      }
    >
      <div className="px-3 py-2.5 flex flex-col gap-2">
        {/* Toggle: use current model */}
        <button
          onClick={toggleSource}
          className="nodrag flex items-center gap-2 w-full text-left"
        >
          <div className={`w-7 h-4 rounded-full relative transition-colors ${source === 'current' ? 'bg-violet-500' : 'bg-zinc-700'}`}>
            <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${source === 'current' ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
          </div>
          <span className="text-[10px] text-zinc-400">Use current model</span>
        </button>

        {/* File picker — disabled when using current */}
        {source === 'file' ? (
          fileName ? (
            <button
              onClick={browse}
              className="nodrag w-full flex items-center gap-2 px-2.5 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 transition-colors group"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={OUTPUT_COLOR} strokeWidth="2" className="shrink-0">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
              </svg>
              <span className="text-[10px] text-zinc-300 truncate flex-1 text-left">{fileName}</span>
              <span className="text-[9px] text-zinc-500 group-hover:text-zinc-400 shrink-0">Change…</span>
            </button>
          ) : (
            <button
              onClick={browse}
              className="nodrag w-full flex items-center gap-2 px-2.5 py-2 rounded-lg border border-dashed border-zinc-700 hover:border-violet-500/50 hover:bg-violet-500/5 transition-colors"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-zinc-500 shrink-0">
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
              </svg>
              <span className="text-[10px] text-zinc-500">Browse…</span>
            </button>
          )
        ) : (
          <div className="px-2.5 py-2 rounded-lg bg-zinc-800/50 border border-zinc-700/40">
            <span className="text-[10px] text-zinc-500">Will use the model currently loaded in the 3D viewer</span>
          </div>
        )}
      </div>
    </BaseNode>
  )
}

import { useCallback, useRef, useLayoutEffect, useState } from 'react'
import { Handle, Position, useReactFlow } from '@xyflow/react'
import type { WFNodeData } from '@shared/types/electron.d'
import BaseNode from './BaseNode'

const HANDLE_COLOR: Record<string, string> = {
  image: '#38bdf8',
  text:  '#fbbf24',
}

export default function InputNode({ id, data, selected }: { id: string; data: WFNodeData; selected?: boolean }) {
  const { updateNodeData } = useReactFlow()
  const inputType  = data.inputType ?? 'image'
  const handleColor = HANDLE_COLOR[inputType] ?? '#38bdf8'

  // Align handle with the type-toggle row
  const toggleRowRef  = useRef<HTMLDivElement>(null)
  const [handleTop, setHandleTop] = useState('50%')

  useLayoutEffect(() => {
    if (toggleRowRef.current) {
      const center = toggleRowRef.current.offsetTop + toggleRowRef.current.offsetHeight / 2
      setHandleTop(`${center}px`)
    }
  }, [])

  const setType = useCallback((t: 'image' | 'text') => {
    updateNodeData(id, { inputType: t })
  }, [id, updateNodeData])

  return (
    <BaseNode
      id={id}
      selected={selected}
      title="Input"
      deletable={false}
      minWidth={160}
      icon={<div className="w-2 h-2 rounded-full bg-zinc-500" />}
      handles={
        <Handle type="source" position={Position.Right}
          style={{ background: handleColor, width: 14, height: 14, border: '2.5px solid #18181b', top: handleTop }} />
      }
    >
      <div ref={toggleRowRef} className="px-3 pb-3 pt-2.5 flex gap-1.5">
        <button
          onClick={() => setType('image')}
          className={`nodrag flex-1 py-1 rounded-lg text-[10px] font-medium transition-colors
            ${inputType === 'image'
              ? 'bg-sky-500/20 text-sky-400 border border-sky-500/40'
              : 'bg-zinc-800 text-zinc-500 border border-zinc-700 hover:border-zinc-600'}`}
        >
          Image
        </button>
        <button
          onClick={() => setType('text')}
          className={`nodrag flex-1 py-1 rounded-lg text-[10px] font-medium transition-colors
            ${inputType === 'text'
              ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40'
              : 'bg-zinc-800 text-zinc-500 border border-zinc-700 hover:border-zinc-600'}`}
        >
          Text
        </button>
      </div>
    </BaseNode>
  )
}

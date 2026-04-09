import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Handle, Position, useReactFlow } from '@xyflow/react'
import type { WFNodeData } from '@shared/types/electron.d'
import BaseNode from './BaseNode'

const OUTPUT_COLOR = '#fbbf24'

export default function TextNode({ id, data, selected }: { id: string; data: WFNodeData; selected?: boolean }) {
  const { updateNodeData, setNodes } = useReactFlow()
  const ioRowRef    = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [handleTop, setHandleTop] = useState('50%')

  useLayoutEffect(() => {
    if (ioRowRef.current) {
      const center = ioRowRef.current.offsetTop + ioRowRef.current.offsetHeight / 2
      setHandleTop(`${center}px`)
    }
  }, [])

  // Clear stored height so React Flow measures content naturally
  useEffect(() => {
    setNodes(nodes => nodes.map(n => n.id === id ? { ...n, height: undefined } : n))
  }, [id, setNodes])

  const text = (data.params.text as string | undefined) ?? ''

  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${ta.scrollHeight}px`
  }, [text])

  return (
    <BaseNode
      id={id}
      selected={selected}
      title="Text"
      showInGenerate={data.showInGenerate ?? false}
      minWidth={180}
      autoHeight
      icon={
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="2">
          <path d="M17 6.1H3M21 12.1H3M15.1 18H3"/>
        </svg>
      }
      subheader={
        <div ref={ioRowRef} className="flex items-center justify-end px-3 py-2">
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border border-amber-500/30 bg-amber-500/10 text-amber-400">text</span>
        </div>
      }
      handles={
        <Handle type="source" position={Position.Right}
          style={{ background: OUTPUT_COLOR, width: 14, height: 14, border: '2.5px solid #18181b', top: handleTop }} />
      }
    >
      <div className="px-3 pb-3 pt-2.5">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => updateNodeData(id, { params: { ...data.params, text: e.target.value } })}
          placeholder="Enter text…"
          rows={1}
          className="nodrag w-full bg-zinc-800 border border-zinc-700 rounded-lg px-2.5 py-2 text-[11px] text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-amber-500/40 resize-none leading-relaxed overflow-hidden"
        />
      </div>
    </BaseNode>
  )
}

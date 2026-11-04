import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { Handle, Position, useReactFlow } from '@xyflow/react'
import type { WFNodeData } from '@shared/types/electron.d'

import BaseNode from './BaseNode'
import { normalizeVideoSource } from '../workflowVideoSource'

const OUTPUT_COLOR = '#f472b6'

export default function LoadVideoNode({ id, data, selected }: { id: string; data: WFNodeData; selected?: boolean }) {
  const { updateNodeData } = useReactFlow()
  const ioRowRef = useRef<HTMLDivElement>(null)
  const [handleTop, setHandleTop] = useState('50%')
  useLayoutEffect(() => {
    if (ioRowRef.current) setHandleTop(`${ioRowRef.current.offsetTop + ioRowRef.current.offsetHeight / 2}px`)
  }, [])

  const workspacePath = typeof data.params.workspacePath === 'string' ? data.params.workspacePath : ''
  const error = typeof data.params.error === 'string' ? data.params.error : undefined

  const browse = useCallback(async () => {
    const selectedVideo = await window.electron.fs.selectVideo()
    if (!selectedVideo) return
    const settings = await window.electron.settings.get()
    const normalized = normalizeVideoSource(selectedVideo.workspacePath, settings.workspaceDir)
    updateNodeData(id, { params: normalized
      ? { ...data.params, workspacePath: normalized.workspacePath, error: undefined }
      : { ...data.params, workspacePath: undefined, absolutePath: undefined, error: 'Video import did not return a safe workspace path.' } })
  }, [id, data, updateNodeData])

  return (
    <BaseNode id={id} selected={selected} title="Load Video" showInGenerate={data.showInGenerate ?? false} minWidth={220}
      icon={<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={OUTPUT_COLOR} strokeWidth="2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/></svg>}
      subheader={<div ref={ioRowRef} className="flex items-center justify-end px-3 py-2"><span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border border-pink-500/30 bg-pink-500/10 text-pink-400">video</span></div>}
      handles={<Handle type="source" position={Position.Right} style={{ background: OUTPUT_COLOR, width: 14, height: 14, border: '2.5px solid #18181b', top: handleTop }} />}
    >
      <div className="px-3 py-2.5 flex flex-col gap-2">
        <button onClick={browse} className="nodrag rounded-lg border border-pink-500/30 bg-pink-500/10 px-2 py-1.5 text-[10px] text-pink-300 hover:bg-pink-500/15 transition-colors">Import video...</button>
        <div className="rounded-lg border border-zinc-700/70 bg-zinc-900/40 px-2.5 py-2 text-[10px] text-zinc-500 break-all">
          {workspacePath || 'Imports a durable copy into the workspace for downstream video model nodes.'}
        </div>
        {error && <div className="text-[10px] text-rose-400">{error}</div>}
      </div>
    </BaseNode>
  )
}

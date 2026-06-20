import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Handle, Position, useReactFlow } from '@xyflow/react'
import { useWorkflowRunStore } from '../workflowRunStore'
import BaseNode from './BaseNode'

const IO_COLOR = '#38bdf8'

function mimeFromPath(p: string): string {
  const ext = p.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  return 'image/png'
}

/**
 * General single-image preview node.
 *
 * Reads the workspace path produced by the upstream node (from the run store's
 * nodeImageOutputs map) and renders it as a base64 data: URL — the same approach
 * ImageNode uses. This avoids any cross-origin/CSP issue with the API server and
 * does not depend on the API port.
 *
 * Has an optional pass-through image output so it can sit inline between nodes
 * without breaking the chain — the output is not required.
 */
export default function ImagePreviewNode({ id, selected }: { id: string; selected?: boolean }) {
  const nodeImageOutputs = useWorkflowRunStore((s) => s.nodeImageOutputs)
  const { getEdges }     = useReactFlow()
  const ioRowRef         = useRef<HTMLDivElement>(null)
  const [handleTop, setHandleTop] = useState('50%')
  const [dataUrl, setDataUrl]     = useState<string | undefined>(undefined)

  useLayoutEffect(() => {
    if (ioRowRef.current) {
      const center = ioRowRef.current.offsetTop + ioRowRef.current.offsetHeight / 2
      setHandleTop(`${center}px`)
    }
  }, [])

  // Workspace URL fed into this node, e.g. /workspace/Workflows/foo.png
  const incomingEdge = getEdges().find((e) => e.target === id)
  const workspaceUrl = incomingEdge ? nodeImageOutputs[incomingEdge.source] : undefined

  // Resolve the /workspace/... URL to a disk path and read it as a data: URL.
  // CSP allows data:, so this works regardless of the API origin/port.
  useEffect(() => {
    let cancelled = false
    if (!workspaceUrl) {
      setDataUrl(undefined)
      return
    }
    ;(async () => {
      try {
        const settings = await window.electron.settings.get()
        const wsDir    = settings.workspaceDir.replace(/\\/g, '/').replace(/\/+$/, '')
        const rel      = workspaceUrl.replace(/^\/workspace\//, '')
        const absPath  = `${wsDir}/${rel}`
        const base64   = await window.electron.fs.readFileBase64(absPath)
        if (!cancelled) setDataUrl(`data:${mimeFromPath(absPath)};base64,${base64}`)
      } catch {
        if (!cancelled) setDataUrl(undefined)
      }
    })()
    return () => { cancelled = true }
  }, [workspaceUrl])

  return (
    <BaseNode
      id={id}
      selected={selected}
      title="Preview Image"
      minWidth={180}
      icon={
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={IO_COLOR} strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <polyline points="21 15 16 10 5 21"/>
        </svg>
      }
      subheader={
        <div ref={ioRowRef} className="flex items-center justify-between px-3 py-2">
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border border-sky-500/30 bg-sky-500/10 text-sky-400">image</span>
          <span className="text-[9px] text-zinc-600">&rarr;</span>
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border border-sky-500/30 bg-sky-500/10 text-sky-400">image</span>
        </div>
      }
      handles={
        <>
          <Handle
            type="target"
            position={Position.Left}
            style={{ background: IO_COLOR, width: 14, height: 14, border: '2.5px solid #18181b', top: handleTop }}
          />
          <Handle
            type="source"
            position={Position.Right}
            style={{ background: IO_COLOR, width: 14, height: 14, border: '2.5px solid #18181b', top: handleTop }}
          />
        </>
      }
    >
      <div className="px-2 pb-2 pt-1 flex-1 min-h-0">
        {dataUrl ? (
          <img src={dataUrl} alt="preview" className="nodrag w-full h-full object-contain rounded" />
        ) : (
          <p className="py-3 text-center text-[10px] text-zinc-600 italic">
            Connect an image and run to preview.
          </p>
        )}
      </div>
    </BaseNode>
  )
}

import { useCallback } from 'react'
import { Handle, Position, useReactFlow } from '@xyflow/react'
import { useAppStore } from '@shared/stores/appStore'
import { useNavStore } from '@shared/stores/navStore'
import type { WFNodeData } from '@shared/types/electron.d'
import BaseNode from './BaseNode'

const INPUT_COLOR = '#a78bfa'

export default function AddToSceneNode({ id, data, selected }: { id: string; data: WFNodeData; selected?: boolean }) {
  const { navigate }  = useNavStore()
  const setCurrentJob = useAppStore((s) => s.setCurrentJob)
  const outputUrl     = data.params.outputUrl as string | undefined

  const viewIn3D = useCallback(() => {
    if (!outputUrl) return
    setCurrentJob({ id: 'workflow-output', imageFile: '', status: 'done', progress: 100, outputUrl, createdAt: Date.now() })
    navigate('generate')
  }, [outputUrl, setCurrentJob, navigate])

  return (
    <BaseNode
      id={id}
      selected={selected}
      title="Add to Scene"
      minWidth={160}
      icon={
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="2">
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
        </svg>
      }
      subheader={
        <div className="flex items-center gap-1.5 px-3 py-2">
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border border-violet-500/30 bg-violet-500/10 text-violet-400">mesh</span>
          <span className="text-[9px] text-zinc-600">→ scene</span>
        </div>
      }
      handles={
        <Handle type="target" position={Position.Left}
          style={{ background: INPUT_COLOR, width: 14, height: 14, border: '2.5px solid #18181b' }} />
      }
    >
      <div className="px-3 pb-3 pt-2.5">
        {outputUrl ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
              <span className="text-[10px] text-emerald-400">Mesh ready</span>
            </div>
            <button onClick={viewIn3D}
              className="nodrag w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-violet-500/15 border border-violet-500/30 text-violet-400 hover:bg-violet-500/25 hover:border-violet-500/50 transition-colors text-[10px] font-medium">
              Add to 3D scene
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M5 12h14M13 6l6 6-6 6"/>
              </svg>
            </button>
          </div>
        ) : (
          <p className="text-[10px] text-zinc-600 italic">Connect a mesh to add it to the 3D scene.</p>
        )}
      </div>
    </BaseNode>
  )
}

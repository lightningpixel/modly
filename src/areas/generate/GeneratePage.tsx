import { useState } from 'react'
import { useAppStore } from '@shared/stores/appStore'
import { useGeneration } from '@shared/hooks/useGeneration'
import GenerationHUD from './components/GenerationHUD'
import WorkspacePanel from './components/WorkspacePanel'
import Viewer3D from './components/Viewer3D'
import WorkflowPanel from './components/WorkflowPanel'

export default function GeneratePage(): JSX.Element {
  const selectedImagePath = useAppStore((s) => s.selectedImagePath)
  const modelId = useAppStore((s) => s.generationOptions.modelId)
  const { currentJob, startGeneration, cancelGeneration } = useGeneration()
  const isGenerating = currentJob?.status === 'uploading' || currentJob?.status === 'generating'

  const [unloadStatus, setUnloadStatus] = useState<'idle' | 'done'>('idle')

  const canGenerate = !!selectedImagePath && !!modelId && !isGenerating
  const disabledReason = !selectedImagePath ? 'Select an image first' : !modelId ? 'No model selected — install one in the Models tab' : undefined

  async function handleUnloadAll() {
    await window.electron.model.unloadAll()
    setUnloadStatus('done')
    setTimeout(() => setUnloadStatus('idle'), 2000)
  }

  return (
    <>
      <div className="flex flex-col w-80 border-r border-zinc-800 bg-surface-400">
        <WorkflowPanel />

        {/* Sticky bottom: Generate / Stop button */}
        <div className="p-4 border-t border-zinc-800">
          {isGenerating ? (
            <button
              onClick={cancelGeneration}
              className="w-full py-2.5 rounded-lg text-sm font-semibold bg-red-600 hover:bg-red-700 text-white transition-colors"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={() => canGenerate && startGeneration(selectedImagePath!)}
              disabled={!canGenerate}
              title={disabledReason}
              className="w-full py-2.5 rounded-lg text-sm font-semibold bg-accent hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
            >
              Generate 3D Model
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 relative overflow-hidden">
        <Viewer3D />
        <GenerationHUD />
        <WorkspacePanel />

        {/* Free memory button — top-left overlay */}
        <button
          onClick={handleUnloadAll}
          disabled={isGenerating}
          title="Free model from memory"
          className="absolute top-3 left-3 z-20 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-zinc-900/70 border border-zinc-700/50 backdrop-blur-sm text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 transition-colors disabled:opacity-30 disabled:pointer-events-none"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
            <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
          </svg>
          {unloadStatus === 'done' ? 'Freed' : 'Free memory'}
        </button>
      </div>
    </>
  )
}

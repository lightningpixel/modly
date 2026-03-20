import { useAppStore } from '@shared/stores/appStore'
import { useGeneration } from '@shared/hooks/useGeneration'
import ImageUpload from './components/ImageUpload'
import GenerationOptions from './components/GenerationOptions'
import GenerationHUD from './components/GenerationHUD'
import WorkspacePanel from './components/WorkspacePanel'
import Viewer3D from './components/Viewer3D'

export default function GeneratePage(): JSX.Element {
  const selectedImagePath = useAppStore((s) => s.selectedImagePath)
  const { currentJob, startGeneration, stopGeneration } = useGeneration()
  const isGenerating = currentJob?.status === 'uploading' || currentJob?.status === 'generating'

  return (
    <>
      <div className="flex flex-col w-80 border-r border-zinc-800 bg-surface-400">
        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto">
          <ImageUpload />
          <GenerationOptions />
        </div>

        {/* Sticky bottom: Generate button */}
        <div className="p-4 border-t border-zinc-800">
          {isGenerating ? (
            <button
              onClick={stopGeneration}
              className="w-full py-2.5 rounded-lg text-sm font-semibold bg-red-600 hover:bg-red-700 text-white transition-colors"
            >
              Stop Generation
            </button>
          ) : (
            <button
              onClick={() => selectedImagePath && startGeneration(selectedImagePath)}
              disabled={!selectedImagePath}
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
      </div>
    </>
  )
}

import { useCallback } from 'react'
import { useAppStore } from '@shared/stores/appStore'
import { useCollectionsStore } from '@shared/stores/collectionsStore'
import { useApi } from './useApi'

export function useGeneration() {
  const { currentJob, setCurrentJob, updateCurrentJob, generationOptions, viewImages } = useAppStore()
  const addToWorkspace = useCollectionsStore((s) => s.addToWorkspace)
  const activeCollectionId = useCollectionsStore((s) => s.activeCollectionId)
  const { generateFromImage, pollJobStatus } = useApi()

  const startGeneration = useCallback(
    async () => {
      // Build ordered arrays from view slots (front, left, back, right)
      // Only include slots that have images
      const VIEW_ORDER = ['front', 'left', 'back', 'right'] as const
      const filledSlots = VIEW_ORDER.filter((slot) => viewImages[slot])
      const imagePaths = filledSlots.map((slot) => viewImages[slot]!.path)
      const imageDataArray = filledSlots.map((slot) => viewImages[slot]!.data)

      const job = {
        id: crypto.randomUUID(),
        imageFile: imagePaths[0],
        status: 'uploading' as const,
        progress: 0,
        createdAt: Date.now(),
        modelId: generationOptions.modelId,
        generationOptions,
      }
      setCurrentJob(job)

      try {
        const { jobId } = await generateFromImage(imagePaths, generationOptions, activeCollectionId, imageDataArray, filledSlots as string[])

        updateCurrentJob({ status: 'generating', progress: 0 })

        // Poll until done
        await pollUntilDone(jobId)
      } catch (err) {
        updateCurrentJob({
          status: 'error',
          error: err instanceof Error ? err.message : String(err)
        })
      }
    },
    [generateFromImage, pollJobStatus, setCurrentJob, updateCurrentJob, addToWorkspace, activeCollectionId, viewImages]
  )

  const pollUntilDone = async (jobId: string) => {
    while (true) {
      await new Promise((r) => setTimeout(r, 1000))
      const result = await pollJobStatus(jobId)

      if (result.status === 'done') {
        updateCurrentJob({ status: 'done', progress: 100, outputUrl: result.outputUrl, originalOutputUrl: result.outputUrl })
        const finalJob = useAppStore.getState().currentJob
        if (finalJob) addToWorkspace(finalJob)
        break
      }

      if (result.status === 'error') {
        updateCurrentJob({ status: 'error', error: result.error })
        break
      }

      updateCurrentJob({
        progress: result.progress,
        step: result.step,
      })
    }
  }

  const reset = useCallback(() => setCurrentJob(null), [setCurrentJob])

  return { currentJob, startGeneration, reset }
}

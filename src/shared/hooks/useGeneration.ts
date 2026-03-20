import { useCallback, useRef } from 'react'
import { useAppStore } from '@shared/stores/appStore'
import { useCollectionsStore } from '@shared/stores/collectionsStore'
import { useApi } from './useApi'

export function useGeneration() {
  const { currentJob, setCurrentJob, updateCurrentJob, generationOptions, selectedImageData } = useAppStore()
  const addToWorkspace = useCollectionsStore((s) => s.addToWorkspace)
  const activeCollectionId = useCollectionsStore((s) => s.activeCollectionId)
  const { generateFromImage, pollJobStatus, cancelJob } = useApi()
  const cancelledRef = useRef(false)
  const activeJobIdRef = useRef<string | null>(null)

  const startGeneration = useCallback(
    async (imagePath: string) => {
      cancelledRef.current = false

      const job = {
        id: crypto.randomUUID(),
        imageFile: imagePath,
        status: 'uploading' as const,
        progress: 0,
        createdAt: Date.now(),
        modelId: generationOptions.modelId,
        generationOptions,
      }
      setCurrentJob(job)

      try {
        const { jobId } = await generateFromImage(imagePath, generationOptions, activeCollectionId, selectedImageData ?? undefined)
        activeJobIdRef.current = jobId

        if (cancelledRef.current) return

        updateCurrentJob({ status: 'generating', progress: 0 })

        // Poll until done
        await pollUntilDone(jobId)
      } catch (err) {
        if (!cancelledRef.current) {
          updateCurrentJob({
            status: 'error',
            error: err instanceof Error ? err.message : String(err)
          })
        }
      }
    },
    [generateFromImage, pollJobStatus, setCurrentJob, updateCurrentJob, addToWorkspace, activeCollectionId]
  )

  const pollUntilDone = async (jobId: string) => {
    while (true) {
      if (cancelledRef.current) break

      await new Promise((r) => setTimeout(r, 1000))

      if (cancelledRef.current) break

      const result = await pollJobStatus(jobId)

      if (result.status === 'cancelled') {
        updateCurrentJob({ status: 'error', error: 'Generation cancelled' })
        break
      }

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

  const stopGeneration = useCallback(async () => {
    cancelledRef.current = true
    const jobId = activeJobIdRef.current
    if (jobId) {
      try {
        await cancelJob(jobId)
      } catch {
        // Backend may have already finished
      }
    }
    activeJobIdRef.current = null
    setCurrentJob(null)
  }, [cancelJob, setCurrentJob])

  const reset = useCallback(() => setCurrentJob(null), [setCurrentJob])

  return { currentJob, startGeneration, stopGeneration, reset }
}

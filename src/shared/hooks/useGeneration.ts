import { useCallback, useRef } from 'react'
import { useAppStore } from '@shared/stores/appStore'
import { useApi } from './useApi'

export function useGeneration() {
  const { currentJob, setCurrentJob, updateCurrentJob, generationOptions, selectedImageData, pushMeshUrl, clearMeshHistory } = useAppStore()
  const { generateFromImage, pollJobStatus, cancelJob } = useApi()
  const cancelledRef = useRef(false)
  const abortControllerRef = useRef<AbortController | null>(null)

  const startGeneration = useCallback(
    async (imagePath: string) => {
      cancelledRef.current = false
      abortControllerRef.current = new AbortController()
      clearMeshHistory()
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
        const { jobId } = await generateFromImage(imagePath, generationOptions, selectedImageData ?? undefined, abortControllerRef.current.signal)

        if (cancelledRef.current) {
          await cancelJob(jobId)
          setCurrentJob(null)
          return
        }

        updateCurrentJob({ status: 'generating', progress: 0 })

        await pollUntilDone(jobId)
      } catch (err) {
        if (cancelledRef.current) {
          setCurrentJob(null)
          return
        }
        let errorMessage: string
        if (err && typeof err === 'object' && 'response' in err) {
          const axiosErr = err as { response?: { data?: { detail?: string } }; message: string }
          errorMessage = axiosErr.response?.data?.detail ?? axiosErr.message
        } else {
          errorMessage = err instanceof Error ? err.message : String(err)
        }
        updateCurrentJob({
          status: 'error',
          error: errorMessage
        })
      }
    },
    [generateFromImage, pollJobStatus, cancelJob, setCurrentJob, updateCurrentJob]
  )

  const pollUntilDone = async (jobId: string) => {
    while (true) {
      await new Promise((r) => setTimeout(r, 1000))

      if (cancelledRef.current) {
        await cancelJob(jobId)
        setCurrentJob(null)
        break
      }

      const result = await pollJobStatus(jobId)

      if (result.status === 'cancelled') {
        setCurrentJob(null)
        break
      }

      if (result.status === 'done') {
        updateCurrentJob({ status: 'done', progress: 100, outputUrl: result.outputUrl, originalOutputUrl: result.outputUrl })
        if (result.outputUrl) pushMeshUrl(result.outputUrl)
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

  const cancelGeneration = useCallback(() => {
    cancelledRef.current = true
    abortControllerRef.current?.abort()
  }, [])

  const reset = useCallback(() => setCurrentJob(null), [setCurrentJob])

  return { currentJob, startGeneration, cancelGeneration, reset }
}

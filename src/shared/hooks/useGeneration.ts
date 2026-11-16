import { useCallback, useRef } from 'react'
import { useAppStore } from '@shared/stores/appStore'
import { useApi } from './useApi'
import { showCompletionNotification, showRunErrorNotification } from '@shared/utils/notification'
import { runGeneration } from '@shared/utils/generationRunner'

export function useGeneration() {
  const { currentJob, setCurrentJob, updateCurrentJob, generationOptions, selectedImageData, pushMeshUrl, clearMeshHistory } = useAppStore()
  const { generateFromImage, pollJobStatus, cancelJob } = useApi()
  const cancelledRef = useRef(false)
  const abortControllerRef = useRef<AbortController | null>(null)

  const startGeneration = useCallback(
    async (imagePath: string) => {
      cancelledRef.current = false
      abortControllerRef.current = new AbortController()
      await runGeneration(imagePath, generationOptions, selectedImageData ?? undefined, {
        api: { generateFromImage, pollJobStatus, cancelJob },
        store: { setCurrentJob, updateCurrentJob, pushMeshUrl, clearMeshHistory },
        notifyComplete: (body) => showCompletionNotification(body),
        notifyError: (error, modelId) => showRunErrorNotification({ title: 'Generation failed', name: modelId, error, cancelled: cancelledRef.current }),
        isCancelled: () => cancelledRef.current,
        signal: abortControllerRef.current.signal,
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- useApi re-creates its fns each render, so this re-memoizes anyway (values stay fresh)
    [generateFromImage, pollJobStatus, cancelJob, setCurrentJob, updateCurrentJob]
  )

  const cancelGeneration = useCallback(() => {
    cancelledRef.current = true
    abortControllerRef.current?.abort()
  }, [])

  const reset = useCallback(() => setCurrentJob(null), [setCurrentJob])

  return { currentJob, startGeneration, cancelGeneration, reset }
}

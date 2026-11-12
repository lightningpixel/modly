import axios from 'axios'
import type { GenerationJob, GenerationOptions } from '../stores/appStore'

// The single-image generation path (POST /generate/from-image, then poll
// /generate/status), free of React so the agent can start one outside a hook.
// useGeneration and useApi both go through it.

export interface JobStatus {
  status: 'pending' | 'running' | 'done' | 'error' | 'cancelled'
  progress: number
  step?: string
  outputUrl?: string
  error?: string
}

export interface GenerationApi {
  generateFromImage: (imagePath: string, options: GenerationOptions, imageData?: string, signal?: AbortSignal) => Promise<{ jobId: string }>
  pollJobStatus: (jobId: string) => Promise<JobStatus>
  cancelJob: (jobId: string) => Promise<void>
}

export function createGenerationApi(apiUrl: string): GenerationApi {
  const client = axios.create({ baseURL: apiUrl })

  async function generateFromImage(
    imagePath: string,
    options: GenerationOptions,
    imageData?: string,
    signal?: AbortSignal,
  ): Promise<{ jobId: string }> {
    // Use provided base64 (drag & drop) or read from disk via IPC
    const base64 = imageData ?? await window.electron.fs.readFileBase64(imagePath)
    const byteArray = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const blob = new Blob([byteArray], { type: 'image/png' })
    const filename = imagePath.split(/[\\/]/).pop() ?? 'image.png'

    const formData = new FormData()
    formData.append('image', blob, filename)
    formData.append('model_id', options.modelId)
    formData.append('remesh', options.remesh)
    formData.append('enable_texture', String(options.enableTexture))
    formData.append('texture_resolution', String(options.textureResolution))
    formData.append('params', JSON.stringify(options.modelParams))
    const { data } = await client.post<{ job_id: string }>('/generate/from-image', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      signal,
    })

    return { jobId: data.job_id }
  }

  async function pollJobStatus(jobId: string): Promise<JobStatus> {
    const { data } = await client.get(`/generate/status/${jobId}`)
    return { ...data, outputUrl: data.output_url }
  }

  async function cancelJob(jobId: string): Promise<void> {
    await client.post(`/generate/cancel/${jobId}`).catch(() => {})
  }

  return { generateFromImage, pollJobStatus, cancelJob }
}

export interface GenerationStoreActions {
  setCurrentJob: (job: GenerationJob | null) => void
  updateCurrentJob: (patch: Partial<GenerationJob>) => void
  pushMeshUrl: (url: string) => void
  clearMeshHistory: () => void
}

export interface GenerationRunDeps {
  api: GenerationApi
  store: GenerationStoreActions
  notifyComplete: (body: string) => void | Promise<void>
  notifyError: (body: string, title: string) => void | Promise<void>
  isCancelled: () => boolean
  signal?: AbortSignal
  /** Delay between two status polls; tests pass a fast one. */
  wait?: () => Promise<void>
}

export type GenerationOutcome =
  | { status: 'done'; outputUrl?: string }
  | { status: 'error'; error: string }
  | { status: 'cancelled' }

/** Runs one generation into `currentJob`, so the Generate viewer shows it. */
export async function runGeneration(
  imagePath: string,
  options: GenerationOptions,
  imageData: string | undefined,
  deps: GenerationRunDeps,
): Promise<GenerationOutcome> {
  const { api, store } = deps
  const wait = deps.wait ?? (() => new Promise<void>((r) => setTimeout(r, 1000)))
  store.clearMeshHistory()
  store.setCurrentJob({
    id: crypto.randomUUID(),
    imageFile: imagePath,
    status: 'uploading',
    progress: 0,
    createdAt: Date.now(),
    modelId: options.modelId,
    generationOptions: options,
  })

  try {
    const { jobId } = await api.generateFromImage(imagePath, options, imageData, deps.signal)

    if (deps.isCancelled()) {
      await api.cancelJob(jobId)
      store.setCurrentJob(null)
      return { status: 'cancelled' }
    }

    store.updateCurrentJob({ status: 'generating', progress: 0 })

    for (;;) {
      await wait()

      if (deps.isCancelled()) {
        await api.cancelJob(jobId)
        store.setCurrentJob(null)
        return { status: 'cancelled' }
      }

      const result = await api.pollJobStatus(jobId)

      if (result.status === 'cancelled') {
        store.setCurrentJob(null)
        return { status: 'cancelled' }
      }

      if (result.status === 'done') {
        store.updateCurrentJob({ status: 'done', progress: 100, outputUrl: result.outputUrl, originalOutputUrl: result.outputUrl })
        if (result.outputUrl) store.pushMeshUrl(result.outputUrl)
        void deps.notifyComplete('Generation complete')
        return { status: 'done', outputUrl: result.outputUrl }
      }

      if (result.status === 'error') {
        store.updateCurrentJob({ status: 'error', error: result.error })
        void deps.notifyError(result.error ?? 'Unknown error', 'Generation failed')
        return { status: 'error', error: result.error ?? 'Unknown error' }
      }

      store.updateCurrentJob({
        progress: result.progress,
        step: result.step,
      })
    }
  } catch (err) {
    if (deps.isCancelled()) {
      store.setCurrentJob(null)
      return { status: 'cancelled' }
    }
    let errorMessage: string
    if (err && typeof err === 'object' && 'response' in err) {
      const axiosErr = err as { response?: { data?: { detail?: string } }; message: string }
      errorMessage = axiosErr.response?.data?.detail ?? axiosErr.message
    } else {
      errorMessage = err instanceof Error ? err.message : String(err)
    }
    store.updateCurrentJob({
      status: 'error',
      error: errorMessage,
    })
    void deps.notifyError(errorMessage, 'Generation failed')
    return { status: 'error', error: errorMessage }
  }
}

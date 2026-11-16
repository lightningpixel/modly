import axios from 'axios'
import { useAppStore } from '@shared/stores/appStore'
import { consumeSse } from '@shared/services/llmDownloads'
import { apiErrorMessage } from '@areas/generate/meshEditPanel'
import { notReadyMissing, type ImageOpDescriptor, type ImageOpStatus, type PrepareEvent, type SetupStep } from './imageOps'

// Client of the image-ops routes (api/routers/image*.py): list, status,
// one-time setup (SSE) and run. Paths are absolute files in <workspace>/Images.

/** POST /image/op/{op} answered 409: the op needs its one-time setup first. */
export class ImageOpNotReadyError extends Error {
  constructor(readonly missing: SetupStep[]) {
    super('This operation needs a one-time download first.')
    this.name = 'ImageOpNotReadyError'
  }
}

function opUrl(op: string, suffix = ''): string {
  return `${useAppStore.getState().apiUrl}/image/op/${encodeURIComponent(op)}${suffix}`
}

export async function listImageOps(): Promise<ImageOpDescriptor[]> {
  const { data } = await axios.get<{ ops?: ImageOpDescriptor[] }>(`${useAppStore.getState().apiUrl}/image/ops`)
  return Array.isArray(data?.ops) ? data.ops : []
}

export async function getImageOpStatus(op: string): Promise<ImageOpStatus> {
  try {
    const { data } = await axios.get<ImageOpStatus>(opUrl(op, '/status'))
    return data
  } catch (err) {
    throw new Error(apiErrorMessage(err))
  }
}

/** Streams the install of what `op` is missing; resolves when the stream ends. */
export function prepareImageOp(op: string, onEvent: (event: PrepareEvent) => void, signal?: AbortSignal): Promise<void> {
  return consumeSse(opUrl(op, '/prepare'), onEvent, signal, { method: 'POST' })
}

export async function runImageOp(op: string, path: string, params: Record<string, unknown>): Promise<{ path: string, maskPath?: string }> {
  try {
    const { data } = await axios.post<{ path: string, mask_path?: string | null }>(opUrl(op), { path, params })
    return { path: data.path, maskPath: data.mask_path ?? undefined }
  } catch (err) {
    const missing = notReadyMissing(err)
    if (missing) throw new ImageOpNotReadyError(missing)
    throw new Error(apiErrorMessage(err))
  }
}

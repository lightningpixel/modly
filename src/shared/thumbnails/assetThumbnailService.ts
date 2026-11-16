import { useAppStore } from '@shared/stores/appStore'
import type { AssetLibraryEntry } from '../types/assetLibrary'
import {
  createAssetThumbnailQueue,
  entriesNeedingThumbnails,
  meshUrlForWorkspacePath,
  workspacePathFromMeshUrl,
  type AssetThumbnailQueue,
} from './assetThumbnailQueue'
import { useAssetThumbnailStore } from './assetThumbnailStore'

// Pause between renders so a large backfill never monopolises the UI thread.
const RENDER_SPACING_MS = 100

let queue: AssetThumbnailQueue | null = null
// three.js is loaded on first render so it stays out of the app's entry chunk.
let renderModule: Promise<typeof import('./renderMeshThumbnail')> | null = null
const loadRenderModule = () => (renderModule ??= import('./renderMeshThumbnail'))

function getQueue(): AssetThumbnailQueue {
  if (queue) return queue
  const thumbnails = window.electron.workspace.thumbnails
  queue = createAssetThumbnailQueue({
    status: (workspacePath) => thumbnails.status(workspacePath),
    save: (request) => thumbnails.save(request),
    render: async (workspacePath) => {
      await new Promise((resolve) => setTimeout(resolve, RENDER_SPACING_MS))
      const { renderMeshThumbnail } = await loadRenderModule()
      return renderMeshThumbnail(meshUrlForWorkspacePath(useAppStore.getState().apiUrl, workspacePath))
    },
    onIdle: () => { void renderModule?.then((module) => module.releaseThumbnailRenderer()) },
    onReady: (workspacePath, thumbnailUrl) => useAssetThumbnailStore.getState().setThumbnailUrl(workspacePath, thumbnailUrl),
  })
  return queue
}

/** Queues thumbnails for library entries that lack one; resolves once they are all processed. */
export async function requestLibraryThumbnails(entries: AssetLibraryEntry[]): Promise<void> {
  await Promise.all(entriesNeedingThumbnails(entries).map((entry) => getQueue().ensure(entry.workspacePath)))
}

async function backfillLibraryThumbnails(): Promise<void> {
  try {
    const result = await window.electron.workspace.library.list()
    if (result.success) await requestLibraryThumbnails(result.entries)
  } catch {
    // Backfill is best effort; the next library listing retries.
  }
}

function viewerMeshUrl(state: ReturnType<typeof useAppStore.getState>): string | undefined {
  return state.currentJob?.status === 'done' ? state.currentJob.outputUrl : undefined
}

/**
 * Renders a thumbnail for every mesh that reaches the viewer (generation,
 * import, mesh edits, agent edits, library opens) and backfills the library
 * once the backend is up. Meshes already cached cost one status call. Returns
 * an unsubscribe function.
 */
export function startAssetThumbnailService(): () => void {
  if (useAppStore.getState().backendStatus === 'ready') void backfillLibraryThumbnails()
  return useAppStore.subscribe((state, previous) => {
    if (state.backendStatus === 'ready' && previous.backendStatus !== 'ready') void backfillLibraryThumbnails()
    const url = viewerMeshUrl(state)
    if (!url || url === viewerMeshUrl(previous)) return
    const workspacePath = workspacePathFromMeshUrl(url)
    if (workspacePath) void getQueue().ensure(workspacePath)
  })
}

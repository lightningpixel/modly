import type {
  AssetLibraryEntry,
  AssetThumbnailSaveRequest,
  AssetThumbnailSaveResult,
  AssetThumbnailStatusResult,
} from '../types/assetLibrary'

export interface AssetThumbnailQueueDeps {
  status: (workspacePath: string) => Promise<AssetThumbnailStatusResult>
  save: (request: AssetThumbnailSaveRequest) => Promise<AssetThumbnailSaveResult>
  /** Renders the mesh at this workspace path and returns encoded WebP bytes. */
  render: (workspacePath: string) => Promise<Uint8Array>
  /** Called whenever the queue drains, e.g. to release the offscreen GL context. */
  onIdle?: () => void
  /** Called once per processed request that ends with a thumbnail, so open views can show it. */
  onReady?: (workspacePath: string, thumbnailUrl: string) => void
}

/** `/workspace/<path>` mesh URLs (what generation, import and edits push) → workspace path, for .glb/.gltf only. */
export function workspacePathFromMeshUrl(url: string): string | null {
  if (!url.startsWith('/workspace/')) return null
  let workspacePath: string
  try {
    workspacePath = decodeURIComponent(url.slice('/workspace/'.length).split('?')[0] ?? '')
  } catch {
    return null
  }
  return /\.(glb|gltf)$/i.test(workspacePath) ? workspacePath : null
}

export function meshUrlForWorkspacePath(apiUrl: string, workspacePath: string): string {
  return `${apiUrl.replace(/\/$/, '')}/workspace/${workspacePath.split('/').map(encodeURIComponent).join('/')}`
}

/** Library entries that can be rendered but have no thumbnail for their current file version yet. */
export function entriesNeedingThumbnails(entries: AssetLibraryEntry[]): AssetLibraryEntry[] {
  return entries.filter((entry) => entry.state === 'ready' && entry.openable && entry.previewKind === '3d-model' && !entry.thumbnailUrl)
}

/**
 * Serial render queue: one offscreen render at a time, each workspace path at
 * most once in flight, and a file version that failed to render is not retried
 * until the file changes. The main process is the source of truth for whether
 * a version is already cached, so a thumbnail is rendered at most once per
 * file version even across sessions.
 */
export function createAssetThumbnailQueue(deps: AssetThumbnailQueueDeps) {
  const inFlight = new Map<string, Promise<string | null>>()
  const failedVersions = new Set<string>()
  let tail: Promise<unknown> = Promise.resolve()

  async function run(workspacePath: string): Promise<string | null> {
    const status = await deps.status(workspacePath)
    if (!status.success) return null
    if (status.thumbnailUrl) return status.thumbnailUrl
    const versionKey = `${status.workspacePath}@${status.version}`
    if (failedVersions.has(versionKey)) return null
    try {
      const image = await deps.render(status.workspacePath)
      const saved = await deps.save({ workspacePath: status.workspacePath, version: status.version, image })
      if (saved.success) return saved.thumbnailUrl
      // A stale save means the file changed mid-render: the next request renders the new version.
      if (saved.error.code !== 'stale') failedVersions.add(versionKey)
      return null
    } catch {
      failedVersions.add(versionKey)
      return null
    }
  }

  function ensure(workspacePath: string): Promise<string | null> {
    const existing = inFlight.get(workspacePath)
    if (existing) return existing
    const job = tail
      .then(() => run(workspacePath))
      .then((thumbnailUrl) => {
        if (thumbnailUrl) deps.onReady?.(workspacePath, thumbnailUrl)
        return thumbnailUrl
      })
      .catch(() => null)
      .finally(() => {
        inFlight.delete(workspacePath)
        if (inFlight.size === 0) deps.onIdle?.()
      })
    inFlight.set(workspacePath, job)
    tail = job
    return job
  }

  return { ensure }
}

export type AssetThumbnailQueue = ReturnType<typeof createAssetThumbnailQueue>

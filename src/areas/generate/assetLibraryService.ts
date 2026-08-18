import type {
  AssetLibraryError,
  AssetLibraryListResult,
  AssetLibraryOpenRequest,
  AssetLibraryOpenResult,
  AssetLibraryReadRequest,
  AssetLibraryReadResult,
  AssetLibraryThumbnailRequest,
  AssetLibraryThumbnailResult,
} from '../../shared/types/assetLibrary'
import { projectAssetLibraryEntry, type ProjectedAssetLibraryEntry } from './assetLibraryProjection'

export interface AssetLibraryPreloadApi {
  list: () => Promise<AssetLibraryListResult>
  read: (request: AssetLibraryReadRequest) => Promise<AssetLibraryReadResult>
  open: (request: AssetLibraryOpenRequest) => Promise<AssetLibraryOpenResult>
  thumbnail: (request: AssetLibraryThumbnailRequest) => Promise<AssetLibraryThumbnailResult>
}

export type ProjectedAssetLibraryListResult =
  | { success: true, entries: ProjectedAssetLibraryEntry[] }
  | { success: false, error: AssetLibraryError }

export type ProjectedAssetLibraryReadResult =
  | { success: true, entry: ProjectedAssetLibraryEntry, preview: Extract<AssetLibraryReadResult, { success: true }>['preview'] }
  | { success: false, error: AssetLibraryError }

export type ProjectedAssetLibraryOpenResult =
  | { success: true, entry: ProjectedAssetLibraryEntry }
  | { success: false, error: AssetLibraryError }

function unsafeError(message = 'Workspace path must stay under Workflows/ or Exports/.'): AssetLibraryError {
  return { code: 'unsafe-path', message }
}

function validateWorkspacePath(workspacePath: string): AssetLibraryError | null {
  const trimmed = workspacePath.trim()
  if (!trimmed || trimmed.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\')) return unsafeError()
  if (/%2e|%2f|%5c/i.test(trimmed) || trimmed.split(/[\\/]+/).includes('..')) return unsafeError()
  const normalized = trimmed.replace(/\\/g, '/')
  if (!normalized.startsWith('Workflows/') && !normalized.startsWith('Exports/')) return unsafeError()
  return null
}

export function createAssetLibraryService(api: AssetLibraryPreloadApi) {
  return {
    async list(): Promise<ProjectedAssetLibraryListResult> {
      const result = await api.list()
      if (!result.success) return result
      return { success: true, entries: result.entries.map(projectAssetLibraryEntry) }
    },
    async read(request: AssetLibraryReadRequest): Promise<ProjectedAssetLibraryReadResult> {
      const invalid = validateWorkspacePath(request.workspacePath) ?? (request.sourceWorkspacePath ? validateWorkspacePath(request.sourceWorkspacePath) : null)
      if (invalid) return { success: false, error: invalid }
      const result = await api.read(request)
      if (!result.success) return result
      return { success: true, entry: projectAssetLibraryEntry(result.entry), preview: result.preview }
    },
    async open(request: AssetLibraryOpenRequest): Promise<ProjectedAssetLibraryOpenResult> {
      const invalid = validateWorkspacePath(request.workspacePath) ?? (request.sourceWorkspacePath ? validateWorkspacePath(request.sourceWorkspacePath) : null)
      if (invalid) return { success: false, error: invalid }
      const result = await api.open(request)
      if (!result.success) return result
      return { success: true, entry: projectAssetLibraryEntry(result.entry) }
    },
    // A missing/invalid thumbnail is never an error the UI needs to show — the
    // Library list just falls back to its text-only row.
    async thumbnail(request: AssetLibraryThumbnailRequest): Promise<AssetLibraryThumbnailResult> {
      if (validateWorkspacePath(request.workspacePath)) return { success: false }
      return api.thumbnail(request)
    },
  }
}

export function getDefaultAssetLibraryService() {
  return createAssetLibraryService(window.electron.workspace.library)
}

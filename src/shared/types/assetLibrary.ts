import type { ArtifactProvenance } from './artifacts'

export const ASSET_CAPABILITIES = [
  'mesh',
  'rigged-mesh',
  'animation-motion',
  'landmarks-sidecar',
  'generated-world',
  'scene-manifest',
] as const

export const ASSET_ENTRY_STATES = ['ready', 'unknown-metadata', 'unsupported', 'unsafe'] as const
export const ASSET_LIBRARY_PREVIEW_KINDS = ['3d-model', 'text', 'binary', 'none'] as const
export const ASSET_LIBRARY_SOURCE_SCOPES = ['generated', 'workflows', 'exports'] as const
export const ASSET_LIBRARY_MANIFEST_CAPABILITIES = ['generated-world', 'scene-manifest'] as const

export type AssetCapability = typeof ASSET_CAPABILITIES[number]
export type AssetEntryState = typeof ASSET_ENTRY_STATES[number]
export type AssetLibraryPreviewKind = typeof ASSET_LIBRARY_PREVIEW_KINDS[number]
export type AssetLibrarySourceScope = typeof ASSET_LIBRARY_SOURCE_SCOPES[number]
export type AssetLibraryManifestCapability = typeof ASSET_LIBRARY_MANIFEST_CAPABILITIES[number]

export interface AssetLibraryError {
  code: 'unsafe-path' | 'not-found' | 'not-openable' | 'read-failed' | 'list-failed' | 'invalid-request'
  message: string
}

export interface AssetLibraryEntry {
  id: string
  workspacePath: string
  displayName: string
  sourceScope: AssetLibrarySourceScope
  capability?: AssetCapability
  state: AssetEntryState
  previewKind: AssetLibraryPreviewKind
  source?: AssetLibrarySourceLink
  manifest?: AssetLibraryManifestRef
  artifactId?: string
  versionId?: string
  provenance?: ArtifactProvenance
  warnings: string[]
  openable: boolean
  nonOpenableReason?: string
  createdAt?: string
  updatedAt?: string
  semantic?: AssetLibrarySemanticMetadata
}

export interface AssetLibraryLineageLink {
  workspacePath: string
  displayName?: string
}

export interface AssetLibraryDerivedFrom {
  /** The asset used directly to create this version. */
  parent: AssetLibraryLineageLink
  /** The first asset in the version family. */
  root: AssetLibraryLineageLink
}

/**
 * Human and structural metadata stored beside a model in `<model>.tags.json`.
 * The embedded `asset.extras.modly` copy carries the same name/project/tags
 * fields; the sidecar additionally owns creation time and lineage.
 */
export interface AssetLibrarySemanticMetadata {
  name?: string
  project?: string
  tags: string[]
  created?: string
  derivedFrom?: AssetLibraryDerivedFrom
}

export interface AssetLibrarySourceLink {
  workspacePath: string
  displayName?: string
  role?: 'source-mesh' | 'source-artifact' | 'related-source'
}

export interface AssetLibraryManifestRef {
  workspacePath: string
  capability: AssetLibraryManifestCapability
}

export type AssetLibraryPreviewPayload =
  | { kind: '3d-model', viewerKind: 'glb' | 'gltf' }
  | { kind: 'text', content: string, byteLength: number, truncated: boolean }
  | { kind: 'binary', binaryKind: string, byteLength: number, message: string }
  | { kind: 'none' }

export interface AssetLibraryReadRequest {
  workspacePath: string
  sourceWorkspacePath?: string
}

export type AssetLibraryOpenRequest = AssetLibraryReadRequest
export type AssetLibraryListRequest = Record<string, never>

export type AssetLibraryListResult =
  | { success: true, entries: AssetLibraryEntry[] }
  | { success: false, error: AssetLibraryError }

export type AssetLibraryReadResult =
  | { success: true, entry: AssetLibraryEntry, preview: AssetLibraryPreviewPayload }
  | { success: false, error: AssetLibraryError }

export type AssetLibraryOpenResult =
  | { success: true, entry: AssetLibraryEntry }
  | { success: false, error: AssetLibraryError }

export interface AssetLibraryPreviewClip {
  /** Animation clip name, matched against the manifest and echoed back on request. */
  clip: string
  /** Loop duration in seconds, as reported by the manifest. */
  duration: number
}

export interface AssetLibraryThumbnailRequest {
  workspacePath: string
  /**
   * When set, request the looping preview WebP for this clip instead of the
   * static thumbnail. Omit to fetch the static thumbnail (default), which also
   * carries the `previews` clip list when one exists so the UI can decide
   * whether hover-to-animate is available at all.
   */
  previewClip?: string
}

// Missing thumbnails are an expected, silent condition (not every asset has
// a rendered preview), so failure carries no error payload for the UI to show.
export type AssetLibraryThumbnailResult =
  | { success: true, dataUrl: string, previews?: AssetLibraryPreviewClip[] }
  | { success: false }

import type { GenerationJob } from '../../shared/stores/appStore'
import type { AssetLibraryOpenRequest } from '../../shared/types/assetLibrary'
import { resolveAssetLibraryOpenTarget, type AssetLibraryOpenTarget, type ProjectedAssetLibraryEntry } from './assetLibraryProjection'

export type GenerateOpenPanel = 'export' | 'decimate' | 'smooth' | 'import' | 'library' | 'light' | null
export type AssetLibrarySortMode = 'type' | 'name' | 'date'

export interface AssetLibraryEntryGroup {
  capability: NonNullable<ProjectedAssetLibraryEntry['capability']>
  capabilityLabel: string
  sectionKey: string
  entries: ProjectedAssetLibraryEntry[]
}

export interface AssetLibrarySourceScopeGroup {
  sourceScope: ProjectedAssetLibraryEntry['sourceScope']
  sourceScopeLabel: string
  sectionKey: string
  entryGroups: AssetLibraryEntryGroup[]
}

export interface AssetLibraryOpenSelection {
  historyUrl: string
  job: GenerationJob
}

const ASSET_LIBRARY_CAPABILITY_SECTIONS = [
  { capability: 'mesh', label: 'Mesh' },
  { capability: 'rigged-mesh', label: 'Rigged mesh' },
  { capability: 'animation-motion', label: 'Animations/motions' },
  { capability: 'landmarks-sidecar', label: 'Landmarks sidecars' },
  { capability: 'generated-world', label: 'Generated worlds' },
  { capability: 'scene-manifest', label: 'Scene manifests' },
] as const satisfies ReadonlyArray<{ capability: NonNullable<ProjectedAssetLibraryEntry['capability']>, label: string }>

const ASSET_LIBRARY_SOURCE_SCOPE_SECTIONS = [
  { sourceScope: 'workflows', label: 'Workflows' },
  { sourceScope: 'exports', label: 'Exports' },
] as const satisfies ReadonlyArray<{ sourceScope: ProjectedAssetLibraryEntry['sourceScope'], label: string }>

const ASSET_LIBRARY_CAPABILITY_ORDER = new Map(
  ASSET_LIBRARY_CAPABILITY_SECTIONS.map((section, index) => [section.capability, index]),
)

const ASSET_LIBRARY_INTERNAL_DIRECTORY_NAMES = new Set(['tmp', 'temp', 'cache'])

export const ASSET_LIBRARY_SORT_OPTIONS = [
  { value: 'type', label: 'Type' },
  { value: 'name', label: 'Name' },
  { value: 'date', label: 'Date' },
] as const satisfies ReadonlyArray<{ value: AssetLibrarySortMode, label: string }>

export function getDefaultAssetLibraryCollapsedSectionKeys(): string[] {
  const sectionKeys = ASSET_LIBRARY_SOURCE_SCOPE_SECTIONS.flatMap((scopeSection) => {
    const capabilityKeys = ASSET_LIBRARY_CAPABILITY_SECTIONS.map(
      (capabilitySection) => `capability:${scopeSection.sourceScope}:${capabilitySection.capability}`,
    )

    return [`scope:${scopeSection.sourceScope}`, ...capabilityKeys]
  })

  return [...sectionKeys]
}

export function toggleAssetLibrarySectionKey(currentKeys: string[], sectionKey: string): string[] {
  return currentKeys.includes(sectionKey)
    ? currentKeys.filter((value) => value !== sectionKey)
    : [...currentKeys, sectionKey]
}

export function buildAssetLibraryOpenRequest(entry: ProjectedAssetLibraryEntry): AssetLibraryOpenRequest {
  const target = resolveAssetLibraryOpenTarget(entry)
  return target.kind === 'linked-source'
    ? { workspacePath: target.workspacePath, sourceWorkspacePath: target.sourceWorkspacePath }
    : { workspacePath: entry.workspacePath }
}

export function isAssetLibraryEntryOpenable(entry: ProjectedAssetLibraryEntry | null | undefined): entry is ProjectedAssetLibraryEntry {
  return Boolean(entry && resolveAssetLibraryOpenTarget(entry).kind !== 'unavailable')
}

export function describeAssetLibraryOpenability(entry: ProjectedAssetLibraryEntry): string {
  if (entry.state === 'unknown-metadata') return 'Missing metadata prevents a safe open in Generate.'
  if (entry.state === 'unsupported') return 'This asset is tracked in the library but is not supported in Generate.'
  if (entry.state === 'unsafe') return 'This asset was rejected because its workspace path is unsafe.'
  const target = resolveAssetLibraryOpenTarget(entry)
  if (target.kind === 'linked-source') return `Ready to open linked source ${entry.source?.displayName ?? target.sourceWorkspacePath} in Generate.`
  if (target.kind === 'self') return 'Ready to open this asset directly in Generate.'
  if (entry.nonOpenableReason) return entry.nonOpenableReason
  if (!/\.(glb|gltf)$/i.test(entry.workspacePath)) return 'Only .glb/.gltf workspace assets are openable in this release.'
  return target.reason
}

export function filterVisibleAssetLibraryEntries(entries: ProjectedAssetLibraryEntry[]): ProjectedAssetLibraryEntry[] {
  return entries.filter((entry) => entry.state !== 'unsupported' && !hasInternalAssetLibraryDirectory(entry.workspacePath))
}

export function filterAssetLibraryScopeGroups(
  entries: ProjectedAssetLibraryEntry[],
  searchQuery: string,
  sortMode: AssetLibrarySortMode,
): AssetLibrarySourceScopeGroup[] {
  const normalizedSearchQuery = normalizeAssetLibrarySearchQuery(searchQuery)
  const visibleEntries = filterVisibleAssetLibraryEntries(entries)

  return ASSET_LIBRARY_SOURCE_SCOPE_SECTIONS
    .map((scopeSection): AssetLibrarySourceScopeGroup | null => {
      const scopeEntries = visibleEntries.filter((entry) => entry.sourceScope === scopeSection.sourceScope)
      const scopeMatches = normalizedSearchQuery.length > 0 && matchesAssetLibrarySearch(scopeSection.label, normalizedSearchQuery)

      const entryGroups = ASSET_LIBRARY_CAPABILITY_SECTIONS
        .map((capabilitySection): AssetLibraryEntryGroup | null => {
          const capabilityEntries = scopeEntries.filter((entry) => entry.capability === capabilitySection.capability)
          if (capabilityEntries.length === 0) return null

          const capabilityMatches = scopeMatches || (normalizedSearchQuery.length > 0 && matchesAssetLibrarySearch(capabilitySection.label, normalizedSearchQuery))
          const visibleCapabilityEntries = !normalizedSearchQuery || capabilityMatches
            ? capabilityEntries
            : capabilityEntries.filter((entry) => matchesAssetLibraryEntrySearch(entry, normalizedSearchQuery))

          if (visibleCapabilityEntries.length === 0) return null

          return {
            capability: capabilitySection.capability,
            capabilityLabel: capabilitySection.label,
            sectionKey: `capability:${scopeSection.sourceScope}:${capabilitySection.capability}`,
            entries: sortAssetLibraryEntries(visibleCapabilityEntries, sortMode),
          }
        })
        .filter((group): group is AssetLibraryEntryGroup => group !== null)

      const sortedEntryGroups = sortMode === 'type'
        ? entryGroups
        : [...entryGroups].sort((left, right) => compareAssetLibraryEntryGroups(left, right, sortMode))

      if (sortedEntryGroups.length === 0) return null
      return {
        sourceScope: scopeSection.sourceScope,
        sourceScopeLabel: scopeSection.label,
        sectionKey: `scope:${scopeSection.sourceScope}`,
        entryGroups: sortedEntryGroups,
      }
    })
    .filter((group): group is AssetLibrarySourceScopeGroup => group !== null)
}

export function createAssetLibraryOpenJob(
  entry: ProjectedAssetLibraryEntry,
  target: AssetLibraryOpenTarget,
  now = Date.now(),
): AssetLibraryOpenSelection | null {
  if (target.kind === 'unavailable') return null
  return {
    historyUrl: target.url,
    job: {
      id: `library-${now}`,
      imageFile: '',
      status: 'done',
      progress: 100,
      outputUrl: target.url,
      originalOutputUrl: target.url,
      createdAt: now,
    },
  }
}

export function resolveOpenPanelAfterLibrarySelection(currentPanel: GenerateOpenPanel): GenerateOpenPanel {
  return currentPanel === 'library' ? 'library' : currentPanel
}

function sortAssetLibraryEntries(
  entries: ProjectedAssetLibraryEntry[],
  sortMode: AssetLibrarySortMode,
): ProjectedAssetLibraryEntry[] {
  return [...entries].sort((left, right) => compareAssetLibraryEntries(left, right, sortMode))
}

function compareAssetLibraryEntryGroups(
  left: AssetLibraryEntryGroup,
  right: AssetLibraryEntryGroup,
  sortMode: Exclude<AssetLibrarySortMode, 'type'>,
): number {
  const entryComparison = compareAssetLibraryEntries(left.entries[0], right.entries[0], sortMode)
  if (entryComparison !== 0) return entryComparison

  return (ASSET_LIBRARY_CAPABILITY_ORDER.get(left.capability) ?? Number.MAX_SAFE_INTEGER)
    - (ASSET_LIBRARY_CAPABILITY_ORDER.get(right.capability) ?? Number.MAX_SAFE_INTEGER)
}

function compareAssetLibraryEntries(
  left: ProjectedAssetLibraryEntry,
  right: ProjectedAssetLibraryEntry,
  sortMode: AssetLibrarySortMode,
): number {
  if (sortMode === 'date') {
    const leftTime = resolveAssetLibrarySortTimestamp(left)
    const rightTime = resolveAssetLibrarySortTimestamp(right)
    if (leftTime !== null && rightTime !== null && leftTime !== rightTime) return rightTime - leftTime
    if (leftTime !== null && rightTime === null) return -1
    if (leftTime === null && rightTime !== null) return 1
  }

  return compareAssetLibraryEntryNames(left, right)
}

function compareAssetLibraryEntryNames(left: ProjectedAssetLibraryEntry, right: ProjectedAssetLibraryEntry): number {
  const displayNameComparison = left.displayName.localeCompare(right.displayName, undefined, { sensitivity: 'base' })
  if (displayNameComparison !== 0) return displayNameComparison
  const workspacePathComparison = left.workspacePath.localeCompare(right.workspacePath, undefined, { sensitivity: 'base' })
  if (workspacePathComparison !== 0) return workspacePathComparison
  return left.id.localeCompare(right.id, undefined, { sensitivity: 'base' })
}

function resolveAssetLibrarySortTimestamp(entry: ProjectedAssetLibraryEntry): number | null {
  return parseAssetLibrarySortTimestamp(entry.createdAt) ?? parseAssetLibrarySortTimestamp(entry.updatedAt)
}

function parseAssetLibrarySortTimestamp(value: string | undefined): number | null {
  if (typeof value !== 'string' || value.length === 0) return null
  const epochMs = Date.parse(value)
  return Number.isFinite(epochMs) ? epochMs : null
}

function normalizeAssetLibrarySearchQuery(searchQuery: string): string {
  return searchQuery.trim().toLocaleLowerCase()
}

function matchesAssetLibraryEntrySearch(entry: ProjectedAssetLibraryEntry, normalizedSearchQuery: string): boolean {
  return [
    entry.displayName,
    entry.workspacePath,
    entry.source?.workspacePath,
    entry.source?.displayName,
    entry.manifest?.workspacePath,
    entry.capability,
    entry.sourceScope,
    ...entry.warnings,
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .some((value) => matchesAssetLibrarySearch(value, normalizedSearchQuery))
}

function matchesAssetLibrarySearch(value: string, normalizedSearchQuery: string): boolean {
  return value.toLocaleLowerCase().includes(normalizedSearchQuery)
}

function hasInternalAssetLibraryDirectory(workspacePath: string): boolean {
  const segments = workspacePath.replace(/\\/g, '/').trim().split('/').filter(Boolean)
  return segments.slice(1, -1).some((segment) => segment.startsWith('.') || ASSET_LIBRARY_INTERNAL_DIRECTORY_NAMES.has(segment.toLocaleLowerCase()))
}

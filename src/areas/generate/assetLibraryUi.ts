import type { GenerationJob } from '../../shared/stores/appStore'
import type { AssetLibraryOpenRequest } from '../../shared/types/assetLibrary'
import { resolveAssetLibraryOpenTarget, type AssetLibraryOpenTarget, type ProjectedAssetLibraryEntry } from './assetLibraryProjection'

export type GenerateOpenPanel = 'export' | 'decimate' | 'smooth' | 'import' | 'library' | 'light' | null
export type AssetLibrarySortMode = 'date' | 'name' | 'type'
export type AssetLibraryViewMode = 'gallery' | 'list'
export type AssetLibraryKindFilter = 'all' | 'rigged' | 'animated' | 'character' | 'prop'
export type AssetLibraryPolyFilter = 'all' | 'low-poly' | 'mid-poly' | 'high-poly'

export interface AssetLibraryFilters {
  kind: AssetLibraryKindFilter
  poly: AssetLibraryPolyFilter
  needsAttention: boolean
}

export interface AssetLibraryLineageFamily {
  key: string
  rootWorkspacePath: string
  name: string
  project?: string
  entries: ProjectedAssetLibraryEntry[]
  primaryEntry: ProjectedAssetLibraryEntry
  tags: string[]
}

export interface AssetLibraryProjectGroup {
  projectKey: string
  projectLabel: string
  sectionKey: string
  families: AssetLibraryLineageFamily[]
  entryCount: number
}

export interface AssetLibraryOpenSelection {
  historyUrl: string
  job: GenerationJob
}

export const ASSET_LIBRARY_SORT_OPTIONS = [
  { value: 'date', label: 'Recently added' },
  { value: 'name', label: 'Name A–Z' },
  { value: 'type', label: 'Asset type' },
] as const satisfies ReadonlyArray<{ value: AssetLibrarySortMode, label: string }>

export const ASSET_LIBRARY_KIND_FILTERS = [
  { value: 'all', label: 'All assets' },
  { value: 'rigged', label: 'Rigged' },
  { value: 'animated', label: 'Animated' },
  { value: 'character', label: 'Characters' },
  { value: 'prop', label: 'Props' },
] as const satisfies ReadonlyArray<{ value: AssetLibraryKindFilter, label: string }>

export const ASSET_LIBRARY_POLY_FILTERS = [
  { value: 'all', label: 'Any weight' },
  { value: 'low-poly', label: 'Light' },
  { value: 'mid-poly', label: 'Medium' },
  { value: 'high-poly', label: 'Heavy' },
] as const satisfies ReadonlyArray<{ value: AssetLibraryPolyFilter, label: string }>

const ASSET_LIBRARY_INTERNAL_DIRECTORY_NAMES = new Set(['tmp', 'temp', 'cache'])
const NEEDS_PROJECT_KEY = 'needs-project'

export function createDefaultAssetLibraryFilters(): AssetLibraryFilters {
  return { kind: 'all', poly: 'all', needsAttention: false }
}

export function getDefaultAssetLibraryCollapsedSectionKeys(): string[] {
  return []
}

export function toggleAssetLibrarySectionKey(currentKeys: string[], sectionKey: string): string[] {
  return currentKeys.includes(sectionKey)
    ? currentKeys.filter((value) => value !== sectionKey)
    : [...currentKeys, sectionKey]
}

/**
 * Search and semantic filters always expose their matching projects. Clearing
 * them restores the operator's untouched collapse choices.
 */
export function isAssetLibrarySectionExpanded(
  collapsedSectionKeys: string[],
  sectionKey: string,
  hasActiveDiscovery: boolean,
): boolean {
  return hasActiveDiscovery || !collapsedSectionKeys.includes(sectionKey)
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

export function buildAssetLibraryProjectGroups(
  entries: ProjectedAssetLibraryEntry[],
  searchQuery: string,
  sortMode: AssetLibrarySortMode,
  filters: AssetLibraryFilters,
): AssetLibraryProjectGroup[] {
  const normalizedSearchQuery = normalizeAssetLibrarySearchQuery(searchQuery)
  const families = buildAssetLibraryLineageFamilies(filterVisibleAssetLibraryEntries(entries))
    .filter((family) => (
      (!normalizedSearchQuery || matchesAssetLibraryFamilySearch(family, normalizedSearchQuery))
      && family.entries.some((entry) => matchesAssetLibraryFilters(entry, filters))
    ))

  const groups = new Map<string, AssetLibraryProjectGroup>()
  for (const family of families) {
    const projectLabel = family.project ?? 'Needs project'
    const projectKey = family.project
      ? normalizeProjectKey(family.project)
      : NEEDS_PROJECT_KEY
    const current = groups.get(projectKey) ?? {
      projectKey,
      projectLabel,
      sectionKey: `project:${projectKey}`,
      families: [],
      entryCount: 0,
    }
    current.families.push(family)
    current.entryCount += family.entries.length
    groups.set(projectKey, current)
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      families: [...group.families].sort((left, right) => compareAssetLibraryFamilies(left, right, sortMode)),
    }))
    .sort(compareAssetLibraryProjectGroups)
}

export function buildAssetLibraryLineageFamilies(
  entries: ProjectedAssetLibraryEntry[],
): AssetLibraryLineageFamily[] {
  const grouped = new Map<string, ProjectedAssetLibraryEntry[]>()
  for (const entry of entries) {
    const rootWorkspacePath = entry.semantic?.derivedFrom?.root.workspacePath ?? entry.workspacePath
    grouped.set(rootWorkspacePath, [...(grouped.get(rootWorkspacePath) ?? []), entry])
  }

  return [...grouped.entries()].map(([rootWorkspacePath, familyEntries]) => {
    const sortedEntries = [...familyEntries].sort((left, right) => compareAssetLibraryEntries(left, right, 'date'))
    const primaryEntry = sortedEntries[0]
    const namedEntry = sortedEntries.find((entry) => entry.semantic?.name)
    const rootName = sortedEntries
      .map((entry) => entry.semantic?.derivedFrom?.root.displayName)
      .find((name): name is string => Boolean(name))
    const project = primaryEntry.semantic?.project
      ?? sortedEntries.map((entry) => entry.semantic?.project).find((value): value is string => Boolean(value))

    return {
      key: rootWorkspacePath,
      rootWorkspacePath,
      name: primaryEntry.semantic?.name ?? namedEntry?.semantic?.name ?? rootName ?? primaryEntry.displayName,
      project,
      entries: sortedEntries,
      primaryEntry,
      tags: [...new Set(sortedEntries.flatMap((entry) => entry.semantic?.tags ?? []))],
    }
  })
}

export function formatAssetLibraryClipName(clip: string): string {
  const words = clip
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
  if (!words) return 'Animation'
  return words.replace(/\b\w/g, (letter) => letter.toUpperCase())
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
      libraryEntryId: entry.id,
      libraryWorkspacePath: entry.workspacePath,
      createdAt: now,
    },
  }
}

export function resolveOpenPanelAfterLibrarySelection(currentPanel: GenerateOpenPanel): GenerateOpenPanel {
  return currentPanel === 'library' ? 'library' : currentPanel
}

// Gallery-first dimensions: even the narrowest supported panel keeps a
// motion preview well above the old 40px row thumbnail.
export const ASSET_LIBRARY_PANEL_MIN_WIDTH = 560
export const ASSET_LIBRARY_PANEL_MAX_WIDTH = 1200
export const ASSET_LIBRARY_PANEL_DEFAULT_WIDTH = 880

const ASSET_LIBRARY_PANEL_WIDTH_STORAGE_KEY = 'modly-library-panel-width'

export function clampAssetLibraryPanelWidth(width: number): number {
  return Math.min(ASSET_LIBRARY_PANEL_MAX_WIDTH, Math.max(ASSET_LIBRARY_PANEL_MIN_WIDTH, width))
}

export function getStoredAssetLibraryPanelWidth(): number {
  try {
    const raw = Number(localStorage.getItem(ASSET_LIBRARY_PANEL_WIDTH_STORAGE_KEY))
    return Number.isFinite(raw) && raw > 0 ? clampAssetLibraryPanelWidth(raw) : ASSET_LIBRARY_PANEL_DEFAULT_WIDTH
  } catch {
    return ASSET_LIBRARY_PANEL_DEFAULT_WIDTH
  }
}

export function storeAssetLibraryPanelWidth(width: number): void {
  try {
    localStorage.setItem(ASSET_LIBRARY_PANEL_WIDTH_STORAGE_KEY, String(width))
  } catch {
    // The panel still works when storage is unavailable.
  }
}

export const ASSET_LIBRARY_PANEL_MIN_HEIGHT = 420
export const ASSET_LIBRARY_PANEL_MAX_HEIGHT = 1200
export const ASSET_LIBRARY_PANEL_DEFAULT_HEIGHT = 900

const ASSET_LIBRARY_PANEL_HEIGHT_STORAGE_KEY = 'modly-library-panel-height'

export function clampAssetLibraryPanelHeight(height: number): number {
  return Math.min(ASSET_LIBRARY_PANEL_MAX_HEIGHT, Math.max(ASSET_LIBRARY_PANEL_MIN_HEIGHT, height))
}

export function getStoredAssetLibraryPanelHeight(): number {
  try {
    const raw = Number(localStorage.getItem(ASSET_LIBRARY_PANEL_HEIGHT_STORAGE_KEY))
    return Number.isFinite(raw) && raw > 0 ? clampAssetLibraryPanelHeight(raw) : ASSET_LIBRARY_PANEL_DEFAULT_HEIGHT
  } catch {
    return ASSET_LIBRARY_PANEL_DEFAULT_HEIGHT
  }
}

export function storeAssetLibraryPanelHeight(height: number): void {
  try {
    localStorage.setItem(ASSET_LIBRARY_PANEL_HEIGHT_STORAGE_KEY, String(height))
  } catch {
    // The panel still works when storage is unavailable.
  }
}

export interface AssetLibraryAnchorRect {
  left: number
  right: number
  top: number
  bottom: number
}

export interface AssetLibraryViewport {
  width: number
  height: number
}

export interface AssetLibraryPanelLayout {
  left: number
  top: number
  width: number
  height: number
  placement: 'above' | 'below'
}

/**
 * Fits the popover into the renderer's CSS viewport. Chromium shrinks that
 * viewport as whole-window zoom increases, so saved pixel preferences remain
 * preferences rather than unreachable off-screen dimensions.
 */
export function getAssetLibraryPanelLayout(
  anchor: AssetLibraryAnchorRect,
  viewport: AssetLibraryViewport,
  preferredWidth: number,
  preferredHeight: number,
  margin = 12,
  gap = 4,
): AssetLibraryPanelLayout {
  const availableWidth = Math.max(0, viewport.width - margin * 2)
  const width = Math.min(preferredWidth, availableWidth)
  const left = Math.min(
    Math.max(margin, anchor.left),
    Math.max(margin, viewport.width - margin - width),
  )

  const belowSpace = Math.max(0, viewport.height - margin - anchor.bottom - gap)
  const aboveSpace = Math.max(0, anchor.top - gap - margin)
  const minimumUsefulHeight = Math.min(preferredHeight, ASSET_LIBRARY_PANEL_MIN_HEIGHT)
  const placement = belowSpace < minimumUsefulHeight && aboveSpace > belowSpace ? 'above' : 'below'
  const availableHeight = placement === 'below' ? belowSpace : aboveSpace
  const height = Math.min(preferredHeight, availableHeight)
  const top = placement === 'below'
    ? anchor.bottom + gap
    : Math.max(margin, anchor.top - gap - height)

  return { left, top, width, height, placement }
}

function normalizeClipIdentity(name: string): string {
  return name.trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, '')
}

/** Matches preview-manifest clip names to the viewer's glTF animation list. */
export function findAssetLibraryMotionClipIndex(
  clips: Array<{ name: string }>,
  previewClip: string,
): number {
  const exact = clips.findIndex((clip) => clip.name === previewClip)
  if (exact >= 0) return exact
  const normalized = normalizeClipIdentity(previewClip)
  return clips.findIndex((clip) => normalizeClipIdentity(clip.name) === normalized)
}

function compareAssetLibraryProjectGroups(left: AssetLibraryProjectGroup, right: AssetLibraryProjectGroup): number {
  if (left.projectKey === NEEDS_PROJECT_KEY && right.projectKey !== NEEDS_PROJECT_KEY) return 1
  if (right.projectKey === NEEDS_PROJECT_KEY && left.projectKey !== NEEDS_PROJECT_KEY) return -1
  return left.projectLabel.localeCompare(right.projectLabel, undefined, { sensitivity: 'base' })
}

function compareAssetLibraryFamilies(
  left: AssetLibraryLineageFamily,
  right: AssetLibraryLineageFamily,
  sortMode: AssetLibrarySortMode,
): number {
  if (sortMode === 'name') {
    return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
  }
  if (sortMode === 'type') {
    const rankDifference = assetLibraryFamilyTypeRank(left) - assetLibraryFamilyTypeRank(right)
    if (rankDifference !== 0) return rankDifference
    return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
  }
  return compareAssetLibraryEntries(left.primaryEntry, right.primaryEntry, 'date')
}

function assetLibraryFamilyTypeRank(family: AssetLibraryLineageFamily): number {
  if (family.tags.includes('animated')) return 0
  if (family.tags.includes('rigged')) return 1
  if (family.tags.includes('character') || family.tags.includes('creature')) return 2
  if (family.tags.includes('prop')) return 3
  return 4
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

function matchesAssetLibraryFilters(entry: ProjectedAssetLibraryEntry, filters: AssetLibraryFilters): boolean {
  const tags = new Set(entry.semantic?.tags ?? [])
  const kindMatches = filters.kind === 'all'
    || (filters.kind === 'rigged' && (tags.has('rigged') || entry.capability === 'rigged-mesh'))
    || (filters.kind === 'animated' && tags.has('animated'))
    || (filters.kind === 'character' && ['character', 'characters', 'creature'].some((tag) => tags.has(tag)))
    || (filters.kind === 'prop' && ['prop', 'props'].some((tag) => tags.has(tag)))
  const polyMatches = filters.poly === 'all' || tags.has(filters.poly)
  const attentionMatches = !filters.needsAttention || tags.has('unnamed') || !entry.semantic?.name
  return kindMatches && polyMatches && attentionMatches
}

function matchesAssetLibraryFamilySearch(family: AssetLibraryLineageFamily, normalizedSearchQuery: string): boolean {
  return matchesAssetLibrarySearch(family.name, normalizedSearchQuery)
    || matchesAssetLibrarySearch(family.project ?? '', normalizedSearchQuery)
    || family.entries.some((entry) => matchesAssetLibraryEntrySearch(entry, normalizedSearchQuery))
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
    entry.semantic?.name,
    entry.semantic?.project,
    entry.semantic?.derivedFrom?.parent.workspacePath,
    entry.semantic?.derivedFrom?.root.workspacePath,
    ...entry.warnings,
    ...(entry.semantic?.tags ?? []),
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .some((value) => matchesAssetLibrarySearch(value, normalizedSearchQuery))
}

function normalizeAssetLibrarySearchQuery(searchQuery: string): string {
  return searchQuery.trim().toLocaleLowerCase()
}

function matchesAssetLibrarySearch(value: string, normalizedSearchQuery: string): boolean {
  return value.toLocaleLowerCase().includes(normalizedSearchQuery)
}

function normalizeProjectKey(project: string): string {
  return project.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || NEEDS_PROJECT_KEY
}

function hasInternalAssetLibraryDirectory(workspacePath: string): boolean {
  const segments = workspacePath.replace(/\\/g, '/').trim().split('/').filter(Boolean)
  return segments.slice(1, -1).some((segment) => segment.startsWith('.') || ASSET_LIBRARY_INTERNAL_DIRECTORY_NAMES.has(segment.toLocaleLowerCase()))
}

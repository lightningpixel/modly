import type { AssetCapability, AssetLibrarySourceScope } from '../../shared/types/assetLibrary'
import type { ProjectedAssetLibraryEntry } from '../generate/assetLibraryProjection'
import {
  ASSET_LIBRARY_CAPABILITY_SECTIONS,
  ASSET_LIBRARY_SOURCE_SCOPE_SECTIONS,
  filterAssetLibraryScopeGroups,
  filterVisibleAssetLibraryEntries,
  sortAssetLibraryEntries,
  type AssetLibrarySortMode,
} from '../generate/assetLibraryUi'

// What the Library page shows: the Generate picker's visibility, search and
// sort rules, plus capability and source-scope filters, as one flat list for
// the grid.

export type LibraryCapabilityFilter = AssetCapability | 'all'
export type LibraryScopeFilter = AssetLibrarySourceScope | 'all'
export type LibraryViewMode = 'grid' | 'list'

export interface LibraryQuery {
  search: string
  capability: LibraryCapabilityFilter
  scope: LibraryScopeFilter
  sort: AssetLibrarySortMode
}

export interface LibraryFilterOption<T extends string> {
  value: T
  label: string
  count: number
}

export const DEFAULT_LIBRARY_QUERY: LibraryQuery = { search: '', capability: 'all', scope: 'all', sort: 'date' }

const CAPABILITY_LABELS = new Map<string, string>(ASSET_LIBRARY_CAPABILITY_SECTIONS.map((s) => [s.capability, s.label]))

export function capabilityLabel(capability: AssetCapability | undefined): string {
  return (capability && CAPABILITY_LABELS.get(capability)) ?? 'Asset'
}

/** The entries to show, filtered and sorted. Type sort keeps the picker's scope → capability order. */
export function selectLibraryEntries(entries: ProjectedAssetLibraryEntry[], query: LibraryQuery): ProjectedAssetLibraryEntry[] {
  const inFilters = entries.filter((entry) => (
    (query.scope === 'all' || entry.sourceScope === query.scope)
    && (query.capability === 'all' || entry.capability === query.capability)
  ))
  const matches = filterAssetLibraryScopeGroups(inFilters, query.search, query.sort)
    .flatMap((scopeGroup) => scopeGroup.entryGroups.flatMap((group) => group.entries))
  return query.sort === 'type' ? matches : sortAssetLibraryEntries(matches, query.sort)
}

/** Scope filter options with the number of visible entries in each (ignoring the other filters). */
export function libraryScopeOptions(entries: ProjectedAssetLibraryEntry[]): LibraryFilterOption<LibraryScopeFilter>[] {
  const visible = visibleWithCapability(entries)
  return [
    { value: 'all', label: 'All', count: visible.length },
    ...ASSET_LIBRARY_SOURCE_SCOPE_SECTIONS.map((section) => ({
      value: section.sourceScope,
      label: section.label,
      count: visible.filter((entry) => entry.sourceScope === section.sourceScope).length,
    })),
  ]
}

/** Capability filter options: "All", then each capability present in the library. */
export function libraryCapabilityOptions(entries: ProjectedAssetLibraryEntry[]): LibraryFilterOption<LibraryCapabilityFilter>[] {
  const visible = visibleWithCapability(entries)
  const present = ASSET_LIBRARY_CAPABILITY_SECTIONS
    .map((section) => ({
      value: section.capability as LibraryCapabilityFilter,
      label: section.label,
      count: visible.filter((entry) => entry.capability === section.capability).length,
    }))
    .filter((option) => option.count > 0)
  return [{ value: 'all', label: 'All types', count: visible.length }, ...present]
}

// The picker only lists entries with a known capability; count the same set.
function visibleWithCapability(entries: ProjectedAssetLibraryEntry[]): ProjectedAssetLibraryEntry[] {
  return filterVisibleAssetLibraryEntries(entries).filter((entry) => entry.capability !== undefined)
}

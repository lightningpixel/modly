import type { ProjectedAssetLibraryEntry } from '../generate/assetLibraryProjection'
import { isAssetLibraryEntryOpenable } from '../generate/assetLibraryUi'
import { DEFAULT_LIBRARY_QUERY, selectLibraryEntries } from '../library/libraryView'

export const RECENT_ASSET_LIMIT = 6

/** The newest assets the user can reopen, by the Library's own visibility and date rules. */
export function selectRecentAssets(
  entries: ProjectedAssetLibraryEntry[],
  limit = RECENT_ASSET_LIMIT,
): ProjectedAssetLibraryEntry[] {
  return selectLibraryEntries(entries, DEFAULT_LIBRARY_QUERY)
    .filter((entry) => isAssetLibraryEntryOpenable(entry))
    .slice(0, limit)
}

function timeOf(value: string | undefined): number {
  const time = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY
}

// English like the rest of the UI ("yesterday"), not the OS language.
const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600], ['month', 30 * 24 * 3600], ['week', 7 * 24 * 3600],
  ['day', 24 * 3600], ['hour', 3600], ['minute', 60],
]

/** "5 minutes ago", "yesterday"… for an ISO date; null when it can't be read. */
export function formatRelativeDate(value: string | undefined, now = Date.now()): string | null {
  const time = timeOf(value)
  if (!Number.isFinite(time)) return null
  const seconds = Math.round((time - now) / 1000)
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return RELATIVE.format(Math.round(seconds / size), unit)
  }
  return RELATIVE.format(0, 'minute')
}

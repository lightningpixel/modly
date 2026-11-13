import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@shared/stores/appStore'
import { useNavStore } from '@shared/stores/navStore'
import { requestLibraryThumbnails } from '@shared/thumbnails/assetThumbnailService'
import type { ProjectedAssetLibraryEntry } from '@areas/generate/assetLibraryProjection'
import { getDefaultAssetLibraryService } from '@areas/generate/assetLibraryService'
import {
  ASSET_LIBRARY_SORT_OPTIONS,
  describeAssetLibraryOpenability,
  isAssetLibraryEntryOpenable,
  openAssetLibraryEntry,
  type AssetLibrarySortMode,
} from '@areas/generate/assetLibraryUi'
import LibraryGrid, { CapabilityIcon } from './LibraryGrid'
import {
  DEFAULT_LIBRARY_QUERY,
  libraryCapabilityOptions,
  libraryScopeOptions,
  selectLibraryEntries,
  type LibraryCapabilityFilter,
  type LibraryQuery,
  type LibraryViewMode,
} from './libraryView'

const VIEW_STORAGE_KEY = 'modly.library.view'

function readStoredView(): LibraryViewMode {
  try { return localStorage.getItem(VIEW_STORAGE_KEY) === 'list' ? 'list' : 'grid' } catch { return 'grid' }
}

const CONTROL = 'h-9 rounded-[10px] bg-zinc-900/70 border border-zinc-800 text-xs font-medium text-zinc-400 hover:text-zinc-200 hover:border-zinc-700 transition-colors focus:outline-none focus-visible:border-accent/50'

function ViewToggle({ view, onChange }: { view: LibraryViewMode, onChange: (view: LibraryViewMode) => void }): JSX.Element {
  const button = (mode: LibraryViewMode, label: string, icon: JSX.Element) => (
    <button
      type="button"
      onClick={() => onChange(mode)}
      aria-pressed={view === mode}
      title={label}
      aria-label={label}
      className={`flex h-[28px] w-8 items-center justify-center rounded-[7px] transition-colors
        ${view === mode ? 'bg-zinc-800 text-zinc-100 shadow-sm' : 'text-zinc-500 hover:text-zinc-200'}`}
    >
      {icon}
    </button>
  )
  return (
    <div className="flex items-center gap-0.5 rounded-[10px] border border-zinc-800 bg-zinc-900/70 p-[3px]">
      {button('grid', 'Grid view', (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
          <rect x="4" y="4" width="6.5" height="6.5" rx="1.2" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.2" />
          <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.2" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.2" />
        </svg>
      ))}
      {button('list', 'List view', (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
          <path d="M9 6h11M9 12h11M9 18h11" /><circle cx="4.5" cy="6" r="0.8" /><circle cx="4.5" cy="12" r="0.8" /><circle cx="4.5" cy="18" r="0.8" />
        </svg>
      ))}
    </div>
  )
}

function EmptyState({ title, detail, action }: { title: string, detail?: string, action?: JSX.Element }): JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-7 pb-16 text-center">
      <div className="mb-1 flex h-12 w-12 items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-900/60 text-zinc-600">
        <CapabilityIcon capability="mesh" size={22} />
      </div>
      <p className="text-sm font-medium text-zinc-300">{title}</p>
      {detail && <p className="max-w-sm text-xs text-zinc-500">{detail}</p>}
      {action}
    </div>
  )
}

export default function LibraryPage(): JSX.Element {
  const service = useMemo(() => getDefaultAssetLibraryService(), [])
  const setCurrentJob = useAppStore((s) => s.setCurrentJob)
  const pushMeshUrl = useAppStore((s) => s.pushMeshUrl)
  const navigate = useNavStore((s) => s.navigate)

  const [entries, setEntries] = useState<ProjectedAssetLibraryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [query, setQuery] = useState<LibraryQuery>(DEFAULT_LIBRARY_QUERY)
  const [view, setView] = useState<LibraryViewMode>(readStoredView)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [openingId, setOpeningId] = useState<string | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setListError(null)
    try {
      const result = await service.list()
      if (!result.success) {
        setListError(result.error.message)
        return
      }
      setEntries(result.entries)
      // Renders missing thumbnails in the background; tiles repaint as each one lands.
      void requestLibraryThumbnails(result.entries)
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [service])

  useEffect(() => { void load() }, [load])

  // "/" focuses the search, as on the Extensions page.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== '/') return
      const active = document.activeElement
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement) return
      event.preventDefault()
      searchRef.current?.focus()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const visible = useMemo(() => selectLibraryEntries(entries, query), [entries, query])
  const scopeOptions = useMemo(() => libraryScopeOptions(entries), [entries])
  const capabilityOptions = useMemo(() => libraryCapabilityOptions(entries), [entries])
  const total = scopeOptions[0].count
  const selected = visible.find((entry) => entry.id === selectedId) ?? null
  const filtered = query.search.trim() !== '' || query.capability !== 'all' || query.scope !== 'all'

  const updateQuery = (patch: Partial<LibraryQuery>) => setQuery((current) => ({ ...current, ...patch }))

  function changeView(next: LibraryViewMode) {
    setView(next)
    try { localStorage.setItem(VIEW_STORAGE_KEY, next) } catch { /* private mode / quota */ }
  }

  function selectEntry(entryId: string) {
    setSelectedId(entryId)
    setOpenError(null)
  }

  async function openEntry(entry: ProjectedAssetLibraryEntry) {
    if (openingId) return
    setSelectedId(entry.id)
    setOpenError(null)
    if (!isAssetLibraryEntryOpenable(entry)) {
      setOpenError(describeAssetLibraryOpenability(entry))
      return
    }
    setOpeningId(entry.id)
    try {
      const result = await openAssetLibraryEntry(service, entry)
      if (!result.success) {
        setOpenError(result.message)
        return
      }
      setCurrentJob(result.selection.job)
      pushMeshUrl(result.selection.historyUrl)
      navigate('generate')
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : String(err))
    } finally {
      setOpeningId(null)
    }
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">

      {/* Head */}
      <div className="flex shrink-0 items-start justify-between gap-6 px-7 pb-4 pt-6">
        <div>
          <h1 className="text-[21px] font-semibold tracking-tight text-zinc-100">Library</h1>
          <p className="mt-1 text-[13px] text-zinc-500" aria-live="polite">
            {loading && entries.length === 0
              ? 'Loading workspace assets…'
              : filtered
                ? <><b className="font-semibold text-zinc-200">{visible.length}</b> of {total} assets</>
                : <><b className="font-semibold text-zinc-200">{total}</b> {total === 1 ? 'asset' : 'assets'} in your workspace</>}
          </p>
        </div>
        <button
          type="button"
          onClick={() => { void load() }}
          disabled={loading}
          title="Re-scan the workspace"
          className="inline-flex items-center gap-2 whitespace-nowrap rounded-[9px] border border-zinc-700/60 bg-white/[0.025] px-3.5 py-2 text-xs font-medium text-zinc-200 transition-colors hover:border-zinc-600 hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={loading ? 'animate-spin' : ''} aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" />
          </svg>
          Refresh
        </button>
      </div>

      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-2.5 px-7 pb-4">
        <label className="flex h-9 min-w-[200px] flex-1 items-center gap-2.5 rounded-[10px] border border-zinc-800 bg-zinc-900/70 px-3.5 transition-colors focus-within:border-accent/40 focus-within:bg-zinc-900">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" className="shrink-0 text-zinc-600" aria-hidden="true">
            <circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" />
          </svg>
          <input
            ref={searchRef}
            type="text"
            aria-label="Search library assets"
            value={query.search}
            onChange={(event) => updateQuery({ search: event.target.value })}
            onKeyDown={(event) => { if (event.key === 'Escape') updateQuery({ search: '' }) }}
            placeholder="Search by name or path…"
            className="flex-1 bg-transparent text-[13px] text-zinc-200 placeholder-zinc-600 focus:outline-none"
          />
          {query.search ? (
            <button type="button" aria-label="Clear search" onClick={() => updateQuery({ search: '' })} className="text-zinc-600 transition-colors hover:text-zinc-400">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          ) : (
            <kbd className="rounded-[5px] border border-zinc-700/60 px-1.5 py-0.5 font-mono text-[10.5px] text-zinc-600">/</kbd>
          )}
        </label>

        {/* Source scope */}
        <div role="group" aria-label="Source" className="flex items-center gap-0.5 rounded-[10px] border border-zinc-800 bg-zinc-900/70 p-[3px]">
          {scopeOptions.map((option) => {
            const active = query.scope === option.value
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={active}
                onClick={() => updateQuery({ scope: option.value })}
                className={`flex h-[28px] items-center gap-1.5 rounded-[7px] px-2.5 text-xs font-medium transition-colors
                  ${active ? 'bg-zinc-800 text-zinc-100 shadow-sm' : 'text-zinc-500 hover:text-zinc-200'}`}
              >
                {option.label}
                <span className={`rounded-full bg-white/5 px-1.5 py-px font-mono text-[10px] ${active ? 'text-zinc-400' : 'text-zinc-600'}`}>{option.count}</span>
              </button>
            )
          })}
        </div>

        <select
          aria-label="Asset type"
          value={query.capability}
          onChange={(event) => updateQuery({ capability: event.target.value as LibraryCapabilityFilter })}
          className={`${CONTROL} px-3 ${query.capability !== 'all' ? 'text-zinc-100' : ''}`}
        >
          {capabilityOptions.map((option) => (
            <option key={option.value} value={option.value}>{option.label} ({option.count})</option>
          ))}
        </select>

        <select
          aria-label="Sort by"
          value={query.sort}
          onChange={(event) => updateQuery({ sort: event.target.value as AssetLibrarySortMode })}
          className={`${CONTROL} px-3`}
        >
          {ASSET_LIBRARY_SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.value === 'date' ? 'Newest first' : `Sort by ${option.label.toLowerCase()}`}</option>
          ))}
        </select>

        <ViewToggle view={view} onChange={changeView} />
      </div>

      <div className="mx-7 h-px shrink-0 bg-zinc-800/80" />

      {/* Content */}
      {listError && entries.length === 0 ? (
        <EmptyState
          title="The library could not be loaded"
          detail={listError}
          action={<button type="button" onClick={() => { void load() }} className="mt-2 text-xs font-medium text-accent-light hover:text-violet-300">Try again</button>}
        />
      ) : loading && entries.length === 0 ? (
        <EmptyState title="Loading workspace assets…" />
      ) : total === 0 ? (
        <EmptyState
          title="No assets yet"
          detail="Meshes you generate, import or export land here, ready to reopen in Generate."
          action={<button type="button" onClick={() => navigate('generate')} className="mt-2 text-xs font-medium text-accent-light hover:text-violet-300">Go to Generate</button>}
        />
      ) : visible.length === 0 ? (
        <EmptyState
          title="No matching assets"
          detail={query.search.trim() ? `Nothing matches “${query.search.trim()}” with the current filters.` : 'Nothing matches the current filters.'}
          action={<button type="button" onClick={() => setQuery((current) => ({ ...DEFAULT_LIBRARY_QUERY, sort: current.sort }))} className="mt-2 text-xs font-medium text-accent-light hover:text-violet-300">Clear filters</button>}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col pt-4">
          <LibraryGrid
            entries={visible}
            view={view}
            selectedId={selectedId}
            openingId={openingId}
            onSelect={selectEntry}
            onOpen={(entry) => { void openEntry(entry) }}
          />
        </div>
      )}

      {/* Status bar */}
      <div className="flex h-12 shrink-0 items-center gap-3 border-t border-zinc-800 bg-surface-400/60 px-7">
        {selected ? (
          <>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs text-zinc-200">
                {selected.displayName}
                <span className="ml-2 text-zinc-500">{selected.workspacePath}</span>
              </p>
              <p role={openError ? 'alert' : undefined} className={`truncate text-[11px] ${openError ? 'text-amber-300' : 'text-zinc-500'}`}>
                {openError ?? describeAssetLibraryOpenability(selected)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => { void openEntry(selected) }}
              disabled={!isAssetLibraryEntryOpenable(selected) || openingId !== null}
              className="shrink-0 rounded-lg bg-accent px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-violet-500 disabled:bg-zinc-800 disabled:text-zinc-500"
            >
              {openingId === selected.id ? 'Opening…' : 'Open in Generate'}
            </button>
          </>
        ) : (
          <p className="text-[11px] text-zinc-500">
            {listError ? <span className="text-amber-300">{listError}</span> : 'Double-click an asset to open it in Generate. Arrow keys move, Enter opens.'}
          </p>
        )}
      </div>
    </div>
  )
}

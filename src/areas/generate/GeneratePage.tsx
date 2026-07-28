import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import type { ReactNode } from 'react'
import { useAppStore, DEFAULT_LIGHT_SETTINGS } from '@shared/stores/appStore'
import type { GenerationJob, LightSettings } from '@shared/stores/appStore'
import { useApi } from '@shared/hooks/useApi'
import { ColorPicker } from '@shared/components/ui'
import GenerationHUD from './components/GenerationHUD'
import Viewer3D from './components/Viewer3D'
import WorkflowPanel from './components/WorkflowPanel'
import { getDefaultAssetLibraryService } from './assetLibraryService'
import { resolveAssetLibraryOpenTarget, type ProjectedAssetLibraryEntry } from './assetLibraryProjection'
import {
  ASSET_LIBRARY_SORT_OPTIONS,
  buildAssetLibraryOpenRequest,
  clampAssetLibraryPanelHeight,
  clampAssetLibraryPanelWidth,
  createAssetLibraryOpenJob,
  describeAssetLibraryOpenability,
  filterAssetLibraryScopeGroups,
  getDefaultAssetLibraryCollapsedSectionKeys,
  getStoredAssetLibraryPanelHeight,
  getStoredAssetLibraryPanelWidth,
  isAssetLibraryEntryOpenable,
  isAssetLibrarySectionExpanded,
  resolveOpenPanelAfterLibrarySelection,
  storeAssetLibraryPanelHeight,
  storeAssetLibraryPanelWidth,
  toggleAssetLibrarySectionKey,
  type AssetLibrarySortMode,
  type GenerateOpenPanel,
} from './assetLibraryUi'

const MIN_WIDTH = 220
const MAX_WIDTH = 900
const DEFAULT_WIDTH = 320

const PANEL_WIDTH_STORAGE_KEY = 'modly-panel-width'

function clampPanelWidth(width: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width))
}

/** Reads the user's saved Generate panel width, falling back to the default when unset, invalid, or unreadable. */
function getStoredPanelWidth(): number {
  try {
    const raw = Number(localStorage.getItem(PANEL_WIDTH_STORAGE_KEY))
    return Number.isFinite(raw) && raw > 0 ? clampPanelWidth(raw) : DEFAULT_WIDTH
  } catch {
    return DEFAULT_WIDTH
  }
}

/** Persists the Generate panel width so it survives app restarts. */
function storePanelWidth(width: number): void {
  try {
    localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(width))
  } catch {
    // Ignore quota/private-mode failures — the panel just won't remember its size.
  }
}

// ---------------------------------------------------------------------------
// Export dropdown
// ---------------------------------------------------------------------------

const EXPORT_FORMATS = [
  { fmt: 'glb' as const, desc: 'Binary glTF' },
  { fmt: 'obj' as const, desc: 'Wavefront' },
  { fmt: 'stl' as const, desc: '3D Print' },
  { fmt: 'ply' as const, desc: 'Polygon File' },
]

function ExportDropdown({
  onExport,
  onClose,
}: {
  onExport: (f: 'glb' | 'obj' | 'stl' | 'ply') => void
  onClose: () => void
}) {
  return (
    <div className="absolute top-full left-0 mt-1 z-50 bg-zinc-900 border border-zinc-700/60 rounded-xl p-1 flex flex-col gap-0.5 min-w-[150px] shadow-xl">
      {EXPORT_FORMATS.map(({ fmt, desc }) => (
        <button
          key={fmt}
          onClick={() => { onExport(fmt); onClose() }}
          className="px-3 py-2 text-left hover:bg-zinc-800 rounded-lg transition-colors flex items-center gap-2.5"
        >
          <span className="text-xs font-mono font-semibold text-zinc-200">.{fmt}</span>
          <span className="text-[10px] text-zinc-500">{desc}</span>
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ToolButton — icon-only toolbar button with tooltip + active state
// ---------------------------------------------------------------------------

function ToolButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`flex items-center justify-center w-7 h-7 rounded-lg border transition-colors
        ${active
          ? 'bg-zinc-700 border-zinc-600 text-zinc-200'
          : 'bg-zinc-800 border-zinc-700/50 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'
        }`}
    >
      {children}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Decimate popover
// ---------------------------------------------------------------------------

function DecimatePopover({
  currentTriangles,
  decimating,
  onDecimate,
  onClose,
}: {
  currentTriangles: number | null
  decimating: boolean
  onDecimate: (targetFaces: number) => void
  onClose: () => void
}) {
  const defaultTarget = currentTriangles ? Math.round(currentTriangles * 0.5) : 5000
  const [inputValue, setInputValue] = useState(String(defaultTarget))

  const parsed = parseInt(inputValue, 10)
  const validTarget = !isNaN(parsed) && parsed >= 100 ? parsed : null
  const reduction =
    currentTriangles && validTarget
      ? Math.round((1 - Math.min(validTarget, currentTriangles) / currentTriangles) * 100)
      : null

  return (
    <div className="absolute top-full left-0 mt-1 z-50 bg-zinc-900 border border-zinc-700/60 rounded-xl p-3 flex flex-col gap-3 min-w-[200px] shadow-xl">
      <p className="text-[10px] text-zinc-500 uppercase tracking-wider">Decimate mesh</p>

      {currentTriangles && (
        <p className="text-[10px] text-zinc-500">
          Current: <span className="text-zinc-300">{currentTriangles.toLocaleString()} tri</span>
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        <label className="text-[10px] text-zinc-500">Target faces</label>
        <input
          type="number"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          min={100}
          step={500}
          className="bg-zinc-800 border border-zinc-700 rounded-lg px-2.5 py-1.5 text-xs text-zinc-200 w-full focus:outline-none focus:border-violet-500 transition-colors"
        />
        {reduction !== null && (
          <p className="text-[10px] text-zinc-500">
            Reduction: <span className="text-violet-400">{reduction}%</span>
          </p>
        )}
      </div>

      <div className="flex gap-2">
        <button
          onClick={onClose}
          className="flex-1 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={() => validTarget && onDecimate(validTarget)}
          disabled={decimating || !validTarget}
          className="flex-1 px-3 py-1.5 bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-xs rounded-lg transition-colors flex items-center justify-center gap-1.5 font-medium"
        >
          {decimating ? (
            <>
              <svg className="animate-spin" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
              Processing…
            </>
          ) : 'Apply'}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Light popover
// ---------------------------------------------------------------------------

function LightPopover({
  settings,
  onChange,
  onClose,
}: {
  settings: LightSettings
  onChange: (s: LightSettings) => void
  onClose: () => void
}) {
  function lightRow(
    label: string,
    colorKey: keyof LightSettings,
    intensityKey: keyof LightSettings,
    max: number,
  ) {
    const intensity = settings[intensityKey] as number
    const color = settings[colorKey] as string
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <ColorPicker
            value={color}
            onChange={(c) => onChange({ ...settings, [colorKey]: c })}
          />
          <span className="text-[10px] text-zinc-400 flex-1">{label}</span>
          <span className="text-[10px] text-zinc-500 font-mono">{intensity.toFixed(1)}</span>
        </div>
        <input
          type="range"
          min={0}
          max={max}
          step={0.1}
          value={intensity}
          onChange={(e) => onChange({ ...settings, [intensityKey]: parseFloat(e.target.value) })}
          className="w-full h-1.5 accent-violet-500 cursor-pointer"
        />
      </div>
    )
  }

  function plainRow(label: string, intensityKey: keyof LightSettings, max: number) {
    const value = (settings[intensityKey] as number) ?? (DEFAULT_LIGHT_SETTINGS[intensityKey] as number)
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-zinc-400 flex-1">{label}</span>
          <span className="text-[10px] text-zinc-500 font-mono">{value.toFixed(2)}</span>
        </div>
        <input
          type="range"
          min={0}
          max={max}
          step={0.05}
          value={value}
          onChange={(e) => onChange({ ...settings, [intensityKey]: parseFloat(e.target.value) })}
          className="w-full h-1.5 accent-violet-500 cursor-pointer"
        />
      </div>
    )
  }

  return (
    <div className="absolute top-full right-0 mt-1 z-50 bg-zinc-900 border border-zinc-700/60 rounded-xl p-3 flex flex-col gap-3 min-w-[220px] shadow-xl">
      <div className="flex items-center justify-between">
        <p className="text-[10px] text-zinc-500 uppercase tracking-wider">Lighting</p>
        <button
          onClick={() => onChange(DEFAULT_LIGHT_SETTINGS)}
          className="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors"
        >
          Reset
        </button>
      </div>
      {lightRow('Sun', 'mainColor', 'mainIntensity', 4)}
      {lightRow('Fill', 'fillColor', 'fillIntensity', 2)}
      {plainRow('Ambient', 'ambientIntensity', 1.5)}
      {plainRow('Environment', 'envIntensity', 2)}
      <button
        onClick={onClose}
        className="mt-1 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors"
      >
        Close
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Smooth popover
// ---------------------------------------------------------------------------

function SmoothPopover({
  smoothing,
  onSmooth,
  onClose,
}: {
  smoothing: boolean
  onSmooth: (iterations: number) => void
  onClose: () => void
}) {
  const [inputValue, setInputValue] = useState('3')

  const parsed = parseInt(inputValue, 10)
  const valid = !isNaN(parsed) && parsed >= 1 && parsed <= 20

  return (
    <div className="absolute top-full left-0 mt-1 z-50 bg-zinc-900 border border-zinc-700/60 rounded-xl p-3 flex flex-col gap-3 min-w-[190px] shadow-xl">
      <p className="text-[10px] text-zinc-500 uppercase tracking-wider">Smooth mesh</p>

      <div className="flex flex-col gap-1.5">
        <label className="text-[10px] text-zinc-500">Iterations <span className="text-zinc-600">(1–20)</span></label>
        <input
          type="number"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          min={1}
          max={20}
          step={1}
          className="bg-zinc-800 border border-zinc-700 rounded-lg px-2.5 py-1.5 text-xs text-zinc-200 w-full focus:outline-none focus:border-violet-500 transition-colors"
        />
        <p className="text-[10px] text-zinc-600">More iterations = smoother, but loses detail</p>
      </div>

      <div className="flex gap-2">
        <button
          onClick={onClose}
          className="flex-1 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={() => valid && onSmooth(parsed)}
          disabled={smoothing || !valid}
          className="flex-1 px-3 py-1.5 bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-xs rounded-lg transition-colors flex items-center justify-center gap-1.5 font-medium"
        >
          {smoothing ? (
            <>
              <svg className="animate-spin" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
              Processing…
            </>
          ) : 'Apply'}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Workspace library popover
// ---------------------------------------------------------------------------

function AssetLibraryToggleButton({
  open,
  disabled,
  onToggle,
}: {
  open: boolean
  disabled: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      aria-haspopup="dialog"
      aria-expanded={open}
      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium border transition-colors disabled:opacity-50 disabled:pointer-events-none
        ${open
          ? 'bg-zinc-700 border-zinc-600 text-zinc-200'
          : 'bg-zinc-800 border-zinc-700/50 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'
        }`}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
        <path d="M4 6h16" />
        <path d="M4 12h16" />
        <path d="M4 18h10" />
      </svg>
      Library
    </button>
  )
}

function AssetLibraryPopover({
  entries,
  selectedEntryId,
  loading,
  opening,
  error,
  searchQuery,
  sortMode,
  collapsedSectionKeys,
  thumbnails,
  panelWidth,
  panelHeight,
  onSelectEntry,
  onSearchQueryChange,
  onSortModeChange,
  onToggleSection,
  onOpenSelected,
  onRefresh,
  onClose,
  onResizeMouseDown,
  onResizeHeightMouseDown,
}: {
  entries: ProjectedAssetLibraryEntry[]
  selectedEntryId: string | null
  loading: boolean
  opening: boolean
  error: string | null
  searchQuery: string
  sortMode: AssetLibrarySortMode
  collapsedSectionKeys: string[]
  /** Data URLs keyed by workspacePath, populated lazily as thumbnails load. */
  thumbnails: Record<string, string>
  panelWidth: number
  panelHeight: number
  onSelectEntry: (entryId: string) => void
  onSearchQueryChange: (value: string) => void
  onSortModeChange: (value: AssetLibrarySortMode) => void
  onToggleSection: (sectionKey: string) => void
  onOpenSelected: () => void
  onRefresh: () => void
  onClose: () => void
  onResizeMouseDown: (event: React.MouseEvent) => void
  onResizeHeightMouseDown: (event: React.MouseEvent) => void
}) {
  const scopeGroups = filterAssetLibraryScopeGroups(entries, searchQuery, sortMode)
  const visibleEntryIds = new Set(scopeGroups.flatMap((scopeGroup) => scopeGroup.entryGroups.flatMap((group) => group.entries.map((entry) => entry.id))))
  const selectedEntry = selectedEntryId && visibleEntryIds.has(selectedEntryId)
    ? entries.find((entry) => entry.id === selectedEntryId) ?? null
    : null
  const normalizedSearchQuery = searchQuery.trim()
  const hasActiveSearch = normalizedSearchQuery.length > 0
  const openDisabled = !selectedEntry || !isAssetLibraryEntryOpenable(selectedEntry) || loading || opening
  const selectedMessage = selectedEntry
    ? describeAssetLibraryOpenability(selectedEntry)
    : scopeGroups.length === 0 && normalizedSearchQuery
      ? `No workspace assets match “${normalizedSearchQuery}”.`
      : 'Select an asset to open it in Generate.'

  return (
    <div
      role="dialog"
      aria-label="Workspace library"
      style={{ width: panelWidth, height: panelHeight }}
      className="absolute top-full left-0 mt-1 z-50 max-w-[calc(100vw-2rem)] max-h-[calc(100vh-4rem)] bg-zinc-900 border border-zinc-700/60 rounded-xl p-3 flex flex-col gap-3 shadow-xl overflow-hidden"
    >
      <div className="flex items-center justify-between gap-2 shrink-0">
        <div>
          <p className="text-[10px] text-zinc-500 uppercase tracking-wider">Workspace library</p>
          <p className="text-xs text-zinc-300">Select a workspace asset and open the supported source in Generate.</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="px-2 py-1 text-[11px] text-zinc-400 hover:text-zinc-200 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors"
        >
          Close library
        </button>
      </div>

      {/* Resize handle — drag to widen/narrow the library panel; size is persisted. */}
      <div
        onMouseDown={onResizeMouseDown}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize workspace library panel width"
        className="absolute top-0 right-0 bottom-0 w-1.5 cursor-col-resize hover:bg-violet-400/40 active:bg-violet-400/60 transition-colors rounded-r-xl"
      />

      {/* Resize handle — drag to grow/shrink the library panel; size is persisted. */}
      <div
        onMouseDown={onResizeHeightMouseDown}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize workspace library panel height"
        className="absolute bottom-0 left-0 right-0 h-1.5 cursor-row-resize hover:bg-violet-400/40 active:bg-violet-400/60 transition-colors rounded-b-xl"
      />

      <button
        type="button"
        onClick={onRefresh}
        disabled={loading || opening}
        className="self-start shrink-0 px-2.5 py-1.5 text-[11px] text-zinc-300 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 disabled:pointer-events-none rounded-lg transition-colors"
      >
        Refresh assets
      </button>

      <div className="flex items-end gap-2 shrink-0">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <label htmlFor="asset-library-search" className="text-[11px] text-zinc-300">Search workspace assets</label>
          <input
            id="asset-library-search"
            type="search"
            value={searchQuery}
            onChange={(event) => onSearchQueryChange(event.target.value)}
            placeholder="Search by name, path, scope, or capability"
            className="appearance-none bg-zinc-800 border border-zinc-700 rounded-lg px-2.5 py-1.5 text-xs text-zinc-200 w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
          />
        </div>
        <div className="flex w-24 shrink-0 flex-col gap-1.5">
          <label htmlFor="asset-library-sort" className="text-[11px] text-zinc-300">Sort</label>
          <select
            id="asset-library-sort"
            value={sortMode}
            onChange={(event) => onSortModeChange(event.target.value as AssetLibrarySortMode)}
            className="bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1.5 text-xs text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
          >
            {ASSET_LIBRARY_SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
      </div>

      {loading ? (
        <p role="status" className="flex-1 min-h-0 flex items-center justify-center text-xs text-zinc-400">Loading workspace assets…</p>
      ) : scopeGroups.length === 0 && !normalizedSearchQuery ? (
        <p role="status" className="flex-1 min-h-0 flex items-center justify-center text-xs text-zinc-500">No workspace assets are indexed yet.</p>
      ) : scopeGroups.length === 0 ? (
        <p role="status" className="flex-1 min-h-0 flex items-center justify-center text-center text-xs text-zinc-500">{`No workspace assets match “${normalizedSearchQuery}”.`}</p>
      ) : (
        <div role="list" aria-label="Workspace library assets" className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden rounded-lg border border-zinc-800 bg-zinc-950/40">
          {scopeGroups.map((scopeGroup) => {
            const scopeExpanded = isAssetLibrarySectionExpanded(collapsedSectionKeys, scopeGroup.sectionKey, hasActiveSearch)
            const scopeRegionId = `asset-library-${scopeGroup.sectionKey.replace(/[^a-z0-9-]+/gi, '-')}`
            return (
              <section key={scopeGroup.sectionKey} role="group" aria-label={`Source scope ${scopeGroup.sourceScopeLabel}`} className="border-b border-zinc-800 last:border-b-0">
                <button
                  type="button"
                  aria-expanded={scopeExpanded}
                  aria-controls={scopeRegionId}
                  onClick={() => onToggleSection(scopeGroup.sectionKey)}
                  disabled={hasActiveSearch}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 disabled:opacity-50 disabled:pointer-events-none"
                >
                  <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-300">{scopeGroup.sourceScopeLabel}</span>
                  <span className="text-[10px] text-zinc-500">{scopeExpanded ? 'Hide' : 'Show'}</span>
                </button>
                {scopeExpanded && (
                  <div id={scopeRegionId}>
                    {scopeGroup.entryGroups.map((group) => {
                      const capabilityExpanded = isAssetLibrarySectionExpanded(collapsedSectionKeys, group.sectionKey, hasActiveSearch)
                      const capabilityRegionId = `asset-library-${group.sectionKey.replace(/[^a-z0-9-]+/gi, '-')}`
                      return (
                        <section key={group.sectionKey} role="group" aria-label={`Capability category ${group.capabilityLabel}`} className="border-t border-zinc-800 first:border-t-0">
                          <button
                            type="button"
                            aria-expanded={capabilityExpanded}
                            aria-controls={capabilityRegionId}
                            onClick={() => onToggleSection(group.sectionKey)}
                            disabled={hasActiveSearch}
                            className="flex w-full items-center justify-between gap-2 px-4 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 disabled:opacity-50 disabled:pointer-events-none"
                          >
                            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-400">{group.capabilityLabel}</span>
                            <span className="text-[10px] text-zinc-500">{capabilityExpanded ? 'Hide' : 'Show'}</span>
                          </button>
                          {capabilityExpanded && (
                            <div id={capabilityRegionId}>
                              {group.entries.map((entry) => {
                                const selected = entry.id === selectedEntryId
                                const thumbnailDataUrl = thumbnails[entry.workspacePath]
                                return (
                                  <button
                                    key={entry.id}
                                    type="button"
                                    role="listitem"
                                    aria-pressed={selected}
                                    aria-label={`Select library asset ${entry.displayName}`}
                                    onClick={() => onSelectEntry(entry.id)}
                                    className={`flex w-full items-center gap-3 text-left px-4 py-1.5 border-t border-zinc-800 first:border-t-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400
                                      ${selected ? 'bg-violet-500/10 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-800/80'}`}
                                  >
                                    {thumbnailDataUrl && (
                                      <img
                                        src={thumbnailDataUrl}
                                        alt=""
                                        className="h-10 w-10 shrink-0 rounded-lg border border-zinc-800 bg-zinc-950 object-contain"
                                      />
                                    )}
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center justify-between gap-2">
                                        <span className="truncate text-xs font-medium">{entry.displayName}</span>
                                        <span className="shrink-0 text-[10px] uppercase tracking-wider text-zinc-500">{entry.capability ?? entry.state.replace(/-/g, ' ')}</span>
                                      </div>
                                      <p className="mt-1 truncate text-[10px] text-zinc-500">{entry.workspacePath}</p>
                                    </div>
                                  </button>
                                )
                              })}
                            </div>
                          )}
                        </section>
                      )
                    })}
                  </div>
                )}
              </section>
            )
          })}
        </div>
      )}

      <div className="shrink-0 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
        <p className="text-[11px] text-zinc-400">{selectedMessage}</p>
        {error && <p role="alert" className="mt-2 text-[11px] text-amber-300">{error}</p>}
      </div>

      <button
        type="button"
        onClick={onOpenSelected}
        disabled={openDisabled}
        aria-label="Open selected asset"
        className="shrink-0 px-3 py-2 bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-xs rounded-lg transition-colors font-medium"
      >
        {opening ? 'Opening…' : 'Open selected asset'}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// GeneratePage
// ---------------------------------------------------------------------------

export default function GeneratePage(): JSX.Element {
  const [unloadStatus, setUnloadStatus] = useState<'idle' | 'done'>('idle')
  const [panelWidth, setPanelWidth] = useState<number>(() => getStoredPanelWidth())
  const [openPanel, setOpenPanel] = useState<GenerateOpenPanel>(null)
  const [decimating, setDecimating] = useState(false)
  const [smoothing, setSmoothing] = useState(false)
  const [importing, setImporting] = useState(false)
  const [libraryEntries, setLibraryEntries] = useState<ProjectedAssetLibraryEntry[]>([])
  const [librarySelectedEntryId, setLibrarySelectedEntryId] = useState<string | null>(null)
  const [libraryLoaded, setLibraryLoaded] = useState(false)
  const [libraryLoading, setLibraryLoading] = useState(false)
  const [libraryOpening, setLibraryOpening] = useState(false)
  const [libraryError, setLibraryError] = useState<string | null>(null)
  const [librarySearchQuery, setLibrarySearchQuery] = useState('')
  const [librarySortMode, setLibrarySortMode] = useState<AssetLibrarySortMode>('type')
  const [libraryCollapsedSectionKeys, setLibraryCollapsedSectionKeys] = useState<string[]>(() => getDefaultAssetLibraryCollapsedSectionKeys())
  const [libraryThumbnails, setLibraryThumbnails] = useState<Record<string, string>>({})
  const [libraryPanelWidth, setLibraryPanelWidth] = useState<number>(() => getStoredAssetLibraryPanelWidth())
  const [libraryPanelHeight, setLibraryPanelHeight] = useState<number>(() => getStoredAssetLibraryPanelHeight())
  const [gizmoMode, setGizmoMode] = useState<'translate' | 'rotate' | 'scale' | null>(null)
  const dragging = useRef(false)
  const libraryPanelDragging = useRef(false)
  const libraryPanelHeightDragging = useRef(false)
  // Populated by Viewer3D — undoes the latest live gizmo transform, if any.
  const gizmoUndoRef = useRef<(() => boolean) | null>(null)

  const lightSettings = useAppStore((s) => s.lightSettings)
  const setLightSettings = useAppStore((s) => s.setLightSettings)
  const isGenerating = useAppStore((s) =>
    s.currentJob?.status === 'uploading' || s.currentJob?.status === 'generating'
  )
  const currentJob = useAppStore((s) => s.currentJob)
  const apiUrl = useAppStore((s) => s.apiUrl)
  const showError = useAppStore((s) => s.showError)
  const updateCurrentJob = useAppStore((s) => s.updateCurrentJob)
  const setCurrentJob = useAppStore((s) => s.setCurrentJob)
  const meshStats = useAppStore((s) => s.meshStats)
  const meshSelected = useAppStore((s) => s.meshSelected)
  const pushMeshUrl = useAppStore((s) => s.pushMeshUrl)
  const undoMesh = useAppStore((s) => s.undoMesh)
  const redoMesh = useAppStore((s) => s.redoMesh)
  const canUndo = useAppStore((s) => s.historyIndex > 0)
  const canRedo = useAppStore((s) => s.historyIndex < s.meshHistory.length - 1)
  const { optimizeMesh, smoothMesh, importMesh } = useApi()
  const assetLibraryService = useMemo(() => getDefaultAssetLibraryService(), [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      if (e.key === 'z') { e.preventDefault(); if (gizmoUndoRef.current?.()) return; undoMesh() }
      if (e.key === 'y') { e.preventDefault(); redoMesh() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [undoMesh, redoMesh])

  const hasModel = currentJob?.status === 'done' && !!currentJob.outputUrl

  // Drop the active transform tool when the mesh is deselected, so it doesn't
  // silently re-activate on the next selection.
  useEffect(() => {
    if (!meshSelected) setGizmoMode(null)
  }, [meshSelected])

  // Gizmo hotkeys: W move, R rotate, S scale, Esc exits. Ignored while typing.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null
      if (el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable)) return
      if (e.key === 'Escape') { setGizmoMode((m) => (m ? null : m)); return }
      if (!hasModel || !meshSelected) return
      const k = e.key.toLowerCase()
      if (k === 'w') setGizmoMode('translate')
      else if (k === 'r') setGizmoMode('rotate')
      else if (k === 's') setGizmoMode('scale')
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [hasModel, meshSelected])

  useEffect(() => {
    if (openPanel !== 'library' || libraryLoaded || libraryLoading) return
    void loadLibraryEntries()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- lazy-load guarded by loaded/loading flags
  }, [openPanel, libraryLoaded, libraryLoading])

  // Persist the library panel's width so a manual resize survives app restarts.
  useEffect(() => {
    storeAssetLibraryPanelWidth(libraryPanelWidth)
  }, [libraryPanelWidth])

  // Persist the library panel's height so a manual resize survives app restarts.
  useEffect(() => {
    storeAssetLibraryPanelHeight(libraryPanelHeight)
  }, [libraryPanelHeight])

  // Persist the generate options panel's width so a manual resize survives app restarts.
  useEffect(() => {
    storePanelWidth(panelWidth)
  }, [panelWidth])

  async function handleUnloadAll() {
    await window.electron.model.unloadAll()
    setUnloadStatus('done')
    setTimeout(() => setUnloadStatus('idle'), 2000)
  }

  function handleExport(format: 'glb' | 'obj' | 'stl' | 'ply') {
    if (!currentJob?.outputUrl) return
    const stem = `modly-${Date.now()}`
    const link = document.createElement('a')
    if (format === 'glb') {
      link.href = `${apiUrl}${currentJob.outputUrl}`
    } else {
      const path = encodeURIComponent(currentJob.outputUrl.replace('/workspace/', ''))
      link.href = `${apiUrl}/optimize/export?path=${path}&format=${format}`
    }
    link.download = `${stem}.${format}`
    link.click()
  }

  function getOptimizePath(url: string): string {
    if (url.startsWith('/workspace/')) {
      return url.slice('/workspace/'.length)
    }
    if (url.startsWith('/optimize/serve-file?path=')) {
      return decodeURIComponent(url.split('path=')[1] ?? '')
    }
    return url
  }

  async function handleImportMesh() {
    const filePath = await window.electron.fs.selectMeshFile()
    if (!filePath) return
    setOpenPanel(null)
    setImporting(true)
    try {
      const { url } = await importMesh(filePath)
      const job: GenerationJob = {
        id: `import-${Date.now()}`,
        imageFile: '',
        status: 'done',
        progress: 100,
        outputUrl: url,
        originalOutputUrl: url,
        createdAt: Date.now(),
      }
      setCurrentJob(job)
      pushMeshUrl(url)
    } finally {
      setImporting(false)
    }
  }

  async function loadLibraryEntries() {
    setLibraryLoading(true)
    setLibraryError(null)
    try {
      const result = await assetLibraryService.list()
      if (!result.success) {
        setLibraryLoaded(false)
        setLibraryEntries([])
        setLibrarySelectedEntryId(null)
        setLibraryError(result.error.message)
        return
      }
      setLibraryEntries(result.entries)
      setLibrarySelectedEntryId((current) => current && result.entries.some((entry) => entry.id === current)
        ? current
        : result.entries.find(isAssetLibraryEntryOpenable)?.id ?? result.entries[0]?.id ?? null)
      setLibraryLoaded(true)
      void loadLibraryThumbnails(result.entries)
    } catch (err) {
      setLibraryLoaded(false)
      setLibraryEntries([])
      setLibrarySelectedEntryId(null)
      setLibraryError(err instanceof Error ? err.message : String(err))
    } finally {
      setLibraryLoading(false)
    }
  }

  // Thumbnails are best-effort: only .glb/.gltf entries can have a rendered
  // .thumb.png, and a missing one is silently skipped rather than surfaced.
  async function loadLibraryThumbnails(entries: ProjectedAssetLibraryEntry[]) {
    const candidates = entries.filter((entry) => entry.previewKind === '3d-model')
    const results = await Promise.all(candidates.map(async (entry) => {
      const result = await assetLibraryService.thumbnail({ workspacePath: entry.workspacePath })
      return [entry.workspacePath, result.success ? result.dataUrl : null] as const
    }))
    setLibraryThumbnails(Object.fromEntries(results.filter((pair): pair is [string, string] => pair[1] !== null)))
  }

  async function handleOpenSelectedLibraryEntry() {
    const selectedEntry = libraryEntries.find((entry) => entry.id === librarySelectedEntryId) ?? null
    if (!selectedEntry) {
      setLibraryError('Select an asset before opening it in Generate.')
      return
    }
    if (!isAssetLibraryEntryOpenable(selectedEntry)) {
      setLibraryError(describeAssetLibraryOpenability(selectedEntry))
      return
    }

    setLibraryOpening(true)
    setLibraryError(null)
    try {
      const result = await assetLibraryService.open(buildAssetLibraryOpenRequest(selectedEntry))
      if (!result.success) {
        setLibraryError(result.error.message)
        return
      }
      const target = resolveAssetLibraryOpenTarget(result.entry)
      const selection = createAssetLibraryOpenJob(result.entry, target)
      if (!selection) {
        setLibraryError(describeAssetLibraryOpenability(result.entry))
        return
      }
      setLibraryEntries((currentEntries) => currentEntries.map((entry) => entry.id === result.entry.id ? result.entry : entry))
      setLibrarySelectedEntryId(result.entry.id)
      setCurrentJob(selection.job)
      pushMeshUrl(selection.historyUrl)
      setOpenPanel((currentPanel) => resolveOpenPanelAfterLibrarySelection(currentPanel))
    } catch (err) {
      setLibraryError(err instanceof Error ? err.message : String(err))
    } finally {
      setLibraryOpening(false)
    }
  }

  async function handleSmooth(iterations: number) {
    if (!currentJob?.outputUrl) return
    setSmoothing(true)
    try {
      const path = getOptimizePath(currentJob.outputUrl)
      const { url } = await smoothMesh(path, iterations)
      updateCurrentJob({ outputUrl: url })
      pushMeshUrl(url)
      setOpenPanel(null)
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err))
    } finally {
      setSmoothing(false)
    }
  }

  async function handleDecimate(targetFaces: number) {
    if (!currentJob?.outputUrl) return
    setDecimating(true)
    try {
      const path = getOptimizePath(currentJob.outputUrl)
      const { url } = await optimizeMesh(path, targetFaces)
      updateCurrentJob({ outputUrl: url })
      pushMeshUrl(url)
      setOpenPanel(null)
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err))
    } finally {
      setDecimating(false)
    }
  }

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return
      setPanelWidth((w) => clampPanelWidth(w + ev.movementX))
    }
    const onMouseUp = () => {
      dragging.current = false
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }, [])

  const onLibraryPanelResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    libraryPanelDragging.current = true

    const onMouseMove = (ev: MouseEvent) => {
      if (!libraryPanelDragging.current) return
      setLibraryPanelWidth((w) => clampAssetLibraryPanelWidth(w + ev.movementX))
    }
    const onMouseUp = () => {
      libraryPanelDragging.current = false
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }, [])

  const onLibraryPanelResizeHeightMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    libraryPanelHeightDragging.current = true

    const onMouseMove = (ev: MouseEvent) => {
      if (!libraryPanelHeightDragging.current) return
      setLibraryPanelHeight((h) => clampAssetLibraryPanelHeight(h + ev.movementY))
    }
    const onMouseUp = () => {
      libraryPanelHeightDragging.current = false
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }, [])

  return (
    <>
      <div className="flex flex-col border-r border-zinc-800 bg-surface-400 overflow-hidden shrink-0" style={{ width: panelWidth }}>
        <WorkflowPanel />
      </div>

      {/* Resize handle — drag to widen/narrow the generate options panel; size is persisted. */}
      <div
        onMouseDown={onMouseDown}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the generate options panel"
        title="Drag to make this panel wider or narrower"
        className="w-2 shrink-0 cursor-col-resize bg-zinc-600/40 hover:bg-accent/60 active:bg-accent/70 transition-colors"
      />

      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header bar */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 bg-surface-400 shrink-0">

          {/* Free memory */}
          <button
            onClick={handleUnloadAll}
            disabled={isGenerating}
            title="Free model from memory"
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium border bg-zinc-800 border-zinc-700/50 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 transition-colors disabled:opacity-30 disabled:pointer-events-none"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
              <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
            </svg>
            {unloadStatus === 'done' ? 'Freed' : 'Free memory'}
          </button>

          <div className="w-px h-4 bg-zinc-700/60" />

          {/* Undo / Redo */}
          <button
            onClick={undoMesh}
            disabled={!canUndo}
            title="Undo (Ctrl+Z)"
            className="flex items-center justify-center w-7 h-7 rounded-lg text-[11px] font-medium bg-zinc-800 border border-zinc-700/50 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 transition-colors disabled:opacity-30 disabled:pointer-events-none"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
              <path d="M3 7v6h6" />
              <path d="M3 13a9 9 0 1 0 2.28-5.93" />
            </svg>
          </button>
          <button
            onClick={redoMesh}
            disabled={!canRedo}
            title="Redo (Ctrl+Y)"
            className="flex items-center justify-center w-7 h-7 rounded-lg text-[11px] font-medium bg-zinc-800 border border-zinc-700/50 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 transition-colors disabled:opacity-30 disabled:pointer-events-none"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
              <path d="M21 7v6h-6" />
              <path d="M21 13a9 9 0 1 1-2.28-5.93" />
            </svg>
          </button>

          <div className="w-px h-4 bg-zinc-700/60" />

          {/* Import */}
          <div className="relative">
            <button
              onClick={() => setOpenPanel((p) => (p === 'import' ? null : 'import'))}
              disabled={importing}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium border transition-colors disabled:opacity-50 disabled:pointer-events-none
                ${openPanel === 'import'
                  ? 'bg-zinc-700 border-zinc-600 text-zinc-200'
                  : 'bg-zinc-800 border-zinc-700/50 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'
                }`}
            >
              {importing ? (
                <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
              )}
              {importing ? 'Importing…' : 'Import'}
              {!importing && (
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              )}
            </button>
            {openPanel === 'import' && (
              <div className="absolute top-full left-0 mt-1 z-50 bg-zinc-900 border border-zinc-700/60 rounded-xl p-1 flex flex-col gap-0.5 min-w-[140px] shadow-xl">
                <button
                  onClick={handleImportMesh}
                  className="px-3 py-2 text-left hover:bg-zinc-800 rounded-lg transition-colors flex items-center gap-2.5"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="text-zinc-400">
                    <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
                  </svg>
                  <div>
                    <p className="text-xs text-zinc-200">Mesh</p>
                    <p className="text-[10px] text-zinc-500">.glb .obj .stl .ply .splat</p>
                  </div>
                </button>
              </div>
            )}
          </div>

          <div className="relative">
            <AssetLibraryToggleButton
              open={openPanel === 'library'}
              disabled={importing || libraryOpening}
              onToggle={() => {
                setLibraryError(null)
                setOpenPanel((panel) => (panel === 'library' ? null : 'library'))
              }}
            />
            {openPanel === 'library' && (
              <AssetLibraryPopover
                entries={libraryEntries}
                selectedEntryId={librarySelectedEntryId}
                loading={libraryLoading}
                opening={libraryOpening}
                error={libraryError}
                searchQuery={librarySearchQuery}
                sortMode={librarySortMode}
                collapsedSectionKeys={libraryCollapsedSectionKeys}
                thumbnails={libraryThumbnails}
                panelWidth={libraryPanelWidth}
                panelHeight={libraryPanelHeight}
                onSelectEntry={(entryId) => {
                  setLibraryError(null)
                  setLibrarySelectedEntryId(entryId)
                }}
                onSearchQueryChange={setLibrarySearchQuery}
                onSortModeChange={setLibrarySortMode}
                onToggleSection={(sectionKey) => setLibraryCollapsedSectionKeys((current) => toggleAssetLibrarySectionKey(current, sectionKey))}
                onOpenSelected={() => { void handleOpenSelectedLibraryEntry() }}
                onRefresh={() => { void loadLibraryEntries() }}
                onClose={() => setOpenPanel(null)}
                onResizeMouseDown={onLibraryPanelResizeMouseDown}
                onResizeHeightMouseDown={onLibraryPanelResizeHeightMouseDown}
              />
            )}
          </div>

          {hasModel && (
            <>
              <div className="w-px h-4 bg-zinc-700/60" />

              {/* Export */}
              <div className="relative">
                <button
                  onClick={() => setOpenPanel((p) => (p === 'export' ? null : 'export'))}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium border transition-colors
                    ${openPanel === 'export'
                      ? 'bg-zinc-700 border-zinc-600 text-zinc-200'
                      : 'bg-zinc-800 border-zinc-700/50 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'
                    }`}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 5 17 10" />
                    <line x1="12" y1="5" x2="12" y2="15" />
                  </svg>
                  Export
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
                {openPanel === 'export' && (
                  <ExportDropdown
                    onExport={handleExport as (f: 'glb' | 'obj' | 'stl' | 'ply') => void}
                    onClose={() => setOpenPanel(null)}
                  />
                )}
              </div>

              {/* Smooth */}
              <div className="relative">
                <button
                  onClick={() => setOpenPanel((p) => (p === 'smooth' ? null : 'smooth'))}
                  disabled={smoothing}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium border transition-colors disabled:opacity-50 disabled:pointer-events-none
                    ${openPanel === 'smooth' || smoothing
                      ? 'bg-zinc-700 border-zinc-600 text-zinc-200'
                      : 'bg-zinc-800 border-zinc-700/50 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'
                    }`}
                >
                  {smoothing ? (
                    <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                    </svg>
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  )}
                  {smoothing ? 'Processing…' : 'Smooth'}
                </button>
                {openPanel === 'smooth' && (
                  <SmoothPopover
                    smoothing={smoothing}
                    onSmooth={handleSmooth}
                    onClose={() => setOpenPanel(null)}
                  />
                )}
              </div>

              {/* Decimate */}
              <div className="relative">
                <button
                  onClick={() => setOpenPanel((p) => (p === 'decimate' ? null : 'decimate'))}
                  disabled={decimating}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium border transition-colors disabled:opacity-50 disabled:pointer-events-none
                    ${openPanel === 'decimate' || decimating
                      ? 'bg-zinc-700 border-zinc-600 text-zinc-200'
                      : 'bg-zinc-800 border-zinc-700/50 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'
                    }`}
                >
                  {decimating ? (
                    <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                    </svg>
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                      <polygon points="12 2 22 20 2 20" />
                      <line x1="12" y1="9" x2="8" y2="17" />
                      <line x1="12" y1="9" x2="16" y2="17" />
                      <line x1="8" y1="17" x2="16" y2="17" />
                    </svg>
                  )}
                  {decimating ? 'Processing…' : 'Decimate'}
                </button>
                {openPanel === 'decimate' && (
                  <DecimatePopover
                    currentTriangles={meshStats?.triangles ?? null}
                    decimating={decimating}
                    onDecimate={handleDecimate}
                    onClose={() => setOpenPanel(null)}
                  />
                )}
              </div>

            </>
          )}

          {/* Light — always visible, pushed to the right */}
          <div className="relative ml-auto">
            <button
              onClick={() => setOpenPanel((p) => (p === 'light' ? null : 'light'))}
              title="Lighting"
              className={`flex items-center justify-center w-7 h-7 rounded-lg border transition-colors
                ${openPanel === 'light'
                  ? 'bg-zinc-700 border-zinc-600 text-zinc-200'
                  : 'bg-zinc-800 border-zinc-700/50 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'
                }`}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                <circle cx="12" cy="12" r="4" />
                <line x1="12" y1="2" x2="12" y2="5" />
                <line x1="12" y1="19" x2="12" y2="22" />
                <line x1="4.22" y1="4.22" x2="6.34" y2="6.34" />
                <line x1="17.66" y1="17.66" x2="19.78" y2="19.78" />
                <line x1="2" y1="12" x2="5" y2="12" />
                <line x1="19" y1="12" x2="22" y2="12" />
                <line x1="4.22" y1="19.78" x2="6.34" y2="17.66" />
                <line x1="17.66" y1="6.34" x2="19.78" y2="4.22" />
              </svg>
            </button>
            {openPanel === 'light' && (
              <LightPopover
                settings={lightSettings}
                onChange={setLightSettings}
                onClose={() => setOpenPanel(null)}
              />
            )}
          </div>
        </div>

        {/* Tools bar — always visible; transform tools appear once a mesh is selected */}
        <div className="flex items-center gap-2 px-3 h-10 border-b border-zinc-800 bg-surface-400 shrink-0">
          {hasModel && meshSelected && (
            <>
              <ToolButton
                label="Move"
                active={gizmoMode === 'translate'}
                onClick={() => setGizmoMode((m) => (m === 'translate' ? null : 'translate'))}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                  <polyline points="5 9 2 12 5 15" />
                  <polyline points="9 5 12 2 15 5" />
                  <polyline points="15 19 12 22 9 19" />
                  <polyline points="19 9 22 12 19 15" />
                  <line x1="2" y1="12" x2="22" y2="12" />
                  <line x1="12" y1="2" x2="12" y2="22" />
                </svg>
              </ToolButton>
              <ToolButton
                label="Rotate"
                active={gizmoMode === 'rotate'}
                onClick={() => setGizmoMode((m) => (m === 'rotate' ? null : 'rotate'))}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                  <path d="M21 2v6h-6" />
                  <path d="M21 13a9 9 0 1 1-3-7.7L21 8" />
                </svg>
              </ToolButton>
              <ToolButton
                label="Scale"
                active={gizmoMode === 'scale'}
                onClick={() => setGizmoMode((m) => (m === 'scale' ? null : 'scale'))}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                  <path d="M15 3h6v6" />
                  <path d="M9 21H3v-6" />
                  <path d="M21 3l-7 7" />
                  <path d="M3 21l7-7" />
                </svg>
              </ToolButton>
            </>
          )}
        </div>

        {/* Viewer area */}
        <div className="flex-1 relative overflow-hidden">
          <Viewer3D lightSettings={lightSettings} gizmoMode={gizmoMode} gizmoUndoRef={gizmoUndoRef} />
          <GenerationHUD />
        </div>
      </div>
    </>
  )
}
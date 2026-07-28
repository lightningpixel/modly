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
import type { AssetLibraryPreviewClip } from '../../shared/types/assetLibrary'
import {
  ASSET_LIBRARY_KIND_FILTERS,
  ASSET_LIBRARY_POLY_FILTERS,
  ASSET_LIBRARY_SORT_OPTIONS,
  buildAssetLibraryProjectGroups,
  buildAssetLibraryOpenRequest,
  clampAssetLibraryPanelHeight,
  clampAssetLibraryPanelWidth,
  createDefaultAssetLibraryFilters,
  createAssetLibraryOpenJob,
  describeAssetLibraryOpenability,
  formatAssetLibraryClipName,
  getDefaultAssetLibraryCollapsedSectionKeys,
  getStoredAssetLibraryPanelHeight,
  getStoredAssetLibraryPanelWidth,
  isAssetLibraryEntryOpenable,
  isAssetLibrarySectionExpanded,
  resolveOpenPanelAfterLibrarySelection,
  storeAssetLibraryPanelHeight,
  storeAssetLibraryPanelWidth,
  toggleAssetLibrarySectionKey,
  type AssetLibraryFilters,
  type AssetLibraryLineageFamily,
  type AssetLibrarySortMode,
  type AssetLibraryViewMode,
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

// A stable empty-array reference for entries with no preview manifest yet, so
// rows don't see a fresh `[]` identity on every parent re-render.
const EMPTY_PREVIEW_CLIPS: AssetLibraryPreviewClip[] = []

function AssetLibraryPopover({
  entries,
  selectedEntryId,
  loading,
  opening,
  error,
  searchQuery,
  sortMode,
  viewMode,
  filters,
  collapsedSectionKeys,
  thumbnails,
  previews,
  panelWidth,
  panelHeight,
  onActivateEntry,
  onSearchQueryChange,
  onSortModeChange,
  onViewModeChange,
  onFiltersChange,
  onToggleSection,
  onFetchPreviewFrame,
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
  viewMode: AssetLibraryViewMode
  filters: AssetLibraryFilters
  collapsedSectionKeys: string[]
  /** Data URLs keyed by workspacePath, populated lazily as thumbnails load. */
  thumbnails: Record<string, string>
  /** Preview clip metadata keyed by workspacePath; empty until a preview manifest exists for that asset. */
  previews: Record<string, AssetLibraryPreviewClip[]>
  panelWidth: number
  panelHeight: number
  /** A row click both selects and, when the entry is openable, opens it immediately — no second confirming click. */
  onActivateEntry: (entryId: string) => void
  onSearchQueryChange: (value: string) => void
  onSortModeChange: (value: AssetLibrarySortMode) => void
  onViewModeChange: (value: AssetLibraryViewMode) => void
  onFiltersChange: (value: AssetLibraryFilters) => void
  onToggleSection: (sectionKey: string) => void
  onFetchPreviewFrame: (workspacePath: string, clip: string) => Promise<string | null>
  onRefresh: () => void
  onClose: () => void
  onResizeMouseDown: (event: React.MouseEvent) => void
  onResizeHeightMouseDown: (event: React.MouseEvent) => void
}) {
  const projectGroups = buildAssetLibraryProjectGroups(entries, searchQuery, sortMode, filters)
  const normalizedSearchQuery = searchQuery.trim()
  const hasActiveFilters = filters.kind !== 'all' || filters.poly !== 'all' || filters.needsAttention
  const hasActiveDiscovery = normalizedSearchQuery.length > 0 || hasActiveFilters
  const familyCount = projectGroups.reduce((count, group) => count + group.families.length, 0)
  const versionCount = projectGroups.reduce((count, group) => count + group.entryCount, 0)

  return (
    <div
      role="dialog"
      aria-label="Workspace library"
      style={{ width: panelWidth, height: panelHeight }}
      className="absolute top-full left-0 mt-1 z-50 max-w-[calc(100vw-2rem)] max-h-[calc(100vh-4rem)] bg-zinc-900 border border-zinc-700/60 rounded-xl p-3 flex flex-col gap-3 shadow-xl overflow-hidden"
    >
      <div className="flex items-center justify-between gap-2 shrink-0">
        <div>
          <p className="text-[10px] text-zinc-500 uppercase tracking-wider">Asset Library</p>
          <p className="text-xs text-zinc-300">Browse models by project, traits, and version family.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading || opening}
            className="px-2 py-1 text-[11px] text-zinc-400 hover:text-zinc-200 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 rounded-lg transition-colors"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-2 py-1 text-[11px] text-zinc-400 hover:text-zinc-200 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors"
          >
            Close
          </button>
        </div>
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

      <div className="flex items-end gap-2 shrink-0">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <label htmlFor="asset-library-search" className="text-[11px] text-zinc-300">Search assets</label>
          <input
            id="asset-library-search"
            type="search"
            value={searchQuery}
            onChange={(event) => onSearchQueryChange(event.target.value)}
            placeholder="Search names, projects, tags, clips, or locations"
            className="appearance-none bg-zinc-800 border border-zinc-700 rounded-lg px-2.5 py-1.5 text-xs text-zinc-200 w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
          />
        </div>
        <div className="flex w-36 shrink-0 flex-col gap-1.5">
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
        <div className="flex shrink-0 rounded-lg border border-zinc-700 bg-zinc-800 p-0.5" aria-label="Library view">
          {(['gallery', 'list'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={viewMode === mode}
              onClick={() => onViewModeChange(mode)}
              className={`rounded-md px-2.5 py-1.5 text-[11px] capitalize transition-colors ${
                viewMode === mode ? 'bg-violet-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      <div className="shrink-0 space-y-2 rounded-lg border border-zinc-800 bg-zinc-950/40 p-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[10px] font-medium uppercase tracking-wider text-zinc-500">What it is</span>
          {ASSET_LIBRARY_KIND_FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={filters.kind === option.value}
              onClick={() => onFiltersChange({ ...filters, kind: option.value })}
              className={`rounded-full border px-2.5 py-1 text-[10px] transition-colors ${
                filters.kind === option.value
                  ? 'border-violet-400/70 bg-violet-500/20 text-violet-100'
                  : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[10px] font-medium uppercase tracking-wider text-zinc-500">File weight</span>
          {ASSET_LIBRARY_POLY_FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={filters.poly === option.value}
              onClick={() => onFiltersChange({ ...filters, poly: option.value })}
              className={`rounded-full border px-2.5 py-1 text-[10px] transition-colors ${
                filters.poly === option.value
                  ? 'border-sky-400/70 bg-sky-500/15 text-sky-100'
                  : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {option.label}
            </button>
          ))}
          <button
            type="button"
            aria-pressed={filters.needsAttention}
            onClick={() => onFiltersChange({ ...filters, needsAttention: !filters.needsAttention })}
            className={`ml-auto rounded-full border px-2.5 py-1 text-[10px] transition-colors ${
              filters.needsAttention
                ? 'border-amber-400/70 bg-amber-500/15 text-amber-100'
                : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Needs a name
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="shrink-0 rounded-lg border border-amber-800/50 bg-amber-950/40 px-3 py-2 text-[11px] text-amber-300">
          {error}
        </p>
      )}

      {loading ? (
        <p role="status" className="flex-1 min-h-0 flex items-center justify-center text-xs text-zinc-400">Loading workspace assets…</p>
      ) : projectGroups.length === 0 && !hasActiveDiscovery ? (
        <p role="status" className="flex-1 min-h-0 flex items-center justify-center text-xs text-zinc-500">No workspace assets are indexed yet.</p>
      ) : projectGroups.length === 0 ? (
        <p role="status" className="flex-1 min-h-0 flex items-center justify-center text-center text-xs text-zinc-500">
          No assets match these search and filter choices.
        </p>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden rounded-lg border border-zinc-800 bg-zinc-950/40">
          <div className="sticky top-0 z-10 flex items-center justify-between border-b border-zinc-800 bg-zinc-950/95 px-3 py-2 backdrop-blur">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500">Grouped by project</span>
            <span className="text-[10px] text-zinc-500">{familyCount} families · {versionCount} versions</span>
          </div>
          {projectGroups.map((projectGroup) => {
            const projectExpanded = isAssetLibrarySectionExpanded(collapsedSectionKeys, projectGroup.sectionKey, hasActiveDiscovery)
            const projectRegionId = `asset-library-${projectGroup.sectionKey.replace(/[^a-z0-9-]+/gi, '-')}`
            return (
              <section key={projectGroup.sectionKey} role="group" aria-label={`Project ${projectGroup.projectLabel}`} className="border-b border-zinc-800 last:border-b-0">
                <button
                  type="button"
                  aria-expanded={projectExpanded}
                  aria-controls={projectRegionId}
                  onClick={() => onToggleSection(projectGroup.sectionKey)}
                  disabled={hasActiveDiscovery}
                  className="flex w-full items-center justify-between gap-3 bg-zinc-900/80 px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 disabled:pointer-events-none"
                >
                  <span className="flex items-center gap-2">
                    <span className={`text-xs font-semibold ${projectGroup.projectKey === 'needs-project' ? 'text-amber-200' : 'text-zinc-200'}`}>
                      {projectGroup.projectLabel}
                    </span>
                    {projectGroup.projectKey === 'needs-project' && (
                      <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[9px] text-amber-200">Add project metadata</span>
                    )}
                  </span>
                  <span className="text-[10px] text-zinc-500">
                    {projectGroup.families.length} {projectGroup.families.length === 1 ? 'family' : 'families'} · {projectGroup.entryCount} versions · {projectExpanded ? 'Hide' : 'Show'}
                  </span>
                </button>
                {projectExpanded && (
                  <div
                    id={projectRegionId}
                    role="list"
                    aria-label={`${projectGroup.projectLabel} asset families`}
                    className={viewMode === 'gallery'
                      ? 'grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3 p-3'
                      : 'divide-y divide-zinc-800'
                    }
                  >
                    {projectGroup.families.map((family) => (
                      <AssetLibraryFamilyCard
                        key={family.key}
                        family={family}
                        viewMode={viewMode}
                        selectedEntryId={selectedEntryId}
                        disabled={opening}
                        thumbnails={thumbnails}
                        previews={previews}
                        onActivateEntry={onActivateEntry}
                        onFetchPreviewFrame={onFetchPreviewFrame}
                      />
                    ))}
                  </div>
                )}
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * One semantic asset family. Gallery cards load their active motion clip
 * immediately so animation is visible without a precision hover. List rows
 * retain the compact scanner from v2 and lazy-load animation on hover.
 */
function AssetLibraryFamilyCard({
  family,
  viewMode,
  selectedEntryId,
  disabled,
  thumbnails,
  previews,
  onActivateEntry,
  onFetchPreviewFrame,
}: {
  family: AssetLibraryLineageFamily
  viewMode: AssetLibraryViewMode
  selectedEntryId: string | null
  disabled: boolean
  thumbnails: Record<string, string>
  previews: Record<string, AssetLibraryPreviewClip[]>
  onActivateEntry: (entryId: string) => void
  onFetchPreviewFrame: (workspacePath: string, clip: string) => Promise<string | null>
}) {
  const entry = family.primaryEntry
  const thumbnailDataUrl = thumbnails[entry.workspacePath]
  const previewClips = previews[entry.workspacePath] ?? EMPTY_PREVIEW_CLIPS
  const selected = family.entries.some((candidate) => candidate.id === selectedEntryId)
  const [hovered, setHovered] = useState(false)
  const [clipIndex, setClipIndex] = useState(0)
  const [previewFrames, setPreviewFrames] = useState<Record<string, string>>({})
  const [versionsExpanded, setVersionsExpanded] = useState(false)
  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])

  const activeClip = previewClips.length > 0 ? previewClips[clipIndex % previewClips.length] : undefined
  const activeFrameUrl = activeClip ? previewFrames[activeClip.clip] : undefined

  // Gallery motion is the feature, so it begins without requiring a hover.
  // Compact list rows stay lazy. Every fetched clip is cached per family.
  useEffect(() => {
    if ((viewMode !== 'gallery' && !hovered) || !activeClip || previewFrames[activeClip.clip]) return
    void onFetchPreviewFrame(entry.workspacePath, activeClip.clip).then((dataUrl) => {
      if (mountedRef.current && dataUrl) {
        setPreviewFrames((current) => ({ ...current, [activeClip.clip]: dataUrl }))
      }
    })
  }, [viewMode, hovered, activeClip, entry.workspacePath, previewFrames, onFetchPreviewFrame])

  function cycleClip(step: 1 | -1, event: React.MouseEvent | React.KeyboardEvent) {
    event.preventDefault()
    event.stopPropagation()
    setClipIndex((current) => (current + step + previewClips.length) % previewClips.length)
  }

  function handleCycleKeyDown(step: 1 | -1, event: React.KeyboardEvent) {
    if (event.key !== 'Enter' && event.key !== ' ') return
    cycleClip(step, event)
  }

  function activateEntry(entryId: string, event?: React.SyntheticEvent) {
    event?.preventDefault()
    event?.stopPropagation()
    if (!disabled) onActivateEntry(entryId)
  }

  function handleCardKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
    activateEntry(entry.id, event)
  }

  const displayedThumbnailUrl = activeFrameUrl ?? thumbnailDataUrl
  const tags = new Set(entry.semantic?.tags ?? [])
  const badges = [
    tags.has('animated') ? 'Animated' : null,
    tags.has('rigged') || entry.capability === 'rigged-mesh' ? 'Rigged' : null,
    tags.has('character') || tags.has('creature') ? 'Character' : null,
    tags.has('prop') ? 'Prop' : null,
    tags.has('low-poly') ? 'Light' : tags.has('mid-poly') ? 'Medium' : tags.has('high-poly') ? 'Heavy' : null,
    tags.has('unnamed') || !entry.semantic?.name ? 'Needs name' : null,
  ].filter((badge): badge is string => Boolean(badge))
  const dateLabel = formatAssetLibraryDate(entry.createdAt)

  const clipControls = activeClip && (
    <div className={`flex items-center gap-2 ${viewMode === 'gallery'
      ? 'border-t border-zinc-700/70 bg-zinc-950 px-2 py-2'
      : 'mt-1'
    }`}>
      {previewClips.length > 1 && (
        <button
          type="button"
          aria-label={`Show previous animation for ${family.name}`}
          onClick={(event) => cycleClip(-1, event)}
          onKeyDown={(event) => handleCycleKeyDown(-1, event)}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-zinc-800 text-sm text-zinc-200 hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-violet-400"
        >
          ‹
        </button>
      )}
      <span className="min-w-0 flex-1 truncate text-center text-[10px] font-medium text-violet-200">
        {viewMode === 'gallery' ? 'Animation: ' : ''}{formatAssetLibraryClipName(activeClip.clip)}
      </span>
      <span className="shrink-0 text-[9px] text-zinc-500">{clipIndex + 1}/{previewClips.length}</span>
      {previewClips.length > 1 && (
        <button
          type="button"
          aria-label={`Show next animation for ${family.name}`}
          onClick={(event) => cycleClip(1, event)}
          onKeyDown={(event) => handleCycleKeyDown(1, event)}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-zinc-800 text-sm text-zinc-200 hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-violet-400"
        >
          ›
        </button>
      )}
    </div>
  )

  if (viewMode === 'list') {
    return (
      <article
        role="listitem"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        aria-label={`Open asset family ${family.name}`}
        onClick={() => activateEntry(entry.id)}
        onKeyDown={handleCardKeyDown}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className={`cursor-pointer px-3 py-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-400 ${
          selected ? 'bg-violet-500/10' : 'hover:bg-zinc-800/70'
        } ${disabled ? 'pointer-events-none opacity-50' : ''}`}
      >
        <div className="flex items-center gap-3">
          <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-950">
            {displayedThumbnailUrl ? (
              <img src={displayedThumbnailUrl} alt="" className="h-full w-full object-contain" />
            ) : (
              <AssetLibraryPreviewPlaceholder />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-xs font-medium text-zinc-200">{family.name}</span>
              {family.entries.length > 1 && (
                <span className="shrink-0 rounded-full bg-violet-500/15 px-2 py-0.5 text-[9px] text-violet-200">{family.entries.length} versions</span>
              )}
            </div>
            <div className="mt-1 flex flex-wrap gap-1">
              {badges.slice(0, 4).map((badge) => (
                <span key={badge} className={`rounded-full px-1.5 py-0.5 text-[8px] ${
                  badge === 'Needs name' ? 'bg-amber-500/15 text-amber-200' : 'bg-zinc-800 text-zinc-400'
                }`}>{badge}</span>
              ))}
            </div>
            <p className="mt-1 truncate text-[9px] text-zinc-500" title={entry.workspacePath}>{entry.workspacePath}</p>
          </div>
          <div className="w-40 shrink-0">{clipControls}</div>
          <span className="w-16 shrink-0 text-right text-[9px] text-zinc-500">{dateLabel}</span>
          {family.entries.length > 1 && (
            <button
              type="button"
              aria-expanded={versionsExpanded}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                setVersionsExpanded((current) => !current)
              }}
              className="shrink-0 rounded-md bg-zinc-800 px-2 py-1 text-[9px] text-zinc-300 hover:bg-zinc-700"
            >
              {versionsExpanded ? 'Hide versions' : 'Show versions'}
            </button>
          )}
        </div>
        {versionsExpanded && <AssetLibraryVersionRows family={family} selectedEntryId={selectedEntryId} onActivateEntry={activateEntry} />}
      </article>
    )
  }

  return (
    <article
      role="listitem"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      aria-label={`Open asset family ${family.name}`}
      onClick={() => activateEntry(entry.id)}
      onKeyDown={handleCardKeyDown}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`min-w-0 cursor-pointer overflow-hidden rounded-xl border bg-zinc-900 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 ${
        selected ? 'border-violet-400/70 bg-violet-500/10' : 'border-zinc-700/80 hover:border-zinc-600'
      } ${disabled ? 'pointer-events-none opacity-50' : ''}`}
    >
      <div className="relative h-40 w-full overflow-hidden bg-zinc-950">
        {displayedThumbnailUrl ? (
          <img
            src={displayedThumbnailUrl}
            alt=""
            className="h-full w-full object-contain"
          />
        ) : (
          <AssetLibraryPreviewPlaceholder />
        )}
        {activeFrameUrl && (
          <span className="absolute left-2 top-2 rounded-full border border-violet-300/30 bg-violet-950/80 px-2 py-1 text-[9px] font-medium text-violet-100">
            Playing
          </span>
        )}
        {family.entries.length > 1 && (
          <span className="absolute right-2 top-2 rounded-full border border-zinc-600 bg-black/75 px-2 py-1 text-[9px] font-medium text-zinc-100">
            {family.entries.length} versions
          </span>
        )}
      </div>
      {clipControls}
      <div className="p-3">
        <div className="flex items-start justify-between gap-2">
          <h3 className="min-w-0 truncate text-xs font-semibold text-zinc-100">{family.name}</h3>
          <span className="shrink-0 text-[9px] text-zinc-500">{dateLabel}</span>
        </div>
        <div className="mt-2 flex min-h-5 flex-wrap gap-1">
          {badges.slice(0, 4).map((badge) => (
            <span key={badge} className={`rounded-full px-2 py-0.5 text-[9px] ${
              badge === 'Needs name' ? 'bg-amber-500/15 text-amber-200' : 'bg-zinc-800 text-zinc-300'
            }`}>{badge}</span>
          ))}
        </div>
        <p className="mt-2 truncate border-t border-zinc-800 pt-2 text-[9px] text-zinc-500" title={entry.workspacePath}>
          Stored at {entry.workspacePath}
        </p>
        {family.entries.length > 1 && (
          <button
            type="button"
            aria-expanded={versionsExpanded}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              setVersionsExpanded((current) => !current)
            }}
            className="mt-2 w-full rounded-lg border border-violet-400/20 bg-violet-500/10 px-2 py-1.5 text-[10px] font-medium text-violet-200 hover:bg-violet-500/20"
          >
            {versionsExpanded ? 'Hide version family' : `Show all ${family.entries.length} versions`}
          </button>
        )}
      </div>
      {versionsExpanded && <AssetLibraryVersionRows family={family} selectedEntryId={selectedEntryId} onActivateEntry={activateEntry} />}
    </article>
  )
}

function AssetLibraryVersionRows({
  family,
  selectedEntryId,
  onActivateEntry,
}: {
  family: AssetLibraryLineageFamily
  selectedEntryId: string | null
  onActivateEntry: (entryId: string, event?: React.SyntheticEvent) => void
}) {
  return (
    <div className="border-t border-zinc-700 bg-zinc-950/70 p-2">
      <p className="px-1 pb-1.5 text-[9px] font-medium uppercase tracking-wider text-zinc-500">Version family</p>
      <div className="space-y-1">
        {family.entries.map((entry, index) => (
          <button
            key={entry.id}
            type="button"
            onClick={(event) => onActivateEntry(entry.id, event)}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-zinc-800 ${
              entry.id === selectedEntryId ? 'bg-violet-500/15' : ''
            }`}
          >
            <span className="w-11 shrink-0 text-[9px] font-medium text-zinc-300">{index === 0 ? 'Latest' : `Older ${index}`}</span>
            <span className="min-w-0 flex-1 truncate text-[9px] text-zinc-400" title={entry.workspacePath}>{entry.workspacePath}</span>
            <span className="shrink-0 text-[8px] text-zinc-600">{formatAssetLibraryDate(entry.createdAt)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function AssetLibraryPreviewPlaceholder() {
  return (
    <div className="flex h-full w-full items-center justify-center text-zinc-700" aria-hidden="true">
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2">
        <path d="m12 2 8 4.5v9L12 20l-8-4.5v-9L12 2Z" />
        <path d="m4 6.5 8 4.5 8-4.5M12 11v9" />
      </svg>
    </div>
  )
}

function formatAssetLibraryDate(value: string | undefined): string {
  if (!value) return 'Unknown date'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return 'Unknown date'
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
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
  const [librarySortMode, setLibrarySortMode] = useState<AssetLibrarySortMode>('date')
  const [libraryViewMode, setLibraryViewMode] = useState<AssetLibraryViewMode>('gallery')
  const [libraryFilters, setLibraryFilters] = useState<AssetLibraryFilters>(() => createDefaultAssetLibraryFilters())
  const [libraryCollapsedSectionKeys, setLibraryCollapsedSectionKeys] = useState<string[]>(() => getDefaultAssetLibraryCollapsedSectionKeys())
  const [libraryThumbnails, setLibraryThumbnails] = useState<Record<string, string>>({})
  const [libraryPreviews, setLibraryPreviews] = useState<Record<string, AssetLibraryPreviewClip[]>>({})
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
      const defaultPrimaryEntry = buildAssetLibraryProjectGroups(
        result.entries,
        '',
        'date',
        createDefaultAssetLibraryFilters(),
      )
        .flatMap((group) => group.families.map((family) => family.primaryEntry))
        .find(isAssetLibraryEntryOpenable)
      setLibraryEntries(result.entries)
      setLibrarySelectedEntryId((current) => current && result.entries.some((entry) => entry.id === current)
        ? current
        : defaultPrimaryEntry?.id ?? result.entries.find(isAssetLibraryEntryOpenable)?.id ?? result.entries[0]?.id ?? null)
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
  // The same request also carries preview clip metadata when a preview
  // manifest exists for that asset — most entries won't have one yet, and
  // those are simply absent from libraryPreviews.
  async function loadLibraryThumbnails(entries: ProjectedAssetLibraryEntry[]) {
    type ThumbnailFetchResult = { workspacePath: string, dataUrl: string | null, previews: AssetLibraryPreviewClip[] }
    const candidates = entries.filter((entry) => entry.previewKind === '3d-model')
    const results: ThumbnailFetchResult[] = await Promise.all(candidates.map(async (entry) => {
      const result = await assetLibraryService.thumbnail({ workspacePath: entry.workspacePath })
      return {
        workspacePath: entry.workspacePath,
        dataUrl: result.success ? result.dataUrl : null,
        previews: result.success ? result.previews ?? [] : [],
      }
    }))
    setLibraryThumbnails(Object.fromEntries(
      results
        .filter((result): result is ThumbnailFetchResult & { dataUrl: string } => result.dataUrl !== null)
        .map((result) => [result.workspacePath, result.dataUrl]),
    ))
    setLibraryPreviews(Object.fromEntries(
      results.filter((result) => result.previews.length > 0).map((result) => [result.workspacePath, result.previews]),
    ))
  }

  // Fetches one looping preview clip's WebP, lazily, over the same thumbnail
  // IPC call the static thumbnails use. A miss (clip removed, file unreadable)
  // resolves to null rather than throwing, so a row can just keep its static
  // thumbnail.
  const fetchLibraryPreviewFrame = useCallback(async (workspacePath: string, clip: string): Promise<string | null> => {
    try {
      const result = await assetLibraryService.thumbnail({ workspacePath, previewClip: clip })
      return result.success ? result.dataUrl : null
    } catch {
      return null
    }
  }, [assetLibraryService])

  // A Library row opens through this shared validation and import path.
  async function openLibraryEntry(entry: ProjectedAssetLibraryEntry | null) {
    if (!entry) {
      setLibraryError('Select an asset before opening it in Generate.')
      return
    }
    if (!isAssetLibraryEntryOpenable(entry)) {
      setLibraryError(describeAssetLibraryOpenability(entry))
      return
    }

    setLibraryOpening(true)
    setLibraryError(null)
    try {
      const result = await assetLibraryService.open(buildAssetLibraryOpenRequest(entry))
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
      setLibraryEntries((currentEntries) => currentEntries.map((candidate) => candidate.id === result.entry.id ? result.entry : candidate))
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

  // A single click on a row both selects and opens it. Non-openable entries
  // stay selected and surface their reason in the conditional message above.
  async function handleActivateLibraryEntry(entryId: string) {
    setLibraryError(null)
    setLibrarySelectedEntryId(entryId)
    const entry = libraryEntries.find((candidate) => candidate.id === entryId) ?? null
    await openLibraryEntry(entry)
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
                viewMode={libraryViewMode}
                filters={libraryFilters}
                collapsedSectionKeys={libraryCollapsedSectionKeys}
                thumbnails={libraryThumbnails}
                previews={libraryPreviews}
                panelWidth={libraryPanelWidth}
                panelHeight={libraryPanelHeight}
                onActivateEntry={(entryId) => { void handleActivateLibraryEntry(entryId) }}
                onSearchQueryChange={setLibrarySearchQuery}
                onSortModeChange={setLibrarySortMode}
                onViewModeChange={setLibraryViewMode}
                onFiltersChange={setLibraryFilters}
                onToggleSection={(sectionKey) => setLibraryCollapsedSectionKeys((current) => toggleAssetLibrarySectionKey(current, sectionKey))}
                onFetchPreviewFrame={fetchLibraryPreviewFrame}
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

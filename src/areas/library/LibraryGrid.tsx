import { createElement, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from 'react'
import type { IconShape } from '@shared/pages/pageRegistry'
import type { AssetCapability } from '@shared/types/assetLibrary'
import { useAssetThumbnailUrl } from '@shared/thumbnails/assetThumbnailStore'
import type { ProjectedAssetLibraryEntry } from '@areas/generate/assetLibraryProjection'
import { describeAssetLibraryOpenability, isAssetLibraryEntryOpenable } from '@areas/generate/assetLibraryUi'
import { computeGridLayout, moveGridIndex, scrollTopToReveal, visibleRowRange, type GridLayout } from './gridWindow'
import { capabilityLabel, type LibraryViewMode } from './libraryView'

// Side padding of the scroll area (matches the page's px-7).
const PADDING_X = 28
const PADDING_Y = 4
const GRID = { gap: 16, minColumnWidth: 164, labelHeight: 46 }
const LIST = { gap: 2, rowHeight: 56 }
const OVERSCAN_ROWS = 3

const CAPABILITY_ICONS: Record<AssetCapability | 'unknown', readonly IconShape[]> = {
  mesh: [
    ['path', { d: 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z' }],
    ['polyline', { points: '3.27 6.96 12 12.01 20.73 6.96' }],
    ['line', { x1: 12, y1: 22.08, x2: 12, y2: 12 }],
  ],
  'rigged-mesh': [
    ['circle', { cx: 12, cy: 4.5, r: 2 }],
    ['path', { d: 'M12 6.5v7M12 13.5l-4 7M12 13.5l4 7M5.5 10h13' }],
  ],
  'animation-motion': [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['path', { d: 'M10 8.5v7l6-3.5-6-3.5z' }],
  ],
  'landmarks-sidecar': [
    ['path', { d: 'M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z' }],
    ['circle', { cx: 12, cy: 9.5, r: 2.5 }],
  ],
  'generated-world': [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['path', { d: 'M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18' }],
  ],
  'scene-manifest': [
    ['path', { d: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z' }],
    ['polyline', { points: '14 3 14 9 20 9' }],
    ['line', { x1: 8, y1: 13, x2: 16, y2: 13 }],
    ['line', { x1: 8, y1: 17, x2: 13, y2: 17 }],
  ],
  unknown: [['rect', { x: 4, y: 4, width: 16, height: 16, rx: 2 }]],
}

export function CapabilityIcon({ capability, size = 18, className }: { capability?: AssetCapability, size?: number, className?: string }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      {CAPABILITY_ICONS[capability ?? 'unknown'].map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }))}
    </svg>
  )
}

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

export function formatEntryDate(entry: ProjectedAssetLibraryEntry): string | null {
  const value = entry.createdAt ?? entry.updatedAt
  const time = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(time) ? DATE_FORMAT.format(time) : null
}

/** The asset's thumbnail, or its capability icon until one is rendered (or if it fails to load). */
function Thumbnail({ entry, iconSize }: { entry: ProjectedAssetLibraryEntry, iconSize: number }): JSX.Element {
  const url = useAssetThumbnailUrl(entry)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  if (url && url !== failedUrl) {
    return (
      <img
        src={url}
        alt=""
        draggable={false}
        decoding="async"
        onError={() => setFailedUrl(url)}
        className="h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.04]"
      />
    )
  }
  return (
    <div className="flex h-full w-full items-center justify-center bg-gradient-to-b from-zinc-800/40 to-zinc-900/40 text-zinc-600">
      <CapabilityIcon capability={entry.capability} size={iconSize} />
    </div>
  )
}

function LockBadge(): JSX.Element {
  return (
    <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-md bg-zinc-950/80 text-zinc-400 ring-1 ring-zinc-700/60">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
        <rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </svg>
    </span>
  )
}

function Spinner(): JSX.Element {
  return <span className="h-5 w-5 animate-spin rounded-full border-2 border-white/25 border-t-white" aria-hidden="true" />
}

interface TileProps {
  entry: ProjectedAssetLibraryEntry
  selected: boolean
  opening: boolean
  tabStop: boolean
  style: CSSProperties
  onSelect: () => void
  onOpen: () => void
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
}

function tileA11y({ entry, selected, tabStop, onSelect, onOpen, onKeyDown }: TileProps, openable: boolean) {
  return {
    'data-entry-id': entry.id,
    role: 'option',
    'aria-selected': selected,
    'aria-disabled': !openable,
    'aria-label': entry.displayName,
    tabIndex: tabStop ? 0 : -1,
    title: openable ? `${entry.workspacePath}\nDouble-click to open in Generate` : `${entry.workspacePath}\n${describeAssetLibraryOpenability(entry)}`,
    onClick: onSelect,
    onDoubleClick: onOpen,
    onKeyDown,
  } as const
}

function GridTile(props: TileProps): JSX.Element {
  const { entry, selected, opening, style } = props
  const openable = isAssetLibraryEntryOpenable(entry)
  const date = formatEntryDate(entry)
  return (
    <div {...tileA11y(props, openable)} style={style} className="group absolute left-0 top-0 flex cursor-default select-none flex-col outline-none">
      <div
        className={`relative aspect-square w-full overflow-hidden rounded-xl border bg-zinc-900 transition-[border-color,box-shadow] duration-150
          ${selected
            ? 'border-accent shadow-[0_0_0_3px_rgba(124,58,237,0.25)]'
            : 'border-zinc-800 group-hover:border-zinc-600 group-focus-visible:border-accent-light'}
          ${openable ? '' : 'opacity-45 grayscale'}`}
      >
        <Thumbnail entry={entry} iconSize={34} />
        {!openable && <LockBadge />}
        {opening && <div className="absolute inset-0 flex items-center justify-center bg-zinc-950/60"><Spinner /></div>}
      </div>
      <div className="mt-2 min-w-0 px-0.5">
        <p className={`truncate text-[12.5px] font-medium leading-[18px] ${selected ? 'text-zinc-50' : openable ? 'text-zinc-200' : 'text-zinc-500'}`}>
          {entry.displayName}
        </p>
        <p className="truncate text-[11px] leading-4 text-zinc-500">
          {capabilityLabel(entry.capability)}{date ? ` · ${date}` : ''}
        </p>
      </div>
    </div>
  )
}

function ListRow(props: TileProps): JSX.Element {
  const { entry, selected, opening, style } = props
  const openable = isAssetLibraryEntryOpenable(entry)
  const date = formatEntryDate(entry)
  return (
    <div
      {...tileA11y(props, openable)}
      style={style}
      className={`group absolute left-0 top-0 flex cursor-default select-none items-center gap-3 rounded-lg px-2.5 outline-none transition-colors
        ${selected ? 'bg-accent/15 ring-1 ring-inset ring-accent/40' : 'hover:bg-zinc-800/50 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent-light'}`}
    >
      <div className={`relative h-10 w-10 shrink-0 overflow-hidden rounded-md border border-zinc-800 bg-zinc-900 ${openable ? '' : 'opacity-45 grayscale'}`}>
        <Thumbnail entry={entry} iconSize={18} />
        {opening && <div className="absolute inset-0 flex items-center justify-center bg-zinc-950/60"><Spinner /></div>}
      </div>
      <div className="min-w-0 flex-1">
        <p className={`truncate text-[12.5px] font-medium ${openable ? 'text-zinc-200' : 'text-zinc-500'}`}>{entry.displayName}</p>
        <p className="truncate text-[11px] text-zinc-500">{openable ? entry.workspacePath : describeAssetLibraryOpenability(entry)}</p>
      </div>
      <span className="hidden w-32 shrink-0 truncate text-[11px] text-zinc-500 md:block">{capabilityLabel(entry.capability)}</span>
      <span className="hidden w-20 shrink-0 text-[11px] capitalize text-zinc-500 lg:block">{entry.sourceScope}</span>
      <span className="w-24 shrink-0 text-right text-[11px] tabular-nums text-zinc-500">{date ?? '—'}</span>
    </div>
  )
}

function useElementSize(ref: RefObject<HTMLElement>): { width: number, height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const update = () => setSize((current) => (
      current.width === element.clientWidth && current.height === element.clientHeight
        ? current
        : { width: element.clientWidth, height: element.clientHeight }
    ))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return size
}

function layoutFor(view: LibraryViewMode, width: number, itemCount: number): GridLayout {
  return view === 'grid'
    ? computeGridLayout({ width, itemCount, ...GRID })
    : computeGridLayout({ width, itemCount, gap: LIST.gap, minColumnWidth: Number.MAX_SAFE_INTEGER, rowHeight: LIST.rowHeight })
}

export interface LibraryGridProps {
  entries: ProjectedAssetLibraryEntry[]
  view: LibraryViewMode
  selectedId: string | null
  openingId: string | null
  onSelect: (entryId: string) => void
  onOpen: (entry: ProjectedAssetLibraryEntry) => void
}

/**
 * Windowed grid/list: the scroll area has the full height of every row, but
 * only the rows in (or just around) the viewport are mounted.
 */
export default function LibraryGrid({ entries, view, selectedId, openingId, onSelect, onOpen }: LibraryGridProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const { width, height } = useElementSize(scrollRef)
  const [scrollTop, setScrollTop] = useState(0)
  const focusAfterRender = useRef<string | null>(null)

  const layout = layoutFor(view, Math.max(0, width - PADDING_X * 2), entries.length)
  const range = visibleRowRange(layout, scrollTop - PADDING_Y, height, OVERSCAN_ROWS)
  const firstIndex = range.start * layout.columns
  const rendered = entries.slice(firstIndex, Math.min(entries.length, range.end * layout.columns))
  const tabStopId = rendered.some((entry) => entry.id === selectedId) ? selectedId : rendered[0]?.id ?? null

  // Back to the top when the view changes shape (new filter, search or mode).
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
    setScrollTop(0)
  }, [view, entries])

  // Keyboard moves can target a tile that was not mounted yet: focus it once it is.
  useEffect(() => {
    const id = focusAfterRender.current
    if (!id) return
    const element = scrollRef.current?.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(id)}"]`)
    if (element) {
      focusAfterRender.current = null
      element.focus({ preventScroll: true })
    }
  })

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>, index: number) {
    if (event.key === 'Enter') {
      event.preventDefault()
      onOpen(entries[index])
      return
    }
    const next = moveGridIndex(index, event.key, layout.columns, entries.length)
    if (next === null) return
    event.preventDefault()
    const target = entries[next]
    onSelect(target.id)
    focusAfterRender.current = target.id
    const scroller = scrollRef.current
    const reveal = scroller && scrollTopToReveal(layout, Math.floor(next / layout.columns), scroller.scrollTop - PADDING_Y, scroller.clientHeight)
    if (scroller && reveal !== null) scroller.scrollTop = reveal + PADDING_Y
  }

  return (
    <div
      ref={scrollRef}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      className="relative min-h-0 flex-1 overflow-y-auto"
    >
      <div
        role="listbox"
        aria-label="Library assets"
        className="relative"
        style={{ height: layout.totalHeight + PADDING_Y * 2 + 24, marginLeft: PADDING_X, marginRight: PADDING_X }}
      >
        {rendered.map((entry, offset) => {
          const index = firstIndex + offset
          const row = Math.floor(index / layout.columns)
          const column = index % layout.columns
          const props: TileProps = {
            entry,
            selected: entry.id === selectedId,
            opening: entry.id === openingId,
            tabStop: entry.id === tabStopId,
            style: {
              width: layout.columnWidth,
              height: layout.rowHeight,
              transform: `translate(${column * (layout.columnWidth + (view === 'grid' ? GRID.gap : 0))}px, ${PADDING_Y + row * layout.rowStride}px)`,
            },
            onSelect: () => onSelect(entry.id),
            onOpen: () => onOpen(entry),
            onKeyDown: (event) => handleKeyDown(event, index),
          }
          return view === 'grid' ? <GridTile key={entry.id} {...props} /> : <ListRow key={entry.id} {...props} />
        })}
      </div>
    </div>
  )
}

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import axios from 'axios'
import { useAppStore } from '@shared/stores/appStore'
import { useNavStore } from '@shared/stores/navStore'
import { useExtensionsStore } from '@shared/stores/extensionsStore'
import { useAssetThumbnailUrl } from '@shared/thumbnails/assetThumbnailStore'
import { ensureThumbnail } from '@shared/thumbnails/assetThumbnailService'
import { showImportedMesh } from '@shared/utils/meshJob'
import { useLiveWorkflowRun } from '@areas/workflows/workflowRunStore'
import type { RunRecord, RunRecordPage, RunStatus } from '@shared/types/runs'
import { useInputPreview } from './inputPreview'
import {
  buildQueueSections,
  formatDuration,
  formatStepLabel,
  isFinishedStatus,
  modelNameResolver,
  rowFromRecord,
  runElapsedSeconds,
  runOpenTarget,
  type ModelNameResolver,
  type QueueRow,
} from './queueModel'

/** Refresh rate while the panel is open. */
const OPEN_POLL_MS = 2000
/** Refresh rate while it is closed: only the button's count needs it. */
const CLOSED_POLL_MS = 5000
/** Newest runs fetched while closed: running and queued runs are always among them. */
const CLOSED_LIMIT = 20
const PAGE_SIZE = 50
/** The list endpoint's largest page. */
const MAX_LIMIT = 200

const nowSeconds = () => Date.now() / 1000

/** Closes the panel: opening a run's output leaves it. */
const ClosePanelContext = createContext<() => void>(() => {})

// ─── Data ─────────────────────────────────────────────────────────────────────

/**
 * Top-level run history. While the panel is open the first MAX_LIMIT runs are
 * polled every 2 s and older pages ("Load more" past that) are fetched once and
 * kept; while it is closed only the newest few are polled, for the count.
 */
function useRunHistory(apiUrl: string, open: boolean) {
  const [polled, setPolled] = useState<RunRecord[]>([])
  const [older, setOlder] = useState<RunRecord[]>([])
  const [total, setTotal] = useState(0)
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const inFlight = useRef(false)
  const fetchLimit = open ? limit : CLOSED_LIMIT

  const refresh = useCallback(async () => {
    if (!apiUrl || inFlight.current) return
    inFlight.current = true
    try {
      const { data } = await axios.get<RunRecordPage>(`${apiUrl}/workflow-runs`, {
        params: { top_level: true, limit: fetchLimit, offset: 0 },
      })
      setPolled(data.runs)
      setTotal(data.total)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      inFlight.current = false
      setLoaded(true)
    }
  }, [apiUrl, fetchLimit])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, open ? OPEN_POLL_MS : CLOSED_POLL_MS)
    return () => clearInterval(timer)
  }, [refresh, open])

  // Closing drops the extra pages: the panel reopens on the newest runs.
  useEffect(() => {
    if (open) return
    setLimit(PAGE_SIZE)
    setOlder([])
  }, [open])

  const loadMore = useCallback(async () => {
    if (limit < MAX_LIMIT) {
      setLimit((current) => Math.min(MAX_LIMIT, current + PAGE_SIZE))
      return
    }
    setLoadingMore(true)
    try {
      const { data } = await axios.get<RunRecordPage>(`${apiUrl}/workflow-runs`, {
        params: { top_level: true, limit: MAX_LIMIT, offset: MAX_LIMIT + older.length },
      })
      setOlder((current) => [...current, ...data.runs])
      setTotal(data.total)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingMore(false)
    }
  }, [apiUrl, limit, older.length])

  const records = useMemo(() => {
    const ids = new Set(polled.map((r) => r.id))
    return [...polled, ...older.filter((r) => !ids.has(r.id))]
  }, [polled, older])

  return { records, hasMore: total > polled.length + older.length, loaded, error, loadingMore, loadMore }
}

/** A workflow run's child runs (its model generations), re-fetched while it runs. */
function useChildRuns(apiUrl: string, runId: string, live: boolean) {
  const [children, setChildren] = useState<RunRecord[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    const fetchChildren = async () => {
      try {
        const { data } = await axios.get<{ runs: RunRecord[] }>(`${apiUrl}/workflow-runs/${encodeURIComponent(runId)}/children`)
        if (alive) { setChildren(data.runs); setError(null) }
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err))
      }
    }
    void fetchChildren()
    if (!live) return () => { alive = false }
    const timer = setInterval(() => { void fetchChildren() }, OPEN_POLL_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [apiUrl, runId, live])
  return { children, error }
}

/** Seconds since the epoch, re-rendering every second while `ticking`. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(nowSeconds)
  useEffect(() => {
    if (!ticking) return
    setNow(nowSeconds())
    const timer = setInterval(() => setNow(nowSeconds()), 1000)
    return () => clearInterval(timer)
  }, [ticking])
  return now
}

// ─── Pieces ───────────────────────────────────────────────────────────────────

function Icon({ d, size = 14 }: { d: string, size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

const ICONS = {
  mesh:     'M12 2 3 7v10l9 5 9-5V7zM3 7l9 5 9-5M12 12v10',
  workflow: 'M4 5h5v5H4zM15 14h5v5h-5zM9 7.5h3.5a2 2 0 0 1 2 2V14',
  chevron:  'm9 6 6 6-6 6',
  queue:    'M4 6h11M4 12h6M4 18h6M17 11a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM17 13.5v2.2l1.4 1.1',
}

const STATUS_STYLES: Record<RunStatus | 'paused', { label: string, className: string }> = {
  pending:     { label: 'Queued',      className: 'bg-zinc-800 text-zinc-300' },
  running:     { label: 'Running',     className: 'bg-accent/15 text-accent-light' },
  paused:      { label: 'Waiting',     className: 'bg-amber-500/10 text-amber-300' },
  done:        { label: 'Done',        className: 'bg-emerald-500/10 text-emerald-300' },
  error:       { label: 'Failed',      className: 'bg-red-500/10 text-red-300' },
  cancelled:   { label: 'Cancelled',   className: 'bg-zinc-800 text-zinc-400' },
  interrupted: { label: 'Interrupted', className: 'bg-amber-500/10 text-amber-300' },
}

function StatusPill({ status, paused = false }: { status: RunStatus, paused?: boolean }): JSX.Element {
  const style = STATUS_STYLES[paused && status === 'running' ? 'paused' : status]
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[10.5px] font-medium ${style.className}`}>
      {status === 'running' && !paused && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" aria-hidden="true" />}
      {style.label}
    </span>
  )
}

function SectionHeader({ title, count }: { title: string, count: number }): JSX.Element {
  return (
    <div className="mb-2 flex items-baseline gap-2 px-1">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">{title}</h3>
      <span className="rounded-full bg-white/5 px-1.5 py-px font-mono text-[10px] text-zinc-500">{count}</span>
    </div>
  )
}

/** The run's input image, else its output mesh's thumbnail, else a kind icon. */
function RunThumbnail({ row }: { row: QueueRow }): JSX.Element {
  const inputUrl = useInputPreview(row.inputImage)
  const target = runOpenTarget(row)
  const meshPath = !row.inputImage && target.openable ? target.workspacePath : ''
  const meshUrl = useAssetThumbnailUrl({ workspacePath: meshPath })
  useEffect(() => { if (meshPath) ensureThumbnail(meshPath) }, [meshPath])
  const src = inputUrl ?? (meshPath ? meshUrl : undefined)
  return (
    <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md border border-zinc-800 bg-zinc-900 text-zinc-600">
      {src
        ? <img src={src} alt="" className="h-full w-full object-cover" draggable={false} />
        : <Icon d={row.kind === 'workflow' ? ICONS.workflow : ICONS.mesh} size={15} />}
    </div>
  )
}

function ProgressBar({ progress }: { progress: number }): JSX.Element {
  // A negative progress means unknown: an indeterminate shimmer.
  const known = progress >= 0
  return (
    <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-zinc-800" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={known ? Math.round(progress) : undefined}>
      <div
        className={`h-full rounded-full bg-accent transition-[width] duration-500 ${known ? '' : 'w-1/3 animate-pulse'}`}
        style={known ? { width: `${Math.max(2, progress)}%` } : undefined}
      />
    </div>
  )
}

function OutputActions({ row }: { row: QueueRow }): JSX.Element | null {
  const navigate = useNavStore((s) => s.navigate)
  const closePanel = useContext(ClosePanelContext)
  if (!isFinishedStatus(row.status)) return null
  const target = runOpenTarget(row)
  const tooltip = target.openable ? undefined : target.reason
  const button = 'rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors disabled:cursor-not-allowed'
  return (
    <div className="flex shrink-0 items-center gap-1" title={tooltip}>
      <button
        type="button"
        disabled={!target.openable}
        onClick={(event) => {
          event.stopPropagation()
          if (!target.openable) return
          showImportedMesh(target.url)
          navigate('generate')
          closePanel()
        }}
        className={`${button} bg-accent text-white hover:bg-violet-500 disabled:bg-zinc-800 disabled:text-zinc-500`}
      >
        Open
      </button>
      <button
        type="button"
        disabled={!target.openable}
        onClick={(event) => {
          event.stopPropagation()
          if (!target.openable) return
          navigate('library', { selected: target.workspacePath })
          closePanel()
        }}
        className={`${button} border border-zinc-700/60 text-zinc-300 hover:border-zinc-600 hover:bg-white/[0.06] disabled:border-zinc-800 disabled:text-zinc-600`}
      >
        Library
      </button>
    </div>
  )
}

function stepSummary(row: QueueRow): string {
  if (row.current) return formatStepLabel(row.current)
  if (row.status === 'pending') return 'Waiting to start'
  if (row.paused) return 'Waiting for you to continue a branch'
  if (row.status === 'error' && row.error) return row.error
  const count = row.steps.length
  if (count === 0) return row.status === 'running' ? 'Starting…' : ''
  return `${count} ${count === 1 ? 'step' : 'steps'}`
}

function StepList({ row, now }: { row: QueueRow, now: number }): JSX.Element {
  if (row.steps.length === 0) return <p className="text-[11px] text-zinc-500">No steps recorded.</p>
  return (
    <ol className="flex flex-col gap-1">
      {row.steps.map((step, index) => (
        <li key={`${step.node_id ?? step.name}-${index}`} className="flex items-center gap-2 text-[11px]">
          <span className="w-4 shrink-0 text-right font-mono text-zinc-600">{index + 1}</span>
          <span className="min-w-0 flex-1 truncate text-zinc-300">{step.name}</span>
          <span className="shrink-0 font-mono text-zinc-500">
            {formatDuration(runElapsedSeconds({ startedAt: step.started_at, endedAt: step.ended_at ?? null }, now))}
          </span>
          <StatusPill status={step.status} />
        </li>
      ))}
    </ol>
  )
}

function ChildRuns({ row, apiUrl, resolveModel, now }: { row: QueueRow, apiUrl: string, resolveModel: ModelNameResolver, now: number }): JSX.Element {
  const { children, error } = useChildRuns(apiUrl, row.id, !isFinishedStatus(row.status))
  if (error && !children) return <p className="text-[11px] text-amber-300">Could not load the generations: {error}</p>
  if (!children) return <p className="text-[11px] text-zinc-500">Loading generations…</p>
  if (children.length === 0) return <p className="text-[11px] text-zinc-500">No model generations in this run.</p>
  return (
    <ol className="flex flex-col gap-1.5">
      {children.map((record) => {
        const child = rowFromRecord(record, resolveModel)
        return (
          <li key={child.id} className="flex items-center gap-2 text-[11px]">
            <span className="min-w-0 flex-1 truncate text-zinc-300">{child.name}</span>
            <span className="shrink-0 font-mono text-zinc-500">{formatDuration(runElapsedSeconds(child, now))}</span>
            <StatusPill status={child.status} />
            <OutputActions row={child} />
          </li>
        )
      })}
    </ol>
  )
}

function RunCard({ row, now, apiUrl, resolveModel }: { row: QueueRow, now: number, apiUrl: string, resolveModel: ModelNameResolver }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const expandable = row.kind === 'workflow'
  const summary = stepSummary(row)
  const failed = row.status === 'error' && !row.current
  const finished = isFinishedStatus(row.status)
  return (
    <li className="rounded-lg border border-zinc-800 bg-zinc-900/50 transition-colors hover:border-zinc-700">
      <div
        className={`flex items-center gap-2.5 px-2.5 py-2 ${expandable ? 'cursor-pointer' : ''}`}
        onClick={expandable ? () => setExpanded((v) => !v) : undefined}
      >
        <RunThumbnail row={row} />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {expandable && (
              <button
                type="button"
                aria-expanded={expanded}
                aria-label={expanded ? 'Hide steps' : 'Show steps'}
                onClick={(event) => { event.stopPropagation(); setExpanded((v) => !v) }}
                className="-ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded text-zinc-500 transition-colors hover:text-zinc-200"
              >
                <span className={`transition-transform ${expanded ? 'rotate-90' : ''}`}><Icon d={ICONS.chevron} size={11} /></span>
              </button>
            )}
            <p className="truncate text-[12px] font-medium text-zinc-100">{row.name}</p>
            <span className="shrink-0 text-[9.5px] uppercase tracking-wide text-zinc-600">
              {row.kind === 'mesh_op' ? 'Mesh edit' : row.kind}
            </span>
          </div>
          {summary && (
            <p className={`mt-0.5 truncate text-[11px] ${failed ? 'text-red-300/90' : 'text-zinc-500'}`} title={summary}>
              {summary}
              {row.current?.detail && row.current.detail !== row.current.name ? <span className="text-zinc-600"> · {row.current.detail}</span> : null}
            </p>
          )}
          {row.current && <ProgressBar progress={row.current.progress} />}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1">
          <div className="flex items-center gap-1.5">
            {row.status !== 'pending' && (
              <span className="font-mono text-[10.5px] text-zinc-400" title={row.endedAt ? 'Duration' : 'Elapsed'}>
                {formatDuration(runElapsedSeconds(row, now))}
              </span>
            )}
            <StatusPill status={row.status} paused={row.paused} />
          </div>
          {finished && <OutputActions row={row} />}
        </div>
      </div>

      {expanded && (
        <div className="flex flex-col gap-3 border-t border-zinc-800/80 px-3 py-2.5">
          <div>
            <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500">Steps</p>
            <StepList row={row} now={now} />
          </div>
          <div>
            <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500">Generations</p>
            <ChildRuns row={row} apiUrl={apiUrl} resolveModel={resolveModel} now={now} />
          </div>
        </div>
      )}
    </li>
  )
}

function Section({ title, rows, empty, now, apiUrl, resolveModel, footer }: {
  title: string
  rows: QueueRow[]
  empty: string
  now: number
  apiUrl: string
  resolveModel: ModelNameResolver
  footer?: JSX.Element | null
}): JSX.Element {
  return (
    <section>
      <SectionHeader title={title} count={rows.length} />
      {rows.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {rows.map((row) => <RunCard key={row.id} row={row} now={now} apiUrl={apiUrl} resolveModel={resolveModel} />)}
        </ul>
      ) : <p className="px-1 text-[11px] text-zinc-600">{empty}</p>}
      {footer}
    </section>
  )
}

// ─── Button + panel ───────────────────────────────────────────────────────────

/**
 * The top bar's Queue button. It shows how many runs are running or waiting,
 * and opens a panel under it with the running, queued and finished runs.
 */
export default function QueueButton(): JSX.Element {
  const apiUrl = useAppStore((s) => s.apiUrl)
  const navigate = useNavStore((s) => s.navigate)
  const modelExtensions = useExtensionsStore((s) => s.modelExtensions)
  const live = useLiveWorkflowRun()
  const [open, setOpen] = useState(false)
  const { records, hasMore, loaded, error, loadingMore, loadMore } = useRunHistory(apiUrl, open)

  const resolveModel = useMemo(() => modelNameResolver(modelExtensions), [modelExtensions])
  const sections = useMemo(() => buildQueueSections(live, records, resolveModel), [live, records, resolveModel])
  const now = useNow(open && sections.running.length > 0)
  const active = sections.running.length + sections.queued.length

  // Close on a click outside, on Escape, and when a run's output opens a page.
  const close = useCallback(() => setOpen(false), [])
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const nothingYet = loaded && sections.running.length + sections.queued.length + sections.history.length === 0

  return (
    <div ref={rootRef} className="no-drag relative mr-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={active > 0 ? `Queue, ${active} active` : 'Queue'}
        title="Queue"
        className={`h-7 flex items-center gap-1.5 px-2.5 rounded-md border text-[11px] font-medium transition-colors ${
          open
            ? 'bg-accent/20 border-accent/40 text-accent-light'
            : 'border-zinc-700/70 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 hover:border-zinc-600'
        }`}
      >
        <Icon d={ICONS.queue} size={13} />
        Queue
        {active > 0 && (
          <span className="ml-0.5 inline-flex min-w-[16px] items-center justify-center gap-1 rounded-full bg-accent px-1 font-mono text-[10px] leading-4 text-white">
            {sections.running.length > 0 && <span className="h-1 w-1 animate-pulse rounded-full bg-white" aria-hidden="true" />}
            {active}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Queue"
          className="absolute right-0 top-full z-50 mt-1.5 flex max-h-[min(70vh,640px)] w-[440px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-xl border border-zinc-800 bg-surface-400 shadow-2xl shadow-black/50"
        >
          <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-3.5 py-2.5">
            <p className="text-[12px] text-zinc-400" aria-live="polite">
              {!loaded
                ? 'Loading runs…'
                : sections.running.length > 0
                  ? <><b className="font-semibold text-zinc-100">{sections.running.length}</b> running{sections.queued.length > 0 ? <>, <b className="font-semibold text-zinc-100">{sections.queued.length}</b> queued</> : null}</>
                  : 'Nothing running right now'}
            </p>
            {error && (
              <p role="alert" className="truncate text-[11px] text-amber-300" title={error}>Could not refresh</p>
            )}
          </div>

          <ClosePanelContext.Provider value={close}>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2.5 py-3">
            {nothingYet ? (
              <div className="flex flex-col items-center gap-1.5 py-8 text-center">
                <p className="text-[12px] font-medium text-zinc-300">No runs yet</p>
                <p className="max-w-[280px] text-[11px] text-zinc-500">Generations and workflow runs show up here while they run, and stay listed once they finish.</p>
                <button type="button" onClick={() => { navigate('generate'); close() }} className="mt-1 text-[11px] font-medium text-accent-light hover:text-violet-300">Go to Generate</button>
              </div>
            ) : (
              <>
                {sections.running.length > 0 && (
                  <Section title="Running" rows={sections.running} empty="" now={now} apiUrl={apiUrl} resolveModel={resolveModel} />
                )}
                {sections.queued.length > 0 && (
                  <Section title="Queued" rows={sections.queued} empty="" now={now} apiUrl={apiUrl} resolveModel={resolveModel} />
                )}
                <Section
                  title="History"
                  rows={sections.history}
                  empty={loaded ? 'Finished runs will be listed here.' : 'Loading…'}
                  now={now}
                  apiUrl={apiUrl}
                  resolveModel={resolveModel}
                  footer={hasMore ? (
                    <div className="mt-2 flex justify-center">
                      <button
                        type="button"
                        onClick={() => { void loadMore() }}
                        disabled={loadingMore}
                        className="rounded-md border border-zinc-700/60 bg-white/[0.025] px-3 py-1.5 text-[11px] font-medium text-zinc-200 transition-colors hover:border-zinc-600 hover:bg-white/[0.06] disabled:opacity-40"
                      >
                        {loadingMore ? 'Loading…' : 'Load more'}
                      </button>
                    </div>
                  ) : null}
                />
              </>
            )}
          </div>
          </ClosePanelContext.Provider>
        </div>
      )}
    </div>
  )
}

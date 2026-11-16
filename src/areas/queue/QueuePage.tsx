import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

const POLL_MS = 2000
const PAGE_SIZE = 50
/** The list endpoint's largest page. */
const MAX_LIMIT = 200

const nowSeconds = () => Date.now() / 1000

// ─── Data ─────────────────────────────────────────────────────────────────────

/**
 * Top-level run history, refreshed every 2 s while the page is mounted. The
 * first MAX_LIMIT runs are polled; older pages ("Load more" past that) are
 * fetched once and kept.
 */
function useRunHistory(apiUrl: string) {
  const [polled, setPolled] = useState<RunRecord[]>([])
  const [older, setOlder] = useState<RunRecord[]>([])
  const [total, setTotal] = useState(0)
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const inFlight = useRef(false)

  const refresh = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const { data } = await axios.get<RunRecordPage>(`${apiUrl}/workflow-runs`, {
        params: { top_level: true, limit, offset: 0 },
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
  }, [apiUrl, limit])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

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
    const timer = setInterval(() => { void fetchChildren() }, POLL_MS)
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
  queue:    'M4 6h11M4 12h7M4 18h7M17 13v3l2 1.5',
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
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${style.className}`}>
      {status === 'running' && !paused && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" aria-hidden="true" />}
      {style.label}
    </span>
  )
}

function SectionHeader({ title, count }: { title: string, count: number }): JSX.Element {
  return (
    <div className="mb-3 flex items-baseline gap-2">
      <h2 className="text-[13px] font-semibold text-zinc-200">{title}</h2>
      <span className="rounded-full bg-white/5 px-1.5 py-px font-mono text-[10px] text-zinc-500">{count}</span>
    </div>
  )
}

function Empty({ text }: { text: string }): JSX.Element {
  return (
    <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/30 px-4 py-5">
      <p className="text-xs text-zinc-500">{text}</p>
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
    <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-600">
      {src
        ? <img src={src} alt="" className="h-full w-full object-cover" draggable={false} />
        : <Icon d={row.kind === 'workflow' ? ICONS.workflow : ICONS.mesh} size={18} />}
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

function OutputActions({ row, compact = false }: { row: QueueRow, compact?: boolean }): JSX.Element | null {
  const navigate = useNavStore((s) => s.navigate)
  if (!isFinishedStatus(row.status)) return null
  const target = runOpenTarget(row)
  const tooltip = target.openable ? undefined : target.reason
  const button = 'rounded-lg px-2.5 py-1 text-[11.5px] font-medium transition-colors disabled:cursor-not-allowed'
  return (
    <div className="flex shrink-0 items-center gap-1.5" title={tooltip}>
      <button
        type="button"
        disabled={!target.openable}
        onClick={(event) => {
          event.stopPropagation()
          if (!target.openable) return
          showImportedMesh(target.url)
          navigate('generate')
        }}
        className={`${button} bg-accent text-white hover:bg-violet-500 disabled:bg-zinc-800 disabled:text-zinc-500`}
      >
        {compact ? 'Open' : 'Open in Generate'}
      </button>
      <button
        type="button"
        disabled={!target.openable}
        onClick={(event) => {
          event.stopPropagation()
          if (target.openable) navigate('library', { selected: target.workspacePath })
        }}
        className={`${button} border border-zinc-700/60 text-zinc-300 hover:border-zinc-600 hover:bg-white/[0.06] disabled:border-zinc-800 disabled:text-zinc-600`}
      >
        {compact ? 'Library' : 'Show in Library'}
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
  if (row.steps.length === 0) return <p className="text-[11.5px] text-zinc-500">No steps recorded.</p>
  return (
    <ol className="flex flex-col gap-1">
      {row.steps.map((step, index) => (
        <li key={`${step.node_id ?? step.name}-${index}`} className="flex items-center gap-2 text-[11.5px]">
          <span className="w-5 shrink-0 text-right font-mono text-zinc-600">{index + 1}</span>
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
  if (error && !children) return <p className="text-[11.5px] text-amber-300">Could not load the generations: {error}</p>
  if (!children) return <p className="text-[11.5px] text-zinc-500">Loading generations…</p>
  if (children.length === 0) return <p className="text-[11.5px] text-zinc-500">No model generations in this run.</p>
  return (
    <ol className="flex flex-col gap-1.5">
      {children.map((record) => {
        const child = rowFromRecord(record, resolveModel)
        return (
          <li key={child.id} className="flex items-center gap-2 text-[11.5px]">
            <span className="min-w-0 flex-1 truncate text-zinc-300">{child.name}</span>
            <span className="shrink-0 font-mono text-zinc-500">{formatDuration(runElapsedSeconds(child, now))}</span>
            <StatusPill status={child.status} />
            <OutputActions row={child} compact />
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
  return (
    <li className="rounded-xl border border-zinc-800 bg-zinc-900/50 transition-colors hover:border-zinc-700">
      <div
        className={`flex items-center gap-3 px-3.5 py-3 ${expandable ? 'cursor-pointer' : ''}`}
        onClick={expandable ? () => setExpanded((v) => !v) : undefined}
      >
        {expandable ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={expanded ? 'Hide steps' : 'Show steps'}
            onClick={(event) => { event.stopPropagation(); setExpanded((v) => !v) }}
            className="-ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200"
          >
            <span className={`transition-transform ${expanded ? 'rotate-90' : ''}`}><Icon d={ICONS.chevron} size={13} /></span>
          </button>
        ) : <span className="-ml-1 w-6 shrink-0" aria-hidden="true" />}

        <RunThumbnail row={row} />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-[13px] font-medium text-zinc-100">{row.name}</p>
            <span className="shrink-0 text-[10.5px] uppercase tracking-wide text-zinc-600">
              {row.kind === 'mesh_op' ? 'Mesh edit' : row.kind}
            </span>
          </div>
          {summary && (
            <p className={`mt-0.5 truncate text-[11.5px] ${failed ? 'text-red-300/90' : 'text-zinc-500'}`} title={summary}>
              {summary}
              {row.current?.detail && row.current.detail !== row.current.name ? <span className="text-zinc-600"> · {row.current.detail}</span> : null}
            </p>
          )}
          {row.current && <ProgressBar progress={row.current.progress} />}
        </div>

        <span className="w-16 shrink-0 text-right font-mono text-[11.5px] text-zinc-400" title={row.endedAt ? 'Duration' : 'Elapsed'}>
          {row.status === 'pending' ? '' : formatDuration(runElapsedSeconds(row, now))}
        </span>
        <StatusPill status={row.status} paused={row.paused} />
        <OutputActions row={row} />
      </div>

      {expanded && (
        <div className="grid gap-4 border-t border-zinc-800/80 px-4 py-3 sm:grid-cols-2">
          <div>
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-zinc-500">Steps</p>
            <StepList row={row} now={now} />
          </div>
          <div>
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-zinc-500">Generations</p>
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
        <ul className="flex flex-col gap-2">
          {rows.map((row) => <RunCard key={row.id} row={row} now={now} apiUrl={apiUrl} resolveModel={resolveModel} />)}
        </ul>
      ) : <Empty text={empty} />}
      {footer}
    </section>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function QueuePage(): JSX.Element {
  const apiUrl = useAppStore((s) => s.apiUrl)
  const navigate = useNavStore((s) => s.navigate)
  const modelExtensions = useExtensionsStore((s) => s.modelExtensions)
  const live = useLiveWorkflowRun()
  const { records, hasMore, loaded, error, loadingMore, loadMore } = useRunHistory(apiUrl)

  const resolveModel = useMemo(() => modelNameResolver(modelExtensions), [modelExtensions])
  const sections = useMemo(() => buildQueueSections(live, records, resolveModel), [live, records, resolveModel])
  const now = useNow(sections.running.length > 0)

  const nothingYet = loaded && sections.running.length + sections.queued.length + sections.history.length === 0

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-7 py-6">
      <header className="flex items-start justify-between gap-6">
        <div>
          <h1 className="text-[21px] font-semibold tracking-tight text-zinc-100">Queue</h1>
          <p className="mt-1 text-[13px] text-zinc-500" aria-live="polite">
            {!loaded
              ? 'Loading runs…'
              : sections.running.length > 0
                ? <><b className="font-semibold text-zinc-200">{sections.running.length}</b> running{sections.queued.length > 0 ? <>, <b className="font-semibold text-zinc-200">{sections.queued.length}</b> queued</> : null}</>
                : 'Nothing running right now'}
          </p>
        </div>
        {error && (
          <p role="alert" className="max-w-xs truncate text-right text-[11.5px] text-amber-300" title={error}>
            Could not refresh the run history
          </p>
        )}
      </header>

      {nothingYet ? (
        <div className="flex flex-col items-center gap-2 py-16 text-center">
          <div className="mb-1 flex h-12 w-12 items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-900/60 text-zinc-600">
            <Icon d={ICONS.queue} size={22} />
          </div>
          <p className="text-sm font-medium text-zinc-300">No runs yet</p>
          <p className="max-w-sm text-xs text-zinc-500">Generations and workflow runs show up here while they run, and stay listed once they finish.</p>
          <button type="button" onClick={() => navigate('generate')} className="mt-2 text-xs font-medium text-accent-light hover:text-violet-300">Go to Generate</button>
        </div>
      ) : (
        <>
          <Section title="Running" rows={sections.running} empty="Nothing is running." now={now} apiUrl={apiUrl} resolveModel={resolveModel} />
          <Section title="Queued" rows={sections.queued} empty="Nothing is waiting to start." now={now} apiUrl={apiUrl} resolveModel={resolveModel} />
          <Section
            title="History"
            rows={sections.history}
            empty={loaded ? 'Finished runs will be listed here.' : 'Loading…'}
            now={now}
            apiUrl={apiUrl}
            resolveModel={resolveModel}
            footer={hasMore ? (
              <div className="mt-3 flex justify-center">
                <button
                  type="button"
                  onClick={() => { void loadMore() }}
                  disabled={loadingMore}
                  className="rounded-[9px] border border-zinc-700/60 bg-white/[0.025] px-3.5 py-2 text-xs font-medium text-zinc-200 transition-colors hover:border-zinc-600 hover:bg-white/[0.06] disabled:opacity-40"
                >
                  {loadingMore ? 'Loading…' : 'Load more'}
                </button>
              </div>
            ) : null}
          />
        </>
      )}
    </div>
  )
}

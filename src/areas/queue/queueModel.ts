// Pure model of the Queue page: merges the workflow run this window is
// executing with the persisted run history (GET /workflow-runs) into Running,
// Queued and History sections, and derives what each row shows and opens.
// Timestamps are epoch seconds, as in the run records.

import type { RunKind, RunRecord, RunStatus, RunStep } from '../../shared/types/runs'
import type { LiveRunCurrentStep, LiveWorkflowRun } from '../workflows/workflowRunRecord'

export interface QueueRow {
  id:          string
  kind:        RunKind
  name:        string
  status:      RunStatus
  /** Running but waiting on the user (a Wait branch, a paused loop). */
  paused:      boolean
  /** Absolute path of the input image, when the run had one on disk. */
  inputImage:  string | null
  createdAt:   number
  startedAt:   number | null
  endedAt:     number | null
  steps:       RunStep[]
  /** The step running now, with live progress when this window runs it. */
  current:     LiveRunCurrentStep | null
  outputPath:  string | null
  error:       string | null
  /** Fed by this window's runner rather than by the history list. */
  live:        boolean
}

export interface QueueSections {
  running: QueueRow[]
  queued:  QueueRow[]
  history: QueueRow[]
}

/** Resolves a generation's model id to a display name. */
export type ModelNameResolver = (modelId: string) => string | undefined

const TERMINAL: ReadonlySet<RunStatus> = new Set(['done', 'error', 'cancelled', 'interrupted'])

export function isFinishedStatus(status: RunStatus): boolean {
  return TERMINAL.has(status)
}

/** Model extensions → a resolver for `model_id` ("ext" or "ext/node"). */
export function modelNameResolver(
  extensions: readonly { id: string, name: string, nodes?: readonly { id: string, name?: string }[] }[],
): ModelNameResolver {
  return (modelId) => {
    const [extId, nodeId] = modelId.split('/')
    const ext = extensions.find((e) => e.id === extId)
    if (!ext) return undefined
    const node = nodeId ? ext.nodes?.find((n) => n.id === nodeId) : undefined
    return node?.name ?? ext.name
  }
}

function prettyId(id: string): string {
  const last = id.split('/').pop() ?? id
  const words = last.replace(/[_-]+/g, ' ').trim()
  return words ? words[0].toUpperCase() + words.slice(1) : id
}

export function runDisplayName(record: RunRecord, resolveModel?: ModelNameResolver): string {
  if (record.kind === 'workflow') return record.workflow_name?.trim() || 'Untitled workflow'
  if (record.kind === 'mesh_op') return record.op_id ? prettyId(record.op_id) : 'Mesh operation'
  if (!record.model_id) return 'Generation'
  return resolveModel?.(record.model_id) ?? prettyId(record.model_id)
}

const ABSOLUTE_PATH = /^(?:[a-zA-Z]:[\\/]|[\\/])/

/** The input image a run read from disk; generations only record a file name. */
export function inputImagePath(inputs: Record<string, unknown> | undefined): string | null {
  const image = inputs?.image
  return typeof image === 'string' && ABSOLUTE_PATH.test(image) ? image : null
}

/** The open step of a history record (its progress is unknown here). */
function recordCurrentStep(record: RunRecord): LiveRunCurrentStep | null {
  if (record.status !== 'running') return null
  const last = record.steps[record.steps.length - 1]
  if (!last || last.ended_at != null) return null
  return { index: record.steps.length, total: 0, name: last.name, detail: '', progress: -1 }
}

export function rowFromRecord(record: RunRecord, resolveModel?: ModelNameResolver): QueueRow {
  return {
    id:         record.id,
    kind:       record.kind,
    name:       runDisplayName(record, resolveModel),
    status:     record.status,
    paused:     false,
    inputImage: inputImagePath(record.inputs),
    createdAt:  record.created_at,
    startedAt:  record.started_at ?? null,
    endedAt:    record.ended_at ?? null,
    steps:      record.steps ?? [],
    current:    recordCurrentStep(record),
    outputPath: record.output_path ?? null,
    error:      record.error ?? null,
    live:       false,
  }
}

export function rowFromLiveRun(run: LiveWorkflowRun): QueueRow {
  return {
    id:         run.runId,
    kind:       'workflow',
    name:       run.workflowName.trim() || 'Untitled workflow',
    status:     run.status,
    paused:     run.paused,
    inputImage: inputImagePath(run.inputs),
    createdAt:  run.startedAt,
    startedAt:  run.startedAt,
    endedAt:    run.endedAt,
    steps:      run.steps,
    current:    run.current,
    outputPath: run.outputPath,
    error:      run.error,
    live:       true,
  }
}

const newestFirst = (a: QueueRow, b: QueueRow) => (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt)

/**
 * Splits runs into sections. The live run and its own history record are the
 * same run: while it runs the live copy wins (it has step progress the record
 * lacks); once it has ended the record wins, and the live copy only stands in
 * until the history lists it. Queued runs come oldest first (next up on top);
 * Running and History newest first.
 */
export function buildQueueSections(
  live: LiveWorkflowRun | null,
  records: readonly RunRecord[],
  resolveModel?: ModelNameResolver,
): QueueSections {
  const running: QueueRow[] = []
  const queued: QueueRow[] = []
  const history: QueueRow[] = []
  const seen = new Set<string>()

  const liveRow = live ? rowFromLiveRun(live) : null
  const liveRunning = liveRow !== null && !isFinishedStatus(liveRow.status)
  if (liveRow && liveRunning) {
    running.push(liveRow)
    seen.add(liveRow.id)
  }

  for (const record of records) {
    if (seen.has(record.id) || record.parent_run_id) continue
    seen.add(record.id)
    const row = rowFromRecord(record, resolveModel)
    if (row.status === 'pending') queued.push(row)
    else if (row.status === 'running') running.push(row)
    else history.push(row)
  }

  if (liveRow && !seen.has(liveRow.id)) history.push(liveRow)

  running.sort(newestFirst)
  queued.sort((a, b) => a.createdAt - b.createdAt)
  history.sort(newestFirst)
  return { running, queued, history }
}

/** Seconds a run has been going (running) or took (finished); null before it starts. */
export function runElapsedSeconds(row: Pick<QueueRow, 'startedAt' | 'endedAt'>, now: number): number | null {
  if (row.startedAt == null) return null
  const end = row.endedAt ?? now
  return Math.max(0, end - row.startedAt)
}

/** "42s", "3m 05s", "1h 02m". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—'
  const total = Math.max(0, Math.floor(seconds))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** "Step 2/4 · Generate Mesh", or "Step 2 · Generate Mesh" when the total is unknown. */
export function formatStepLabel(step: Pick<LiveRunCurrentStep, 'index' | 'total' | 'name'>): string {
  const position = step.total >= step.index ? `${step.index}/${step.total}` : `${step.index}`
  return `Step ${position} · ${step.name}`
}

export type RunOpenTarget =
  | { openable: true, workspacePath: string, url: string }
  | { openable: false, reason: string }

const MESH_EXTENSIONS = /\.(glb|gltf)$/i
const AUDIO_EXTENSIONS = /\.(wav|mp3|ogg|flac|m4a)$/i
const SCENE_EXTENSIONS = /\.json$/i

/**
 * What a finished run's output opens as. Only workspace meshes (.glb/.gltf)
 * open in Generate and show in the Library; output_path is workspace-relative
 * for those, absolute when the output lives elsewhere.
 */
export function runOpenTarget(row: Pick<QueueRow, 'status' | 'outputPath'>): RunOpenTarget {
  if (!isFinishedStatus(row.status)) return { openable: false, reason: 'The run has not finished yet.' }
  const path = row.outputPath?.trim().replace(/\\/g, '/')
  if (!path) return { openable: false, reason: 'This run did not produce an output.' }
  if (ABSOLUTE_PATH.test(path) || path.split('/').includes('..')) {
    return { openable: false, reason: 'The output is outside the workspace.' }
  }
  if (AUDIO_EXTENSIONS.test(path)) return { openable: false, reason: 'Audio outputs cannot be opened in the 3D viewer.' }
  if (SCENE_EXTENSIONS.test(path)) return { openable: false, reason: 'Scene outputs cannot be opened from the Queue yet.' }
  if (!MESH_EXTENSIONS.test(path)) return { openable: false, reason: 'Only .glb and .gltf outputs can be opened.' }
  return { openable: true, workspacePath: path, url: `/workspace/${path}` }
}

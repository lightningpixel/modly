// Pure logic behind the Image Studio's operations (GET /image/ops): which
// image a run reads, the one-time setup card and its download progress.
// Kept free of React so it can be unit-tested with node --test.

import type { MeshOpParamSchema } from '../generate/meshEditPanel'
import type { SseEvent } from '../../shared/services/llmDownloads'
import { sourceOf, type StudioImage } from './imageStudioStore'

/** What an op may need installed before its first run. */
export type SetupStep = 'runtime' | 'model'

/** One entry of GET /image/ops. */
export interface ImageOpDescriptor {
  id: string
  label: string
  params_schema: MeshOpParamSchema[]
  requirements: ImageOpRequirement[]
}

/** One entry of an op's `requirements` (ImageOp.describe() on the backend). */
export interface ImageOpRequirement {
  kind: SetupStep
  /** e.g. "onnxruntime", "birefnet-lite" */
  id: string
  label: string
}

/** GET /image/op/{op}/status */
export interface ImageOpStatus {
  ready: boolean
  missing: SetupStep[]
  download_bytes: number | null
}

/** A frame of POST /image/op/{op}/prepare: the LLM download format, plus the step it belongs to. */
export type PrepareEvent = SseEvent & { step?: SetupStep }

// ─── Run input ────────────────────────────────────────────────────────────────

/**
 * The image a run of `opId` reads. Re-running an op on its own result (e.g.
 * with another edge threshold) starts again from the original, not from the
 * already-processed image.
 */
export function runInputFor(entries: readonly StudioImage[], selected: StudioImage, opId: string): StudioImage {
  if (selected.op === opId) return sourceOf(entries, selected) ?? selected
  return selected
}

// ─── One op at a time ─────────────────────────────────────────────────────────

/**
 * The toolbar runs one op at a time: they share the canvas's busy overlay, so
 * a second op finishing first would clear it while the other still runs.
 */
export interface RunLock {
  /** Takes the lock for `opId`; false while another op holds it. */
  claim: (opId: string) => boolean
  /** Frees the lock if `opId` holds it. */
  release: (opId: string) => void
  holder: () => string | null
}

export function createRunLock(onChange: (holder: string | null) => void = () => {}): RunLock {
  let holder: string | null = null
  return {
    claim: (opId) => {
      if (holder !== null) return false
      holder = opId
      onChange(holder)
      return true
    },
    release: (opId) => {
      if (holder !== opId) return
      holder = null
      onChange(holder)
    },
    holder: () => holder,
  }
}

// ─── Setup card ───────────────────────────────────────────────────────────────

export type SetupCard =
  | { phase: 'hidden' }
  | { phase: 'checking' }
  | { phase: 'confirm', missing: SetupStep[], downloadBytes: number | null }
  | { phase: 'installing', missing: SetupStep[], downloadBytes: number | null, step: SetupStep | null, event: SseEvent }
  | { phase: 'error', missing: SetupStep[], downloadBytes: number | null, message: string }

export const HIDDEN_CARD: SetupCard = { phase: 'hidden' }

const STEPS: readonly SetupStep[] = ['runtime', 'model']

function knownSteps(missing: unknown): SetupStep[] {
  return Array.isArray(missing) ? STEPS.filter((s) => missing.includes(s)) : []
}

/** What the card shows for a status: nothing when the op is ready, else the download offer. */
export function cardForStatus(status: ImageOpStatus): SetupCard {
  if (status.ready) return HIDDEN_CARD
  const bytes = typeof status.download_bytes === 'number' && status.download_bytes > 0 ? status.download_bytes : null
  return { phase: 'confirm', missing: knownSteps(status.missing), downloadBytes: bytes }
}

function setupOf(card: SetupCard): { missing: SetupStep[], downloadBytes: number | null } {
  return 'missing' in card ? { missing: card.missing, downloadBytes: card.downloadBytes } : { missing: [], downloadBytes: null }
}

/** The card once the download starts (before the first frame arrives). */
export function startInstall(card: SetupCard): SetupCard {
  const setup = setupOf(card)
  return { phase: 'installing', ...setup, step: setup.missing[0] ?? null, event: { percent: 0, status: 'Starting…' } }
}

/** Folds one SSE frame of the prepare stream into the card. */
export function applyPrepareEvent(card: SetupCard, event: PrepareEvent): SetupCard {
  const setup = setupOf(card)
  if (event.error) return { phase: 'error', ...setup, message: event.error }
  if (event.cancelled) return { phase: 'error', ...setup, message: 'The download was cancelled.' }
  const previous = card.phase === 'installing' ? card.step : null
  const step = event.step && STEPS.includes(event.step) ? event.step : previous ?? setup.missing[0] ?? null
  return { phase: 'installing', ...setup, step, event }
}

/** The card when the stream failed outright (backend gone, HTTP error). */
export function failInstall(card: SetupCard, message: string): SetupCard {
  return { phase: 'error', ...setupOf(card), message }
}

const STEP_LABELS: Record<SetupStep, string> = {
  runtime: 'Installing the runtime',
  model: 'Downloading the model',
}

/** "Step 1 of 2 · Installing the runtime", or null when the step is unknown. */
export function stepLabel(card: SetupCard): string | null {
  if (card.phase !== 'installing' || !card.step) return null
  const label = STEP_LABELS[card.step]
  const total = card.missing.length
  const index = card.missing.indexOf(card.step)
  return total > 1 && index >= 0 ? `Step ${index + 1} of ${total} · ${label}` : label
}

/** "~200 MB" (rounded to what a person reads), or null when unknown. */
export function approxSize(bytes: number | null): string | null {
  if (bytes == null || bytes <= 0) return null
  const mb = bytes / 1e6
  if (mb >= 1000) return `~${(mb / 1000).toFixed(1)} GB`
  return `~${Math.max(1, Math.round(mb / 10) * 10 || Math.round(mb))} MB`
}

// ─── Copy ─────────────────────────────────────────────────────────────────────

interface OpCopy {
  /** Subject of the setup sentence ("Background removal needs…"). */
  noun: string
  /** Shown on the button while the op runs. */
  running: string
  /** Extra line under the download offer. */
  note?: string
}

const OP_COPY: Record<string, OpCopy> = {
  remove_background: { noun: 'Background removal', running: 'Removing background…', note: 'It runs on your CPU, no GPU needed.' },
  crop: { noun: 'Crop', running: 'Cropping…' },
  auto_frame: { noun: 'Auto-frame', running: 'Framing…' },
}

export function opCopy(op: Pick<ImageOpDescriptor, 'id' | 'label'>): OpCopy {
  return OP_COPY[op.id] ?? { noun: op.label, running: `${op.label}…` }
}

/** The download offer's sentence. */
export function setupMessage(op: Pick<ImageOpDescriptor, 'id' | 'label'>, downloadBytes: number | null): string {
  const copy = opCopy(op)
  const size = approxSize(downloadBytes)
  const first = `${copy.noun} needs a one-time download${size ? ` (${size})` : ''}.`
  return copy.note ? `${first} ${copy.note}` : first
}

// ─── Model view ───────────────────────────────────────────────────────────────

/**
 * Caption of the "what the model sees" view. Generate uploads the file's
 * bytes unchanged, so its own size is what the generator receives; a
 * non-square image is then cropped or padded by each generator its own way.
 */
export function modelViewCaption(width: number, height: number): string {
  const size = `${width} × ${height} px`
  if (width === height) return `${size} · sent to Generate as is`
  return `${size} · not square: each generator crops or pads it its own way. Auto-frame makes it square.`
}

// ─── API errors ───────────────────────────────────────────────────────────────

/** Whether the error is a 403 `{detail:{code:'outside_workspace'}}`: the input must be copied into the workspace first. */
export function isOutsideWorkspace(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const response = (err as { response?: { status?: number, data?: { detail?: unknown } } }).response
  if (response?.status !== 403) return false
  const detail = response.data?.detail
  return Boolean(detail && typeof detail === 'object' && (detail as { code?: unknown }).code === 'outside_workspace')
}

/** The missing steps of a 409 `{detail:{code:'not_ready', missing}}`, or null for any other error. */
export function notReadyMissing(err: unknown): SetupStep[] | null {
  if (!err || typeof err !== 'object') return null
  const response = (err as { response?: { status?: number, data?: { detail?: unknown } } }).response
  if (response?.status !== 409) return null
  const detail = response.data?.detail
  if (!detail || typeof detail !== 'object' || (detail as { code?: unknown }).code !== 'not_ready') return null
  return knownSteps((detail as { missing?: unknown }).missing)
}

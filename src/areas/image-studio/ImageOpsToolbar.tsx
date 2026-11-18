import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '@shared/stores/appStore'
import { ParamFields } from '@shared/components/ui/ParamFields'
import { SseProgressBar } from '@shared/components/ui/SseProgressBar'
import { defaultParamValues } from '@areas/generate/meshEditPanel'
import type { StudioImage } from './imageStudioStore'
import {
  HIDDEN_CARD,
  applyPrepareEvent,
  cardForStatus,
  createRunLock,
  failInstall,
  isTextField,
  opCopy,
  runInputFor,
  setupMessage,
  startInstall,
  stepLabel,
  type ImageOpDescriptor,
  type RunLock,
  type SetupCard,
} from './imageOps'
import { ImageOpIcon } from './imageOpIcons'
import { ImageOpNotReadyError, getImageOpStatus, listImageOps, prepareImageOp, runImageOpOnFile } from './imageOpsApi'

// Image operations served by the backend (GET /image/ops: background removal,
// …). A run reads an image and writes a NEW file; the page adds it to the
// history with the image it came from as its source. The originals are never
// modified. An op that needs a one-time download offers it on first use.

export interface ImageOpResult {
  op: string
  path: string
  maskPath?: string
}

/** Entries the canvas shows as busy while an op runs, and what it is doing. */
export interface ImageOpActivity {
  ids: string[]
  label: string
}

interface ToolbarProps {
  entries: StudioImage[]
  selected: StudioImage
  onResult: (result: ImageOpResult, source: StudioImage) => Promise<void>
  onActivity: (activity: ImageOpActivity | null) => void
  /** Id of the op whose options show, or null when no tool is open. */
  activeTool: string | null
  onActiveToolChange: (id: string | null) => void
  /** The options bar under the header: the active op renders its options there. */
  optionsSlot: HTMLElement | null
  /** A layer over the canvas image, for a tool that draws on it (crop). */
  overlaySlot: HTMLElement | null
}

const BUTTON_CLASS =
  'flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-700 hover:text-zinc-100 disabled:opacity-50'

const ICON_BUTTON_CLASS =
  'flex h-8 w-8 items-center justify-center rounded-lg border transition-colors disabled:cursor-not-allowed disabled:opacity-40'

function Spinner({ size = 14 }: { size?: number }): JSX.Element {
  return (
    <svg className="animate-spin" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  )
}

/** One icon per op in the header; hidden when the backend is unreachable or serves no image ops. */
export default function ImageOpsToolbar(props: ToolbarProps): JSX.Element | null {
  const { activeTool, onActiveToolChange } = props
  const apiUrl = useAppStore((s) => s.apiUrl)
  const [ops, setOps] = useState<ImageOpDescriptor[]>([])
  const [runningOp, setRunningOp] = useState<string | null>(null)
  const [lock] = useState(() => createRunLock(setRunningOp))

  useEffect(() => {
    if (!apiUrl) { setOps([]); return }
    let cancelled = false
    listImageOps()
      .then((list) => { if (!cancelled) setOps(list) })
      .catch(() => { if (!cancelled) setOps([]) })
    return () => { cancelled = true }
  }, [apiUrl])

  // The active op left the list (backend reloaded or unreachable): close it.
  useEffect(() => {
    if (activeTool !== null && !ops.some((op) => op.id === activeTool)) onActiveToolChange(null)
  }, [ops, activeTool, onActiveToolChange])

  // Esc closes the active tool, unless the user is typing in a field.
  useEffect(() => {
    if (activeTool === null) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isTextField(event.target)) return
      onActiveToolChange(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeTool, onActiveToolChange])

  if (ops.length === 0) return null
  return (
    <div className="flex items-center gap-1">
      {ops.map((op) => (
        <ImageOpControl key={op.id} op={op} lock={lock} blocked={runningOp !== null && runningOp !== op.id} {...props} />
      ))}
      <span className="mx-2 h-5 w-px bg-zinc-800" aria-hidden="true" />
    </div>
  )
}

/** What a run processes: the input file, the entry selected when it was asked, and its params when they override the options bar's. */
interface RunTarget {
  input: StudioImage
  selectedId: string
  params?: Record<string, unknown>
}

/**
 * One op: its header icon and, while it is the active tool, its options in
 * the options bar. All of the op's state (params, setup download, readiness)
 * lives here, so closing and reopening the tool keeps it.
 */
function ImageOpControl(props: ToolbarProps & {
  op: ImageOpDescriptor
  /** Shared by all the ops: one runs at a time. */
  lock: RunLock
  /** Another op is running. */
  blocked: boolean
}): JSX.Element {
  const { op, lock, blocked, entries, selected, onResult, onActivity, activeTool, onActiveToolChange, optionsSlot } = props
  const showError = useAppStore((s) => s.showError)
  const showToast = useAppStore((s) => s.showToast)
  const [params, setParams] = useState<Record<string, unknown>>(() => defaultParamValues(op.params_schema))
  /** The params as they are now: a run that waits for the setup download reads them when it starts, not when Download was clicked. */
  const paramsRef = useRef(params)
  paramsRef.current = params
  const [card, setCard] = useState<SetupCard>(HIDDEN_CARD)
  const [running, setRunning] = useState(false)
  /** Set once the op answered ready, so later clicks skip the status check. */
  const ready = useRef(false)
  /** The run the user asked for, kept across the setup download. */
  const pending = useRef<RunTarget | null>(null)
  const copy = opCopy(op)
  const active = activeTool === op.id

  // Closing the tool drops a download offer not taken up; an install under way keeps going.
  useEffect(() => {
    if (active) return
    if (card.phase === 'confirm' || card.phase === 'error') {
      pending.current = null
      setCard(HIDDEN_CARD)
    }
  }, [active, card.phase])

  /** True when a result was added to the history. */
  async function run(target: RunTarget): Promise<boolean> {
    const { input, selectedId } = target
    if (!lock.claim(op.id)) {
      showToast('Wait for the current image operation to finish')
      return false
    }
    setRunning(true)
    onActivity({ ids: [selectedId, input.id], label: copy.running })
    try {
      const result = await runImageOpOnFile(op.id, input.path, target.params ?? paramsRef.current)
      await onResult({ op: op.id, path: result.path, maskPath: result.maskPath }, input)
      return true
    } catch (err) {
      if (err instanceof ImageOpNotReadyError) {
        ready.current = false
        pending.current = target
        await checkSetup()
      } else {
        showError(err instanceof Error ? err.message : String(err))
      }
      return false
    } finally {
      setRunning(false)
      onActivity(null)
      lock.release(op.id)
    }
  }

  /** Shows the download offer when needed; true when the op can run now. */
  async function checkSetup(): Promise<boolean> {
    setCard({ phase: 'checking' })
    try {
      const next = cardForStatus(await getImageOpStatus(op.id))
      setCard(next)
      ready.current = next.phase === 'hidden'
      return ready.current
    } catch (err) {
      setCard(HIDDEN_CARD)
      showError(err instanceof Error ? err.message : String(err))
      return false
    }
  }

  /**
   * Runs the op on the selected image, with `override` as its params when
   * given (else the options bar's). True when a result was added; false when
   * it did not run, failed, or now waits for the one-time download (the run
   * then happens, with the same params, once the download is done).
   */
  async function start(override?: Record<string, unknown>): Promise<boolean> {
    if (running || card.phase === 'installing' || card.phase === 'checking') return false
    const target: RunTarget = { input: runInputFor(entries, selected, op.id), selectedId: selected.id, params: override }
    pending.current = target
    if (ready.current || await checkSetup()) return run(target)
    return false
  }

  async function download() {
    setCard((c) => startInstall(c))
    let failed = false
    try {
      await prepareImageOp(op.id, (event) => {
        if (event.error || event.cancelled) failed = true
        setCard((c) => applyPrepareEvent(c, event))
      })
    } catch (err) {
      failed = true
      setCard((c) => failInstall(c, err instanceof Error ? err.message : String(err)))
    }
    if (failed) return

    // The stream ended cleanly: confirm with the backend before running.
    try {
      const status = await getImageOpStatus(op.id)
      if (!status.ready) {
        setCard((c) => failInstall(c, 'The setup did not finish. Try again.'))
        return
      }
    } catch (err) {
      setCard((c) => failInstall(c, err instanceof Error ? err.message : String(err)))
      return
    }
    ready.current = true
    setCard(HIDDEN_CARD)
    const target = pending.current
    pending.current = null
    if (target) await run(target)
  }

  const busy = running || blocked || card.phase === 'checking' || card.phase === 'installing'

  const genericOptions = (
    <>
      <span className="shrink-0 text-xs font-medium text-zinc-200">{op.label}</span>
      <ParamFields
        schema={op.params_schema}
        values={params}
        onChange={(id, value) => setParams((current) => ({ ...current, [id]: value }))}
        disabled={running}
        className="flex flex-wrap items-center gap-3 [&>*]:w-52"
      />
      <button type="button" onClick={() => { void start() }} disabled={busy} aria-busy={running} className={`ml-auto ${BUTTON_CLASS}`}>
        {running ? <><Spinner /> {copy.running}</> : 'Apply'}
      </button>
    </>
  )

  // CROP_UI: crop is the one op with its own UI. Task 4 replaces this branch with
  //   <CropTool start={start} running={running} busy={busy} optionsSlot={optionsSlot}
  //     overlaySlot={props.overlaySlot} onActiveToolChange={onActiveToolChange} />
  // Until then crop falls through to the generic options.
  const options = op.id === 'crop' ? genericOptions : genericOptions

  return (
    <>
      <button type="button" onClick={() => onActiveToolChange(active ? null : op.id)}
        disabled={blocked} aria-pressed={active} aria-busy={running} title={op.label} aria-label={op.label}
        className={`${ICON_BUTTON_CLASS} ${active ? 'border-accent bg-accent/20 text-accent-light' : 'border-transparent text-zinc-400 hover:border-zinc-700 hover:bg-zinc-900/60 hover:text-zinc-100'}`}>
        {running ? <Spinner size={16} /> : <ImageOpIcon opId={op.id} />}
      </button>

      {active && optionsSlot && createPortal(
        <>
          {options}
          {card.phase !== 'hidden' && card.phase !== 'checking' && (
            <SetupCardView
              card={card}
              message={setupMessage(op, card.downloadBytes)}
              onDownload={() => { void download() }}
              onClose={() => { pending.current = null; setCard(HIDDEN_CARD) }}
            />
          )}
        </>,
        optionsSlot,
      )}
    </>
  )
}

function SetupCardView({ card, message, onDownload, onClose }: {
  card: Exclude<SetupCard, { phase: 'hidden' | 'checking' }>
  message: string
  onDownload: () => void
  onClose: () => void
}): JSX.Element {
  return (
    <div role="dialog" aria-label="One-time download"
      className="absolute top-full right-0 z-30 mt-2 flex w-80 flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-900 p-3.5 shadow-xl shadow-black/40">
      {card.phase === 'confirm' && (
        <>
          <p className="text-xs leading-relaxed text-zinc-300">{message}</p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:text-zinc-100">
              Cancel
            </button>
            <button type="button" onClick={onDownload}
              className="rounded-lg bg-accent px-3.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-accent-dark">
              Download
            </button>
          </div>
        </>
      )}
      {card.phase === 'installing' && (
        <>
          <p className="text-xs font-medium text-zinc-200">{stepLabel(card) ?? 'Setting up…'}</p>
          <SseProgressBar event={card.event} />
          <p className="text-[11px] text-zinc-500">This happens once. It will run as soon as it is done.</p>
        </>
      )}
      {card.phase === 'error' && (
        <>
          <p role="alert" className="text-xs leading-relaxed text-red-300">{card.message}</p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:text-zinc-100">
              Close
            </button>
            <button type="button" onClick={onDownload}
              className="rounded-lg bg-accent px-3.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-accent-dark">
              Retry
            </button>
          </div>
        </>
      )}
    </div>
  )
}

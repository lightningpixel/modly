import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '@shared/stores/appStore'
import { ParamFields } from '@shared/components/ui/ParamFields'
import { SseProgressBar } from '@shared/components/ui/SseProgressBar'
import { defaultParamValues } from '@areas/generate/meshEditPanel'
import type { StudioImage } from './imageStudioStore'
import {
  HIDDEN_CARD,
  applyPrepareEvent,
  cardForStatus,
  failInstall,
  opCopy,
  runInputFor,
  setupMessage,
  startInstall,
  stepLabel,
  type ImageOpDescriptor,
  type SetupCard,
} from './imageOps'
import { ImageOpNotReadyError, getImageOpStatus, listImageOps, prepareImageOp, runImageOp } from './imageOpsApi'

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
}

const BUTTON_CLASS =
  'flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-700 hover:text-zinc-100 disabled:opacity-50'

function Spinner({ size = 14 }: { size?: number }): JSX.Element {
  return (
    <svg className="animate-spin" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  )
}

function WandIcon(): JSX.Element {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8 19 13M17.8 6.2 19 5M3 21l9-9M12.2 6.2 11 5" />
    </svg>
  )
}

/** Hidden when the backend is unreachable or serves no image ops. */
export default function ImageOpsToolbar(props: ToolbarProps): JSX.Element | null {
  const apiUrl = useAppStore((s) => s.apiUrl)
  const [ops, setOps] = useState<ImageOpDescriptor[]>([])

  useEffect(() => {
    if (!apiUrl) { setOps([]); return }
    let cancelled = false
    listImageOps()
      .then((list) => { if (!cancelled) setOps(list) })
      .catch(() => { if (!cancelled) setOps([]) })
    return () => { cancelled = true }
  }, [apiUrl])

  if (ops.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-3">
      {ops.map((op) => <ImageOpControl key={op.id} op={op} {...props} />)}
    </div>
  )
}

function ImageOpControl({ op, entries, selected, onResult, onActivity }: ToolbarProps & { op: ImageOpDescriptor }): JSX.Element {
  const showError = useAppStore((s) => s.showError)
  const [params, setParams] = useState<Record<string, unknown>>(() => defaultParamValues(op.params_schema))
  const [card, setCard] = useState<SetupCard>(HIDDEN_CARD)
  const [running, setRunning] = useState(false)
  /** Set once the op answered ready, so later clicks skip the status check. */
  const ready = useRef(false)
  /** The image the user asked to process, kept across the setup download. */
  const pending = useRef<{ input: StudioImage, selectedId: string } | null>(null)
  const copy = opCopy(op)

  async function run(input: StudioImage, selectedId: string) {
    setRunning(true)
    onActivity({ ids: [selectedId, input.id], label: copy.running })
    try {
      const result = await runImageOp(op.id, input.path, params)
      await onResult({ op: op.id, path: result.path, maskPath: result.maskPath }, input)
    } catch (err) {
      if (err instanceof ImageOpNotReadyError) {
        ready.current = false
        pending.current = { input, selectedId }
        await checkSetup()
      } else {
        showError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setRunning(false)
      onActivity(null)
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

  async function start() {
    if (running || card.phase === 'installing' || card.phase === 'checking') return
    const target = { input: runInputFor(entries, selected, op.id), selectedId: selected.id }
    pending.current = target
    if (ready.current || await checkSetup()) await run(target.input, target.selectedId)
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
    if (target) await run(target.input, target.selectedId)
  }

  const busy = running || card.phase === 'checking' || card.phase === 'installing'

  return (
    <div className="relative flex items-center gap-2">
      <ParamFields
        schema={op.params_schema}
        values={params}
        onChange={(id, value) => setParams((current) => ({ ...current, [id]: value }))}
        disabled={running}
        // Crop's four edges sit in two columns to keep the header short.
        className={op.params_schema.length > 2 ? 'grid w-80 grid-cols-2 gap-x-3 gap-y-1' : 'flex w-52 flex-col gap-1'}
      />
      <button type="button" onClick={() => { void start() }} disabled={busy} aria-busy={running} className={BUTTON_CLASS}>
        {running ? <><Spinner /> {copy.running}</> : <><WandIcon /> {op.label}</>}
      </button>

      {card.phase !== 'hidden' && card.phase !== 'checking' && (
        <SetupCardView
          card={card}
          message={setupMessage(op, card.downloadBytes)}
          onDownload={() => { void download() }}
          onClose={() => { pending.current = null; setCard(HIDDEN_CARD) }}
        />
      )}
    </div>
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

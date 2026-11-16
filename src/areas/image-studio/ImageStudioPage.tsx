import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { useAppStore } from '@shared/stores/appStore'
import { useNavStore } from '@shared/stores/navStore'
import { SUPPORTED_IMAGE_TYPES, saveImageToWorkspace, takePastedImage, useImageHandoff } from '@shared/utils/imageInput'
import { mimeFromPath } from '@areas/workflows/nodes/imageUtils'
import { fileNameOf, findByPath, sourceOf, useImageStudioStore, type StudioImage } from './imageStudioStore'

// ─── Icons ────────────────────────────────────────────────────────────────────

function Icon({ d, size = 16 }: { d: string, size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

const ICONS = {
  upload:   'M12 16V4m0 0-4.5 4.5M12 4l4.5 4.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3',
  folder:   'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  generate: 'M12 2 3 7v10l9 5 9-5V7zM3 7l9 5 9-5M12 12v10',
  close:    'M6 6l12 12M18 6 6 18',
}

const PASTE_HINT = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform) ? '⌘V' : 'Ctrl+V'

/** Transparent pixels show as a checkerboard, as in image editors. */
const CHECKERBOARD: CSSProperties = {
  backgroundColor: '#18181b',
  backgroundImage: 'repeating-conic-gradient(#27272a 0% 25%, transparent 0% 50%)',
  backgroundSize: '20px 20px',
}

// ─── Loading images ───────────────────────────────────────────────────────────

/** An object URL of an image file on disk (the renderer cannot read file:// in dev). */
async function previewUrlForPath(path: string): Promise<string> {
  const base64 = await window.electron.fs.readFileBase64(path)
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  return URL.createObjectURL(new Blob([bytes], { type: mimeFromPath(path) }))
}

// ─── Image operations (slot) ──────────────────────────────────────────────────
// Image operations (background removal, … — ticket #421) plug in here. An
// operation reads the selected image and writes a NEW file; the page adds it
// to the history with the selected image as its source, so the canvas shows
// the result before/after against it. The originals are never modified.

interface ImageOp {
  id: string
  label: string
  icon: string
  /** Produces a new image file from `image` and returns its absolute path. */
  run: (image: StudioImage) => Promise<string>
}

const IMAGE_OPS: readonly ImageOp[] = []

function ImageOpsToolbar({ image, onResult }: { image: StudioImage, onResult: (path: string, source: StudioImage) => Promise<void> }): JSX.Element | null {
  const showError = useAppStore((s) => s.showError)
  const [running, setRunning] = useState<string | null>(null)
  if (IMAGE_OPS.length === 0) return null

  async function run(op: ImageOp) {
    setRunning(op.id)
    try {
      await onResult(await op.run(image), image)
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(null)
    }
  }

  return (
    <div className="flex items-center gap-1.5">
      {IMAGE_OPS.map((op) => (
        <button key={op.id} type="button" disabled={running !== null} onClick={() => { void run(op) }}
          className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-700 hover:text-zinc-100 disabled:opacity-50">
          <Icon d={op.icon} size={14} />
          {running === op.id ? 'Working…' : op.label}
        </button>
      ))}
    </div>
  )
}

// ─── Canvas ───────────────────────────────────────────────────────────────────

function CompareView({ before, after }: { before: StudioImage, after: StudioImage }): JSX.Element {
  const [position, setPosition] = useState(50)
  const box = useRef<HTMLDivElement>(null)

  const moveTo = (clientX: number) => {
    const rect = box.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return
    setPosition(Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100)))
  }

  return (
    <div
      ref={box}
      className="relative h-full w-full cursor-ew-resize select-none touch-none"
      onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); moveTo(event.clientX) }}
      onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) moveTo(event.clientX) }}
      role="slider"
      aria-label="Before / after"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(position)}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') setPosition((p) => Math.max(0, p - 5))
        if (event.key === 'ArrowRight') setPosition((p) => Math.min(100, p + 5))
      }}
    >
      <img src={after.previewUrl} alt={after.name} draggable={false} className="absolute inset-0 h-full w-full object-contain" />
      <img src={before.previewUrl} alt={before.name} draggable={false} className="absolute inset-0 h-full w-full object-contain"
        style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }} />
      <div className="pointer-events-none absolute inset-y-0 w-px bg-white/80 shadow-[0_0_0_1px_rgba(0,0,0,0.3)]" style={{ left: `${position}%` }}>
        <span className="absolute top-1/2 left-1/2 flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/70 bg-zinc-900/80 text-white">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m9 6-6 6 6 6M15 6l6 6-6 6" />
          </svg>
        </span>
      </div>
      <span className="pointer-events-none absolute top-3 left-3 rounded-md bg-zinc-950/70 px-2 py-0.5 text-[11px] font-medium text-zinc-300">Before</span>
      <span className="pointer-events-none absolute top-3 right-3 rounded-md bg-zinc-950/70 px-2 py-0.5 text-[11px] font-medium text-zinc-300">After</span>
    </div>
  )
}

function Canvas({ image, source }: { image: StudioImage, source?: StudioImage }): JSX.Element {
  return (
    <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-zinc-800" style={CHECKERBOARD}>
      {source
        ? <CompareView key={image.id} before={source} after={image} />
        : <img src={image.previewUrl} alt={image.name} draggable={false} className="absolute inset-0 h-full w-full object-contain" />}
    </div>
  )
}

function EmptyCanvas({ busy, onBrowse }: { busy: boolean, onBrowse: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onBrowse}
      disabled={busy}
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-zinc-800 bg-zinc-900/30 px-6 text-center transition-colors hover:border-zinc-700 hover:bg-zinc-900/60 disabled:cursor-wait"
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-zinc-800/80 text-zinc-400">
        <Icon d={ICONS.upload} size={22} />
      </span>
      <span>
        <span className="block text-[15px] font-medium text-zinc-100">{busy ? 'Adding image…' : 'Drop, paste or choose an image'}</span>
        <span className="mt-1 block text-xs text-zinc-500">
          <kbd className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-px font-sans text-[11px] text-zinc-300">{PASTE_HINT}</kbd> to paste · PNG, JPG, WEBP
        </span>
      </span>
    </button>
  )
}

// ─── History strip ────────────────────────────────────────────────────────────

function HistoryStrip({ entries, selectedId, onSelect, onRemove }: {
  entries: StudioImage[]
  selectedId: string | null
  onSelect: (id: string) => void
  onRemove: (id: string) => void
}): JSX.Element {
  return (
    <div className="flex shrink-0 gap-2 overflow-x-auto pb-1">
      {entries.map((entry) => {
        const selected = entry.id === selectedId
        return (
          <div key={entry.id} className="group relative shrink-0">
            <button type="button" onClick={() => onSelect(entry.id)} title={entry.path}
              className={`block h-16 w-16 overflow-hidden rounded-lg border-2 transition-colors ${selected ? 'border-accent' : 'border-zinc-800 hover:border-zinc-600'}`}
              style={CHECKERBOARD}>
              <img src={entry.previewUrl} alt={entry.name} draggable={false} className="h-full w-full object-contain" />
            </button>
            {entry.sourceId && (
              <span className="pointer-events-none absolute bottom-1 left-1 rounded bg-zinc-950/80 px-1 text-[9px] font-medium text-accent-light">edit</span>
            )}
            <button type="button" onClick={() => onRemove(entry.id)} title="Remove from history (the file stays on disk)" aria-label={`Remove ${entry.name} from history`}
              className="absolute -top-1.5 -right-1.5 hidden h-5 w-5 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900 text-zinc-400 hover:text-zinc-100 group-hover:flex focus-visible:flex">
              <Icon d={ICONS.close} size={11} />
            </button>
          </div>
        )
      })}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ImageStudioPage(): JSX.Element {
  const navigate = useNavStore((s) => s.navigate)
  const showError = useAppStore((s) => s.showError)
  const showToast = useAppStore((s) => s.showToast)
  const entries = useImageStudioStore((s) => s.entries)
  const selectedId = useImageStudioStore((s) => s.selectedId)
  const { add, select, remove } = useImageStudioStore.getState()
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)

  const selected = entries.find((e) => e.id === selectedId)
  const source = sourceOf(entries, selected)

  /** An image already on disk: used where it is, not copied. */
  const addPath = useCallback(async (path: string, sourceImage?: StudioImage) => {
    const existing = sourceImage ? undefined : findByPath(useImageStudioStore.getState().entries, path)
    if (existing) {
      select(existing.id)
      return
    }
    const previewUrl = await previewUrlForPath(path)
    add({ path, previewUrl, name: fileNameOf(path), sourceId: sourceImage?.id })
  }, [add, select])

  /** Image bytes with no file behind them (clipboard, browser drag): saved to the workspace first. */
  const addBlob = useCallback(async (file: File, name: string) => {
    const path = await saveImageToWorkspace(file, name)
    add({ path, previewUrl: URL.createObjectURL(file), name: fileNameOf(path) })
  }, [add])

  const runImport = useCallback(async (work: () => Promise<void>) => {
    setBusy(true)
    try {
      await work()
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Could not add the image.')
    } finally {
      setBusy(false)
    }
  }, [showError])

  const browse = useCallback(() => {
    void runImport(async () => {
      const path = await window.electron.fs.selectImage()
      if (path) await addPath(path)
    })
  }, [runImport, addPath])

  const importFile = useCallback((file: File | undefined) => {
    if (!file) return
    if (!SUPPORTED_IMAGE_TYPES.has(file.type)) {
      showToast('Only PNG, JPG and WEBP images are supported')
      return
    }
    const path = window.electron.fs.getPathForFile(file)
    void runImport(() => (path ? addPath(path) : addBlob(file, file.name || 'dropped-image')))
  }, [runImport, addPath, addBlob, showToast])

  // Ctrl+V anywhere on the page, unless the focus is in a text field.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const file = takePastedImage(event)
      if (file) void runImport(() => addBlob(file, 'pasted-image'))
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [runImport, addBlob])

  function sendToGenerate(image: StudioImage) {
    useImageHandoff.getState().offer(image.path)
    navigate('generate')
  }

  async function revealInFolder(image: StudioImage) {
    const result = await window.electron.workspace.images.reveal(image.path)
    if (!result.success) showToast(result.error ?? 'Could not show the file')
  }

  return (
    <div
      className="relative flex min-w-0 flex-1 flex-col gap-4 px-6 py-5"
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDragging(true) }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false) }}
      onDrop={(event) => {
        event.preventDefault()
        setDragging(false)
        importFile(event.dataTransfer.files[0])
      }}
    >
      <header className="flex shrink-0 flex-wrap items-center gap-3">
        <div className="mr-auto min-w-0">
          <h1 className="text-[15px] font-semibold text-zinc-100">Image Studio</h1>
          <p className="truncate text-xs text-zinc-500" title={selected?.path}>
            {selected ? selected.name : <>Prepare an image before turning it into 3D · <span className="text-zinc-400">{PASTE_HINT}</span> to paste</>}
          </p>
        </div>

        {selected && <ImageOpsToolbar image={selected} onResult={addPath} />}

        <button type="button" onClick={browse} disabled={busy}
          className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-700 hover:text-zinc-100 disabled:opacity-50">
          <Icon d={ICONS.upload} size={14} />
          {busy ? 'Adding…' : 'Add image'}
        </button>
        {selected && (
          <button type="button" onClick={() => { void revealInFolder(selected) }}
            className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-700 hover:text-zinc-100">
            <Icon d={ICONS.folder} size={14} />
            Show in folder
          </button>
        )}
        <button type="button" onClick={() => { if (selected) sendToGenerate(selected) }} disabled={!selected}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-accent-dark disabled:cursor-not-allowed disabled:opacity-40">
          <Icon d={ICONS.generate} size={14} />
          Send to Generate
        </button>
      </header>

      {selected ? <Canvas image={selected} source={source} /> : <EmptyCanvas busy={busy} onBrowse={browse} />}

      {entries.length > 0 && (
        <section className="shrink-0">
          <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-zinc-500">This session</h2>
          <HistoryStrip entries={entries} selectedId={selectedId} onSelect={select} onRemove={remove} />
        </section>
      )}

      {dragging && (
        <div className="pointer-events-none absolute inset-3 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent bg-accent/10">
          <span className="rounded-lg bg-zinc-950/80 px-3 py-1.5 text-sm font-medium text-zinc-100">Drop to add the image</span>
        </div>
      )}
    </div>
  )
}

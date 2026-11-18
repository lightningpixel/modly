import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { useAppStore } from '@shared/stores/appStore'
import { useNavStore } from '@shared/stores/navStore'
import { SUPPORTED_IMAGE_TYPES, saveImageToWorkspace, takePastedImage, useImageHandoff } from '@shared/utils/imageInput'
import { mimeFromPath } from '@areas/workflows/nodes/imageUtils'
import { fileNameOf, findByPath, useImageStudioStore, type StudioImage } from './imageStudioStore'
import ImageOpsToolbar, { type ImageOpActivity, type ImageOpResult } from './ImageOpsToolbar'
import { modelViewCaption } from './imageOps'

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

const ICON_BUTTON_CLASS =
  'flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900/60 text-zinc-300 transition-colors hover:border-zinc-700 hover:text-zinc-100 disabled:opacity-50'

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

// ─── Canvas ───────────────────────────────────────────────────────────────────

/** Object URL of the mask file while `path` is set; revoked when it changes. */
function useMaskPreview(path: string | undefined): { url: string | null, failed: boolean } {
  const [state, setState] = useState<{ path: string, url: string | null, failed: boolean } | null>(null)
  useEffect(() => {
    if (!path) return
    let cancelled = false
    let created: string | null = null
    previewUrlForPath(path)
      .then((url) => {
        if (cancelled) { URL.revokeObjectURL(url); return }
        created = url
        setState({ path, url, failed: false })
      })
      .catch(() => { if (!cancelled) setState({ path, url: null, failed: true }) })
    return () => {
      cancelled = true
      if (created) URL.revokeObjectURL(created)
      // Forget the revoked URL: showing the same mask again must load it anew.
      setState(null)
    }
  }, [path])
  return state && state.path === path ? state : { url: null, failed: false }
}

/**
 * What the model sees: the file exactly as Generate uploads it, at its own
 * resolution (never enlarged), with its edges outlined so the margins show.
 */
function ModelView({ image }: { image: StudioImage }): JSX.Element {
  const [size, setSize] = useState<{ url: string, width: number, height: number } | null>(null)
  const known = size?.url === image.previewUrl ? size : null
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-zinc-950 px-4 pt-4 pb-10">
      <div className="flex min-h-0 w-full flex-1 items-center justify-center">
        {/* max-width/max-height keep the aspect ratio, so the outline is the image's edge. */}
        <img src={image.previewUrl} alt={`${image.name} as the model sees it`} draggable={false}
          onLoad={(e) => setSize({ url: image.previewUrl, width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
          className="max-h-full max-w-full outline outline-1 outline-accent/70"
          style={CHECKERBOARD} />
      </div>
      {known && <span className="shrink-0 text-[11px] text-zinc-400">{modelViewCaption(known.width, known.height)}</span>}
    </div>
  )
}

function Canvas({ image, activity, hideToggles, onOverlaySlot }: {
  image: StudioImage
  activity: string | null
  /** A tool draws over the image (crop): the view toggles would sit in its way. */
  hideToggles: boolean
  /** Receives the layer over the image that the active tool can draw into. */
  onOverlaySlot: (element: HTMLDivElement | null) => void
}): JSX.Element {
  const [maskFor, setMaskFor] = useState<string | null>(null)
  const [modelView, setModelView] = useState(false)
  // With the toggles hidden, so is what they switch: the tool works on the plain image.
  const showMask = !hideToggles && Boolean(image.maskPath) && maskFor === image.id
  const showModelView = !hideToggles && modelView
  const mask = useMaskPreview(showMask ? image.maskPath : undefined)

  let content: JSX.Element
  if (showMask) {
    content = mask.url
      ? <img src={mask.url} alt={`Mask of ${image.name}`} draggable={false} className="absolute inset-0 h-full w-full object-contain" />
      : <span className="absolute inset-0 flex items-center justify-center text-xs text-zinc-500">{mask.failed ? 'Could not load the mask' : 'Loading mask…'}</span>
  } else if (showModelView) {
    content = <ModelView image={image} />
  } else {
    content = <img src={image.previewUrl} alt={image.name} draggable={false} className="absolute inset-0 h-full w-full object-contain" />
  }

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-zinc-800" style={CHECKERBOARD}>
      {content}
      <div ref={onOverlaySlot} className="absolute inset-0 empty:hidden" />
      {!hideToggles && <button type="button" aria-pressed={modelView} onClick={() => setModelView(!modelView)}
        title={modelView ? 'Show the image fitted to the canvas' : 'Show the image exactly as Generate sends it to the model'}
        className={`absolute left-3 bottom-3 rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors ${modelView ? 'border-accent bg-accent/20 text-accent-light' : 'border-zinc-700 bg-zinc-950/70 text-zinc-300 hover:text-zinc-100'}`}>
        What the model sees
      </button>}
      {!hideToggles && image.maskPath && (
        <button type="button" aria-pressed={showMask} onClick={() => setMaskFor(showMask ? null : image.id)}
          title={showMask ? 'Show the image' : 'Show the mask the cut-out was made from'}
          className={`absolute right-3 bottom-3 rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors ${showMask ? 'border-accent bg-accent/20 text-accent-light' : 'border-zinc-700 bg-zinc-950/70 text-zinc-300 hover:text-zinc-100'}`}>
          Mask
        </button>
      )}
      {activity && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-zinc-950/40">
          <span className="flex items-center gap-2 rounded-lg bg-zinc-950/80 px-3 py-1.5 text-xs font-medium text-zinc-200">
            <svg className="animate-spin" width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
            {activity}
          </span>
        </div>
      )}
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
  const [activity, setActivity] = useState<ImageOpActivity | null>(null)
  const [activeTool, setActiveTool] = useState<string | null>(null)
  const [optionsSlot, setOptionsSlot] = useState<HTMLDivElement | null>(null)
  const [overlaySlot, setOverlaySlot] = useState<HTMLDivElement | null>(null)

  const selected = entries.find((e) => e.id === selectedId)
  const hasSelection = selected !== undefined

  // No image, no tool: the tools work on the selected image.
  useEffect(() => {
    if (!hasSelection) setActiveTool(null)
  }, [hasSelection])

  /** An image already on disk: used where it is, not copied. */
  const addPath = useCallback(async (path: string) => {
    const existing = findByPath(useImageStudioStore.getState().entries, path)
    if (existing) {
      select(existing.id)
      return
    }
    const previewUrl = await previewUrlForPath(path)
    add({ path, previewUrl, name: fileNameOf(path) })
  }, [add, select])

  /** An image operation's output: a new entry made from `sourceImage`, selected. */
  const addResult = useCallback(async (result: ImageOpResult, sourceImage: StudioImage) => {
    const previewUrl = await previewUrlForPath(result.path)
    add({ path: result.path, previewUrl, name: fileNameOf(result.path), sourceId: sourceImage.id, op: result.op, maskPath: result.maskPath })
  }, [add])

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

        {selected && (
          <ImageOpsToolbar entries={entries} selected={selected} onResult={addResult} onActivity={setActivity}
            activeTool={activeTool} onActiveToolChange={setActiveTool} optionsSlot={optionsSlot} overlaySlot={overlaySlot} />
        )}

        <button type="button" onClick={browse} disabled={busy} title={busy ? 'Adding…' : 'Add image'} aria-label="Add image"
          className={ICON_BUTTON_CLASS}>
          <Icon d={ICONS.upload} size={16} />
        </button>
        {selected && (
          <button type="button" onClick={() => { void revealInFolder(selected) }} title="Show in folder" aria-label="Show in folder"
            className={ICON_BUTTON_CLASS}>
            <Icon d={ICONS.folder} size={16} />
          </button>
        )}
        <button type="button" onClick={() => { if (selected) sendToGenerate(selected) }} disabled={!selected}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-accent-dark disabled:cursor-not-allowed disabled:opacity-40">
          <Icon d={ICONS.generate} size={14} />
          Send to Generate
        </button>
      </header>

      {/* The active tool's options; ImageOpsToolbar portals them in. Hidden while empty. */}
      <div ref={setOptionsSlot} className="relative flex shrink-0 flex-wrap items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2 empty:hidden" />

      {selected
        ? <Canvas image={selected} activity={activity?.ids.includes(selected.id) ? activity.label : null}
            hideToggles={activeTool === 'crop'} onOverlaySlot={setOverlaySlot} />
        : <EmptyCanvas busy={busy} onBrowse={browse} />}

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

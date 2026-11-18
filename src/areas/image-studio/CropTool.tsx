import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import type { StudioImage } from './imageStudioStore'
import { isTextField } from './imageOps'
import {
  aspectRatio,
  cropEdges,
  dragRect,
  fitToRatio,
  fullRect,
  isFullRect,
  type AspectMode,
  type Handle,
  type ImageSize,
  type Rect,
} from './cropGeometry'

// The crop tool: a frame drawn over the image (in the canvas overlay slot) and
// its options (in the options bar). The frame lives in integer image pixels;
// the overlay maps it to screen pixels from the displayed, object-contain box.

export type CropEdges = { left: number; top: number; right: number; bottom: number }

interface CropToolProps {
  /** The image cropped: its source when the selection is itself a crop. */
  input: StudioImage
  optionsSlot: HTMLElement | null
  overlaySlot: HTMLElement | null
  running: boolean
  busy: boolean
  /** Runs the crop; true when the result was added to the history. */
  onApply: (edges: CropEdges) => Promise<boolean>
  onCancel: () => void
}

/** Where the image is drawn inside the overlay: object-contain, centered. */
interface ImageBox { left: number; top: number; scale: number }

const HANDLES: { handle: Exclude<Handle, 'move'>; x: 0 | 0.5 | 1; y: 0 | 0.5 | 1; cursor: string }[] = [
  { handle: 'nw', x: 0, y: 0, cursor: 'nwse-resize' },
  { handle: 'n', x: 0.5, y: 0, cursor: 'ns-resize' },
  { handle: 'ne', x: 1, y: 0, cursor: 'nesw-resize' },
  { handle: 'e', x: 1, y: 0.5, cursor: 'ew-resize' },
  { handle: 'se', x: 1, y: 1, cursor: 'nwse-resize' },
  { handle: 's', x: 0.5, y: 1, cursor: 'ns-resize' },
  { handle: 'sw', x: 0, y: 1, cursor: 'nesw-resize' },
  { handle: 'w', x: 0, y: 0.5, cursor: 'ew-resize' },
]

const MODES: { mode: AspectMode; label: string }[] = [
  { mode: 'free', label: 'Free' },
  { mode: 'square', label: '1:1' },
  { mode: 'original', label: 'Original' },
]

function imageBox(container: { width: number; height: number }, size: ImageSize): ImageBox | null {
  if (container.width <= 0 || container.height <= 0) return null
  const scale = Math.min(container.width / size.width, container.height / size.height)
  return {
    left: (container.width - size.width * scale) / 2,
    top: (container.height - size.height * scale) / 2,
    scale,
  }
}

/** Size of an element, kept up to date as it resizes. */
function useElementSize(element: HTMLElement | null): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    if (!element) return
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])
  return size
}

export default function CropTool({ input, optionsSlot, overlaySlot, running, busy, onApply, onCancel }: CropToolProps): JSX.Element {
  const [size, setSize] = useState<ImageSize | null>(null)
  const [rect, setRect] = useState<Rect | null>(null)
  const [mode, setMode] = useState<AspectMode>('free')
  const sizeRef = useRef<ImageSize | null>(null)

  // The frame starts as the whole image, and starts again if the image's size changes.
  const onImageSize = useCallback((natural: ImageSize) => {
    const current = sizeRef.current
    if (natural.width <= 0 || natural.height <= 0) return
    if (current && current.width === natural.width && current.height === natural.height) return
    sizeRef.current = natural
    setSize(natural)
    setRect(fullRect(natural))
    setMode('free')
  }, [])

  const canApply = size !== null && rect !== null && !isFullRect(rect, size) && !busy

  const apply = useCallback(() => {
    if (!canApply || !size || !rect) return
    void onApply(cropEdges(rect, size))
  }, [canApply, size, rect, onApply])

  // Enter applies, Esc cancels. Capture phase, so this runs before the
  // toolbar's Esc listener, which skips events already handled.
  const keys = useRef({ apply, onCancel })
  keys.current = { apply, onCancel }
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isTextField(event.target)) return
      if (event.key === 'Escape') {
        event.preventDefault()
        keys.current.onCancel()
      } else if (event.key === 'Enter' && !event.repeat) {
        // Also keeps Enter from clicking the focused button (a ratio, Reset…).
        event.preventDefault()
        keys.current.apply()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  function changeMode(next: AspectMode) {
    setMode(next)
    if (size) setRect((current) => current && fitToRatio(current, aspectRatio(next, size), size))
  }

  function reset() {
    if (!size) return
    setMode('free')
    setRect(fullRect(size))
  }

  return (
    <>
      {overlaySlot && createPortal(
        <CropOverlay input={input} size={size} rect={rect} ratio={size ? aspectRatio(mode, size) : null}
          locked={running} onImageSize={onImageSize} onRectChange={setRect} />,
        overlaySlot,
      )}
      {optionsSlot && createPortal(
        <>
          <span className="shrink-0 text-xs font-medium text-zinc-200">Crop</span>
          <div role="group" aria-label="Aspect ratio" className="flex shrink-0 rounded-lg border border-zinc-800 bg-zinc-900/60 p-0.5">
            {MODES.map(({ mode: m, label }) => (
              <button key={m} type="button" aria-pressed={mode === m} disabled={running || !size} onClick={() => changeMode(m)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${mode === m ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-100'}`}>
                {label}
              </button>
            ))}
          </div>
          <span className="shrink-0 text-xs tabular-nums text-zinc-400">
            {rect ? `${rect.w} × ${rect.h} px` : '…'}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <button type="button" onClick={reset} disabled={running || !size}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:text-zinc-100 disabled:opacity-50">
              Reset
            </button>
            <button type="button" onClick={onCancel}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:text-zinc-100">
              Cancel
            </button>
            <button type="button" onClick={apply} disabled={!canApply} aria-busy={running}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-accent-dark disabled:opacity-50">
              {running && <Spinner />}
              {running ? 'Cropping…' : 'Apply'}
            </button>
          </div>
        </>,
        optionsSlot,
      )}
    </>
  )
}

/** A drag in progress: what was grabbed, where, and the frame at that moment. */
interface Drag { handle: Handle; pointerId: number; x: number; y: number; start: Rect }

function CropOverlay({ input, size, rect, ratio, locked, onImageSize, onRectChange }: {
  input: StudioImage
  size: ImageSize | null
  rect: Rect | null
  ratio: number | null
  /** No dragging (the crop is running). */
  locked: boolean
  onImageSize: (size: ImageSize) => void
  onRectChange: (rect: Rect) => void
}): JSX.Element {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const containerSize = useElementSize(container)
  const imgRef = useRef<HTMLImageElement>(null)
  const drag = useRef<Drag | null>(null)
  const [dragging, setDragging] = useState(false)

  // A cached image can be complete before onLoad is attached.
  useEffect(() => {
    const img = imgRef.current
    if (img?.complete && img.naturalWidth > 0) onImageSize({ width: img.naturalWidth, height: img.naturalHeight })
  }, [onImageSize])

  const box = size ? imageBox(containerSize, size) : null

  function onPointerDown(handle: Handle, event: ReactPointerEvent<HTMLElement>) {
    if (locked || !rect || event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { handle, pointerId: event.pointerId, x: event.clientX, y: event.clientY, start: rect }
    setDragging(true)
  }

  function onPointerMove(event: ReactPointerEvent<HTMLElement>) {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId || !size || !box) return
    // Screen pixels to image pixels, at the scale the image is drawn now.
    const dx = (event.clientX - current.x) / box.scale
    const dy = (event.clientY - current.y) / box.scale
    onRectChange(dragRect(current.start, current.handle, dx, dy, size, ratio))
  }

  function endDrag(event: ReactPointerEvent<HTMLElement>) {
    if (drag.current?.pointerId !== event.pointerId) return
    drag.current = null
    setDragging(false)
  }

  const dragProps = (handle: Handle) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => onPointerDown(handle, event),
    onPointerMove,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    onLostPointerCapture: endDrag,
  })

  // The frame in overlay pixels.
  const frame = box && rect
    ? { left: box.left + rect.x * box.scale, top: box.top + rect.y * box.scale, width: rect.w * box.scale, height: rect.h * box.scale }
    : null

  return (
    <div ref={setContainer} className="absolute inset-0 select-none overflow-hidden bg-zinc-950">
      <img ref={imgRef} src={input.previewUrl} alt={input.name} draggable={false}
        onLoad={(event) => onImageSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        className="pointer-events-none absolute inset-0 h-full w-full object-contain" />
      {frame && (
        <>
          <Dim left={0} top={0} width={containerSize.width} height={frame.top} />
          <Dim left={0} top={frame.top + frame.height} width={containerSize.width} height={containerSize.height - frame.top - frame.height} />
          <Dim left={0} top={frame.top} width={frame.left} height={frame.height} />
          <Dim left={frame.left + frame.width} top={frame.top} width={containerSize.width - frame.left - frame.width} height={frame.height} />

          <div style={{ ...frame, cursor: locked ? 'default' : 'move' }}
            className="absolute touch-none border border-white/90 shadow-[0_0_0_1px_rgba(0,0,0,0.4)]" {...dragProps('move')}>
            {dragging && <ThirdsGrid />}
          </div>

          {!locked && HANDLES.map(({ handle, x, y, cursor }) => (
            // A 16 px hit area around an 8 px white square.
            <div key={handle} aria-hidden="true" {...dragProps(handle)}
              style={{ left: frame.left + frame.width * x - 8, top: frame.top + frame.height * y - 8, cursor }}
              className="absolute flex h-4 w-4 touch-none items-center justify-center">
              <span className="pointer-events-none block h-2 w-2 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.5)]" />
            </div>
          ))}
        </>
      )}
    </div>
  )
}

function Dim(props: { left: number; top: number; width: number; height: number }): JSX.Element | null {
  if (props.width <= 0 || props.height <= 0) return null
  return <div className="pointer-events-none absolute bg-black/60" style={props} />
}

function ThirdsGrid(): JSX.Element {
  return (
    <div className="pointer-events-none absolute inset-0">
      <span className="absolute inset-y-0 left-1/3 w-px bg-white/50" />
      <span className="absolute inset-y-0 left-2/3 w-px bg-white/50" />
      <span className="absolute inset-x-0 top-1/3 h-px bg-white/50" />
      <span className="absolute inset-x-0 top-2/3 h-px bg-white/50" />
    </div>
  )
}

function Spinner(): JSX.Element {
  return (
    <svg className="animate-spin" width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  )
}

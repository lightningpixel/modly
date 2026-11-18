export interface ImageSize { width: number; height: number }
/** Integer image pixels. */
export interface Rect { x: number; y: number; w: number; h: number }
export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | 'move'
export type AspectMode = 'free' | 'square' | 'original'

export const MIN_CROP_PX = 16

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), Math.max(lo, hi))

export function fullRect(size: ImageSize): Rect {
  return { x: 0, y: 0, w: size.width, h: size.height }
}

export function minCropSize(size: ImageSize): { w: number; h: number } {
  return { w: Math.min(MIN_CROP_PX, size.width), h: Math.min(MIN_CROP_PX, size.height) }
}

/** w / h of the mode, or null when free. */
export function aspectRatio(mode: AspectMode, size: ImageSize): number | null {
  if (mode === 'square') return 1
  if (mode === 'original') return size.width / size.height
  return null
}

/** Largest rect of `ratio` inside `rect`, centered on it. */
export function fitToRatio(rect: Rect, ratio: number | null, _size: ImageSize): Rect {
  if (ratio === null) return rect
  let w = rect.w
  let h = Math.round(w / ratio)
  if (h > rect.h) {
    h = rect.h
    w = Math.round(h * ratio)
  }
  w = Math.min(w, rect.w)
  return {
    x: rect.x + Math.round((rect.w - w) / 2),
    y: rect.y + Math.round((rect.h - h) / 2),
    w,
    h,
  }
}

export function dragRect(
  start: Rect, handle: Handle, dx: number, dy: number, size: ImageSize, ratio: number | null,
): Rect {
  const W = size.width
  const H = size.height
  const min = minCropSize(size)

  if (handle === 'move') {
    return {
      x: clamp(Math.round(start.x + dx), 0, W - start.w),
      y: clamp(Math.round(start.y + dy), 0, H - start.h),
      w: start.w,
      h: start.h,
    }
  }

  const hasE = handle.includes('e')
  const hasW = handle.includes('w')
  const hasN = handle.includes('n')
  const hasS = handle.includes('s')
  const isCorner = (hasE || hasW) && (hasN || hasS)

  if (ratio === null) {
    let l = start.x
    let r = start.x + start.w
    let t = start.y
    let b = start.y + start.h
    if (hasE) r = clamp(Math.round(r + dx), l + min.w, W)
    if (hasW) l = clamp(Math.round(l + dx), 0, r - min.w)
    if (hasS) b = clamp(Math.round(b + dy), t + min.h, H)
    if (hasN) t = clamp(Math.round(t + dy), 0, b - min.h)
    return { x: l, y: t, w: r - l, h: b - t }
  }

  const minW = Math.max(min.w, min.h * ratio)

  if (isCorner) {
    const ax = hasE ? start.x : start.x + start.w
    const ay = hasS ? start.y : start.y + start.h
    const pw = hasE ? start.w + dx : start.w - dx
    const ph = hasS ? start.h + dy : start.h - dy
    const maxW = Math.min(hasE ? W - ax : ax, (hasS ? H - ay : ay) * ratio)
    const w = Math.round(clamp(Math.max(pw, ph * ratio), minW, maxW))
    const h = Math.min(Math.round(w / ratio), hasS ? H - ay : ay)
    return { x: hasE ? ax : ax - w, y: hasS ? ay : ay - h, w, h }
  }

  if (hasE || hasW) {
    const pw = hasE ? start.w + dx : start.w - dx
    const maxW = Math.min(hasE ? W - start.x : start.x + start.w, H * ratio)
    const w = Math.round(clamp(pw, minW, maxW))
    const h = Math.min(Math.round(w / ratio), H)
    const cy = start.y + start.h / 2
    return {
      x: hasE ? start.x : start.x + start.w - w,
      y: clamp(Math.round(cy - h / 2), 0, H - h),
      w,
      h,
    }
  }

  // n / s
  const minH = Math.max(min.h, min.w / ratio)
  const ph = hasS ? start.h + dy : start.h - dy
  const maxH = Math.min(hasS ? H - start.y : start.y + start.h, W / ratio)
  const h = Math.round(clamp(ph, minH, maxH))
  const w = Math.min(Math.round(h * ratio), W)
  const cx = start.x + start.w / 2
  return {
    x: clamp(Math.round(cx - w / 2), 0, W - w),
    y: hasS ? start.y : start.y + start.h - h,
    w,
    h,
  }
}

/** Crop margins as percentages of the image. */
export function cropEdges(rect: Rect, size: ImageSize): { left: number; top: number; right: number; bottom: number } {
  return {
    left: (rect.x / size.width) * 100,
    top: (rect.y / size.height) * 100,
    right: ((size.width - rect.x - rect.w) / size.width) * 100,
    bottom: ((size.height - rect.y - rect.h) / size.height) * 100,
  }
}

export function isFullRect(rect: Rect, size: ImageSize): boolean {
  return rect.x === 0 && rect.y === 0 && rect.w === size.width && rect.h === size.height
}

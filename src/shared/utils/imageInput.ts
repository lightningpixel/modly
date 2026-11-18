import { create } from 'zustand'

// Hands an input image from another page (Home) to Generate. Generate's image
// lives in the selected workflow's image node, which only Generate's panel can
// edit, so the path waits here until that panel picks it up.

export const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

interface ImageHandoff {
  pendingPath: string | null
  offer: (path: string) => void
  /** Returns the waiting path, if any, and clears it. */
  take: () => string | null
}

export const useImageHandoff = create<ImageHandoff>((set, get) => ({
  pendingPath: null,
  offer: (path) => set({ pendingPath: path }),
  take: () => {
    const path = get().pendingPath
    if (path) set({ pendingPath: null })
    return path
  },
}))

/** The disk path of a dropped file, or null when it is not a supported image. */
export function droppedImagePath(file: File | undefined): string | null {
  if (!file || !SUPPORTED_IMAGE_TYPES.has(file.type)) return null
  return window.electron.fs.getPathForFile(file) || null
}

/** Where a supported image dropped or pasted without a disk path is saved: a workspace file. */
export async function saveImageToWorkspace(blob: Blob, name?: string): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const result = await window.electron.workspace.images.save({ bytes, name, mime: blob.type })
  if (!result.success) throw new Error(result.error)
  return result.path
}

interface ClipboardItemLike {
  kind: string
  type: string
  getAsFile: () => File | null
}

/** The first supported image in a paste's clipboard data, or null. */
export function clipboardImage(data: { items: ArrayLike<ClipboardItemLike> } | null | undefined): File | null {
  if (!data) return null
  for (const item of Array.from(data.items)) {
    if (item.kind === 'file' && SUPPORTED_IMAGE_TYPES.has(item.type)) return item.getAsFile()
  }
  return null
}

/** Whether a paste lands in something that takes text, where Ctrl+V must keep its usual meaning. */
export function isTextEntryTarget(target: unknown): boolean {
  const el = target as { tagName?: unknown, isContentEditable?: unknown, type?: unknown } | null
  if (!el || typeof el !== 'object') return false
  if (el.isContentEditable === true) return true
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : ''
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag !== 'INPUT') return false
  const type = typeof el.type === 'string' ? el.type.toLowerCase() : 'text'
  return !['button', 'checkbox', 'color', 'file', 'image', 'radio', 'range', 'reset', 'submit'].includes(type)
}

/**
 * The image a paste event carries, unless it was aimed at a text field. Call
 * from a window 'paste' listener; it prevents the default when it takes one.
 */
export function takePastedImage(event: ClipboardEvent): File | null {
  if (isTextEntryTarget(event.target) || isTextEntryTarget(document.activeElement)) return null
  const file = clipboardImage(event.clipboardData)
  if (file) event.preventDefault()
  return file
}

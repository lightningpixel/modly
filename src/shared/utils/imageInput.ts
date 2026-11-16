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

import { create } from 'zustand'

// The Image Studio's history: every image of this session, newest first.
// Pages unmount when the user switches away, so it lives here, at module
// level, and survives navigation (not app restarts).
//
// An image made from another one (an image operation, e.g. background
// removal) records it as `sourceId`; the studio compares the two before/after.

export interface StudioImage {
  id: string
  /** Absolute path on disk: what Generate and image operations read. */
  path: string
  /** URL the renderer displays (an object URL the store owns, or a data URL). */
  previewUrl: string
  name: string
  /** The image this one was produced from, when it came from an operation. */
  sourceId?: string
  createdAt: number
}

export type NewStudioImage = Omit<StudioImage, 'id' | 'createdAt'>

export interface StudioHistory {
  entries: StudioImage[]
  selectedId: string | null
}

/** Oldest images beyond this are dropped from the history (not from disk). */
export const MAX_STUDIO_HISTORY = 60

/** Adds an image in front and selects it; entries over `max` fall off the end. */
export function addToHistory(history: StudioHistory, entry: StudioImage, max = MAX_STUDIO_HISTORY): { history: StudioHistory, dropped: StudioImage[] } {
  const all = [entry, ...history.entries]
  return withoutEntries({ entries: all, selectedId: entry.id }, all.slice(max).map((e) => e.id))
}

/**
 * Drops entries from the history. Images made from a dropped one lose their
 * source (nothing to compare with any more); the selection moves to the
 * neighbour of the removed image.
 */
export function withoutEntries(history: StudioHistory, ids: readonly string[]): { history: StudioHistory, dropped: StudioImage[] } {
  const gone = new Set(ids)
  const dropped = history.entries.filter((e) => gone.has(e.id))
  if (dropped.length === 0) return { history, dropped }
  const entries = history.entries
    .filter((e) => !gone.has(e.id))
    .map((e) => (e.sourceId && gone.has(e.sourceId) ? { ...e, sourceId: undefined } : e))
  let selectedId = history.selectedId
  if (selectedId && gone.has(selectedId)) {
    const index = history.entries.findIndex((e) => e.id === selectedId)
    const after = history.entries.slice(index + 1).find((e) => !gone.has(e.id))
    const before = history.entries.slice(0, index).reverse().find((e) => !gone.has(e.id))
    selectedId = (after ?? before)?.id ?? null
  }
  return { history: { entries, selectedId }, dropped }
}

export function findByPath(entries: readonly StudioImage[], path: string): StudioImage | undefined {
  const key = normalizePath(path)
  return entries.find((e) => normalizePath(e.path) === key)
}

/** The image an entry was made from, if it is still in the history. */
export function sourceOf(entries: readonly StudioImage[], entry: StudioImage | undefined): StudioImage | undefined {
  return entry?.sourceId ? entries.find((e) => e.id === entry.sourceId) : undefined
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase()
}

export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

export interface ImageStudioState extends StudioHistory {
  /** Adds an image to the history and selects it. */
  add: (image: NewStudioImage) => StudioImage
  select: (id: string) => void
  /** Removes an image from the history; the file stays on disk. */
  remove: (id: string) => void
  clear: () => void
}

function revokeObjectUrl(url: string): void {
  if (url.startsWith('blob:')) URL.revokeObjectURL(url)
}

let nextId = 0

export function createImageStudioStore(revoke: (url: string) => void = revokeObjectUrl) {
  return create<ImageStudioState>((set, get) => {
    const apply = ({ history, dropped }: { history: StudioHistory, dropped: StudioImage[] }) => {
      set(history)
      for (const entry of dropped) revoke(entry.previewUrl)
    }
    return {
      entries: [],
      selectedId: null,
      add: (image) => {
        const entry: StudioImage = { ...image, id: `img-${Date.now().toString(36)}-${(nextId++).toString(36)}`, createdAt: Date.now() }
        apply(addToHistory(get(), entry))
        return entry
      },
      select: (id) => {
        if (get().entries.some((e) => e.id === id)) set({ selectedId: id })
      },
      remove: (id) => apply(withoutEntries(get(), [id])),
      clear: () => apply(withoutEntries(get(), get().entries.map((e) => e.id))),
    }
  })
}

export const useImageStudioStore = createImageStudioStore()

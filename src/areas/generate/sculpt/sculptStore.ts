// Sculpt mode state shared by the edit panel (settings), the viewer (strokes)
// and the page (shortcuts, commit before export / chat / ops).
//
// The meshes being sculpted live in the viewer: it registers a SculptSession
// that knows how to upload them and how to replay the stroke history. Anyone
// about to read or replace the mesh file awaits `commit()` first.

import { create } from 'zustand'
import { useAppStore } from '@shared/stores/appStore'
import { apiErrorMessage } from '../meshEditPanel'
import type { BrushKind, StrokeRecord, SymmetryAxis } from './types'
import {
  RADIUS_DEFAULT,
  clampRadius,
  emptyHistory,
  isHistoryDirty,
  stepRadius,
  type SculptHistory,
} from './sculptLogic'

/** One local undo step: a stroke on the SculptMesh of the geometry `meshKey`. */
export interface SculptStrokeEntry {
  meshKey: string
  record: StrokeRecord
}

/** Registered by the viewer for the model it shows. */
export interface SculptSession {
  /** Writes the sculpted vertices to a new mesh file and shows it (one global undo step). Throws on failure. */
  commit(): Promise<void>
  undo(): void
  redo(): void
}

export interface BrushParams {
  /** Fraction of the model's bounding-box diagonal. */
  radius: number
  /** 0..1. */
  strength: number
}

export type SculptStatus = 'idle' | 'preparing' | 'saving'

export const BRUSH_KINDS: BrushKind[] = ['grab', 'smooth', 'inflate', 'flatten']

const DEFAULT_BRUSHES: Record<BrushKind, BrushParams> = {
  grab:    { radius: 0.08, strength: 1 },
  smooth:  { radius: RADIUS_DEFAULT, strength: 0.5 },
  inflate: { radius: RADIUS_DEFAULT, strength: 0.3 },
  flatten: { radius: RADIUS_DEFAULT, strength: 0.5 },
}

interface SculptState {
  active: boolean
  brush: BrushKind
  brushes: Record<BrushKind, BrushParams>
  symmetry: SymmetryAxis[]
  history: SculptHistory<SculptStrokeEntry>
  /** Strokes not yet written to the mesh file. */
  dirty: boolean
  status: SculptStatus
  error: string | null
  session: SculptSession | null

  enter: () => void
  /** Commits, then leaves sculpt mode. Stays in sculpt mode (false) when saving failed. */
  exit: () => Promise<boolean>
  /** Leaves sculpt mode without saving (the model went away). */
  reset: () => void
  setBrush: (kind: BrushKind) => void
  setRadius: (fraction: number) => void
  stepRadius: (direction: 1 | -1) => void
  setStrength: (strength: number) => void
  toggleSymmetry: (axis: SymmetryAxis) => void
  setHistory: (history: SculptHistory<SculptStrokeEntry>) => void
  setStatus: (status: SculptStatus) => void
  setError: (error: string | null) => void
  /** Returns the unregister function. */
  registerSession: (session: SculptSession) => () => void
  /**
   * Writes pending strokes to the mesh file. Resolves true when there is
   * nothing left to save, false when saving failed (the strokes are kept and
   * the error is shown).
   */
  commit: () => Promise<boolean>
  undo: () => void
  redo: () => void
}

let inflight: Promise<boolean> | null = null

export const useSculptStore = create<SculptState>()((set, get) => ({
  active: false,
  brush: 'grab',
  brushes: DEFAULT_BRUSHES,
  symmetry: [],
  history: emptyHistory(),
  dirty: false,
  status: 'idle',
  error: null,
  session: null,

  enter: () => set({ active: true, error: null }),

  exit: async () => {
    const ok = await get().commit()
    if (ok) set({ active: false, error: null })
    return ok
  },

  reset: () => set({ active: false, history: emptyHistory(), dirty: false, status: 'idle', error: null }),

  setBrush: (kind) => set({ brush: kind }),

  setRadius: (fraction) => {
    const { brush, brushes } = get()
    set({ brushes: { ...brushes, [brush]: { ...brushes[brush], radius: clampRadius(fraction) } } })
  },

  stepRadius: (direction) => {
    const { brush, brushes } = get()
    get().setRadius(stepRadius(brushes[brush].radius, direction))
  },

  setStrength: (strength) => {
    const { brush, brushes } = get()
    const s = Math.min(1, Math.max(0, Number.isFinite(strength) ? strength : 0))
    set({ brushes: { ...brushes, [brush]: { ...brushes[brush], strength: s } } })
  },

  toggleSymmetry: (axis) => {
    const { symmetry } = get()
    set({ symmetry: symmetry.includes(axis) ? symmetry.filter((a) => a !== axis) : [...symmetry, axis].sort() })
  },

  setHistory: (history) => set({ history, dirty: isHistoryDirty(history) }),
  setStatus: (status) => set({ status }),
  setError: (error) => set({ error }),

  registerSession: (session) => {
    set({ session, history: emptyHistory(), dirty: false, status: 'idle' })
    return () => {
      if (get().session === session) set({ session: null, history: emptyHistory(), dirty: false, status: 'idle' })
    }
  },

  commit: () => {
    if (inflight) return inflight
    const { session, dirty } = get()
    if (!dirty) return Promise.resolve(true)
    if (!session) return Promise.resolve(true)
    set({ status: 'saving', error: null })
    inflight = session.commit()
      .then(() => {
        set({ history: emptyHistory(), dirty: false, status: 'idle' })
        return true
      }, (err: unknown) => {
        const message = apiErrorMessage(err)
        set({ status: 'idle', error: `Could not save the sculpt: ${message}` })
        useAppStore.getState().showToast(`Could not save the sculpt: ${message}`, 5000)
        return false
      })
      .finally(() => { inflight = null })
    return inflight
  },

  undo: () => {
    const { session, status } = get()
    if (status !== 'idle') return
    session?.undo()
  },

  redo: () => {
    const { session, status } = get()
    if (status !== 'idle') return
    session?.redo()
  },
}))

/** Await pending sculpt strokes before reading or replacing the mesh file. */
export function commitSculpt(): Promise<boolean> {
  return useSculptStore.getState().commit()
}

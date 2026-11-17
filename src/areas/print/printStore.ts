import { create } from 'zustand'

/** What the Print page shows: Generate's current mesh, or a Library asset. */
export type PrintSource =
  | { kind: 'current' }
  | { kind: 'library', id: string, name: string, url: string }

interface PrintState {
  source: PrintSource
  setSource: (source: PrintSource) => void
}

// Kept across page switches, like Image Studio's history.
export const usePrintStore = create<PrintState>((set) => ({
  source: { kind: 'current' },
  setSource: (source) => set({ source }),
}))

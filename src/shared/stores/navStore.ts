import { create } from 'zustand'
// Relative and type-only, so the store loads under `node --test`.
import type { Page } from '../pages/pageRegistry'

export type { Page }

/** What a page is opened on, e.g. `{ extension: 'hunyuan' }` for the Extensions page. */
export type PageParams = Readonly<Record<string, string>>

interface NavState {
  currentPage: Page
  /** Target of the last navigate() call; the page reads it, then clears it. */
  params: PageParams | null
  navigate: (page: Page, params?: PageParams) => void
  /** Opens the Extensions page on one extension. */
  openExtension: (extensionId: string) => void
  clearParams: () => void
}

export const useNavStore = create<NavState>((set, get) => ({
  currentPage: 'generate',
  params: null,
  navigate: (page, params) => set({ currentPage: page, params: params ?? null }),
  openExtension: (extensionId) => get().navigate('models', { extension: extensionId }),
  clearParams: () => set({ params: null }),
}))

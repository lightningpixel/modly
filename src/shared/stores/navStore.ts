import { create } from 'zustand'

export type Page = 'generate' | 'workflows' | 'models' | 'settings'

interface NavState {
  currentPage: Page
  navigate: (page: Page) => void
}

export const useNavStore = create<NavState>((set) => ({
  currentPage: 'generate',
  navigate: (page) => set({ currentPage: page })
}))

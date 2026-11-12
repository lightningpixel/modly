import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export const AGENT_PANEL_MIN_WIDTH     = 320
export const AGENT_PANEL_MAX_WIDTH     = 640
export const AGENT_PANEL_DEFAULT_WIDTH = 380

export function clampPanelWidth(width: number): number {
  if (!Number.isFinite(width)) return AGENT_PANEL_DEFAULT_WIDTH
  return Math.round(Math.min(AGENT_PANEL_MAX_WIDTH, Math.max(AGENT_PANEL_MIN_WIDTH, width)))
}

interface AgentPanelState {
  open: boolean
  width: number
  setOpen: (open: boolean) => void
  toggle: () => void
  setWidth: (width: number) => void
}

export const useAgentPanelStore = create<AgentPanelState>()(
  persist(
    (set) => ({
      open: false,
      width: AGENT_PANEL_DEFAULT_WIDTH,
      setOpen: (open) => set({ open }),
      toggle: () => set((s) => ({ open: !s.open })),
      setWidth: (width) => set({ width: clampPanelWidth(width) }),
    }),
    {
      name: 'modly-agent-panel',
      partialize: (s) => ({ open: s.open, width: s.width }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<AgentPanelState>
        return {
          ...current,
          open: typeof p.open === 'boolean' ? p.open : current.open,
          width: typeof p.width === 'number' ? clampPanelWidth(p.width) : current.width,
        }
      },
    },
  ),
)

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ThinkingMode = 'auto' | 'on' | 'off'

interface AgentSettings {
  ollamaUrl:        string
  defaultModel:     string
  defaultThinking:  ThinkingMode

  setOllamaUrl:       (url: string)          => void
  setDefaultModel:    (model: string)        => void
  setDefaultThinking: (mode: ThinkingMode)   => void
}

export const useAgentStore = create<AgentSettings>()(
  persist(
    (set) => ({
      ollamaUrl:       'http://localhost:11434',
      defaultModel:    'gemma4:e4b',
      defaultThinking: 'auto',

      setOllamaUrl:       (url)   => set({ ollamaUrl: url }),
      setDefaultModel:    (model) => set({ defaultModel: model }),
      setDefaultThinking: (mode)  => set({ defaultThinking: mode }),
    }),
    { name: 'modly-agent-settings' },
  ),
)

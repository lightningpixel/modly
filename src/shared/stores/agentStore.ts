import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

export type ThinkingMode = 'auto' | 'on' | 'off'

export type ProviderId = 'local' | 'ollama' | 'openai' | 'anthropic' | 'mistral' | 'groq' | 'openrouter' | 'custom'

export interface ExternalConfig {
  apiKey:  string
  model:   string
  baseUrl?: string // only used by 'custom'
}

export const PROVIDERS: Record<ProviderId, { label: string; baseUrl: string; noKey?: boolean }> = {
  local:      { label: 'Local (llama.cpp)', baseUrl: '' },
  // Ollama serves an OpenAI-compatible API — reuses models already pulled with it.
  ollama:     { label: 'Ollama',            baseUrl: 'http://localhost:11434/v1', noKey: true },
  openai:     { label: 'ChatGPT (OpenAI)',  baseUrl: 'https://api.openai.com/v1' },
  anthropic:  { label: 'Claude (Anthropic)', baseUrl: 'https://api.anthropic.com/v1' },
  mistral:    { label: 'Mistral',           baseUrl: 'https://api.mistral.ai/v1' },
  groq:       { label: 'Groq',              baseUrl: 'https://api.groq.com/openai/v1' },
  openrouter: { label: 'OpenRouter',        baseUrl: 'https://openrouter.ai/api/v1' },
  custom:     { label: 'Custom endpoint',   baseUrl: '' },
}

export const DEFAULT_LOCAL_MODEL = 'qwen3-4b'

// Catalog ids removed in the Qwen3/gpt-oss refresh → their closest replacement
const RETIRED_LOCAL_MODELS: Record<string, string> = {
  'qwen2.5-3b':  'qwen3-4b',
  'qwen2.5-7b':  'qwen3-4b',
  'qwen2.5-14b': 'qwen3-14b',
  'llama-3.1-8b': 'qwen3-4b',
  'deepseek-r1-distill-qwen-7b': 'qwen3-14b',
}

/** Resolve the base URL for a provider (custom uses its own field). */
export function providerBaseUrl(provider: ProviderId, external: ExternalConfig | undefined): string {
  if (provider === 'custom') return external?.baseUrl ?? ''
  return PROVIDERS[provider].baseUrl
}

interface AgentSettings {
  provider:        ProviderId
  localModel:      string                          // catalog id or custom:<file>
  external:        Partial<Record<ProviderId, ExternalConfig>>
  defaultThinking: ThinkingMode

  setProvider:        (provider: ProviderId)                        => void
  setLocalModel:      (model: string)                               => void
  setExternal:        (provider: ProviderId, cfg: ExternalConfig)   => void
  setDefaultThinking: (mode: ThinkingMode)                          => void
}

// ─── Secure persistence ────────────────────────────────────────────────────────
// External provider API keys are the one sensitive field in this store. They're
// encrypted at rest via Electron's safeStorage (OS keychain/DPAPI/libsecret) —
// everything else (provider, localModel, defaultThinking) stays plain, it isn't
// a secret. The ciphertext itself still lives in localStorage as a hex string;
// only the plaintext key never touches disk unencrypted.

type PersistedExternal = Partial<Record<ProviderId, ExternalConfig>>

function hasSecureStore(): boolean {
  return typeof window !== 'undefined' && !!window.electron?.secureStore
}

async function transformApiKeys(
  external: PersistedExternal | undefined,
  transform: (key: string) => Promise<string | null>,
): Promise<PersistedExternal | undefined> {
  if (!external || !hasSecureStore()) return external
  const entries = await Promise.all(
    Object.entries(external).map(async ([provider, cfg]) => {
      if (!cfg?.apiKey) return [provider, cfg] as const
      const key = await transform(cfg.apiKey)
      // null = stored blob we can't decrypt here (different OS user/machine).
      // Drop it: sending a ciphertext as an Authorization header just 401s, and
      // keeping it in state would re-encrypt it on the next write.
      return [provider, { ...cfg, apiKey: key ?? '' }] as const
    }),
  )
  return Object.fromEntries(entries) as PersistedExternal
}

const secureAgentStorage = {
  getItem: async (name: string): Promise<string | null> => {
    const raw = localStorage.getItem(name)
    if (!raw) return raw
    try {
      const envelope = JSON.parse(raw)
      if (envelope?.state?.external) {
        envelope.state.external = await transformApiKeys(envelope.state.external, (k) => window.electron.secureStore.decrypt(k))
      }
      return JSON.stringify(envelope)
    } catch {
      return raw
    }
  },
  setItem: async (name: string, value: string): Promise<void> => {
    try {
      const envelope = JSON.parse(value)
      if (envelope?.state?.external) {
        envelope.state.external = await transformApiKeys(envelope.state.external, (k) => window.electron.secureStore.encrypt(k))
      }
      localStorage.setItem(name, JSON.stringify(envelope))
    } catch {
      localStorage.setItem(name, value)
    }
  },
  removeItem: async (name: string): Promise<void> => { localStorage.removeItem(name) },
}

export const useAgentStore = create<AgentSettings>()(
  persist(
    (set) => ({
      provider:        'local',
      localModel:      DEFAULT_LOCAL_MODEL,
      external:        {},
      defaultThinking: 'auto',

      setProvider:        (provider)       => set({ provider }),
      setLocalModel:      (model)          => set({ localModel: model }),
      setExternal:        (provider, cfg)  => set((s) => ({ external: { ...s.external, [provider]: cfg } })),
      setDefaultThinking: (mode)           => set({ defaultThinking: mode }),
    }),
    {
      name: 'modly-agent-settings',
      version: 3,
      storage: createJSONStorage(() => secureAgentStorage),
      // v0 stored { ollamaUrl, defaultModel } — drop them, keep only thinking.
      // v2 retired the Qwen2.5/Llama3.1 catalog ids.
      // v3 is a shape-less bump: the version change alone forces one re-persist
      //    through secureAgentStorage.setItem, which encrypts any legacy
      //    plaintext API key saved before safeStorage existed. Self-limiting —
      //    once stored as v3 it never re-runs, so it costs one write, not one per boot.
      migrate: (persisted: unknown, version) => {
        if (version === 0 && persisted && typeof persisted === 'object') {
          const old = persisted as { defaultThinking?: ThinkingMode }
          return {
            provider:        'local' as ProviderId,
            localModel:      DEFAULT_LOCAL_MODEL,
            external:        {},
            defaultThinking: old.defaultThinking ?? 'auto',
          }
        }
        const state = persisted as AgentSettings
        if (version < 2 && state?.localModel && RETIRED_LOCAL_MODELS[state.localModel]) {
          return { ...state, localModel: RETIRED_LOCAL_MODELS[state.localModel] }
        }
        return state
      },
    },
  ),
)

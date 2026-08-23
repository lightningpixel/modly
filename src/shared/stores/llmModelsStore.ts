import { create } from 'zustand'
import { useCallback, useEffect, useMemo } from 'react'
import { useAppStore } from './appStore'

export interface LlmModel {
  id:                string
  name:              string
  description?:      string
  hf_filename:        string
  size_bytes?:        number
  quant?:             string
  vram_estimate_mb?:  number
  downloaded:         boolean
  source:             'catalog' | 'custom'
  tags?:              string[]
  /** How well this model drives the agent — see components/ui/agentGrade.ts.
   *  `agent_score` is only shown when `agent_source` is 'measured', i.e. the
   *  model was actually run against Modly's own eval suite. */
  agent_tier?:        'excellent' | 'solid' | 'limited'
  agent_score?:       number
  agent_source?:      'measured' | 'estimate'
  agent_note?:        string
}

interface LlmModelsStore {
  models:        LlmModel[]
  loading:       boolean
  error:         string | null
  fetchedApiUrl: string | null
  /** The card's VRAM in GB, null while unknown or unmeasurable (no NVIDIA GPU).
   *  Lives here rather than in its own store because every caller that wants it
   *  already holds this one, and it comes from the same backend. */
  vramGb:        number | null
  fetchModels:   (apiUrl: string, opts?: { force?: boolean }) => Promise<void>
  fetchHardware: (apiUrl: string) => Promise<void>
}

// Module-level so concurrent callers (multiple nodes/components mounting at
// once) share one in-flight request instead of firing N identical fetches.
let inFlight: Promise<void> | null = null
// Identifies the request currently owning `inFlight`, so a superseded one does
// not clear a newer forced refresh on its way out.
let inFlightId = 0
// apiUrl whose hardware has been read, so the probe runs once and not per render.
let hardwareFetchedFor: string | null = null

export const useLlmModelsStore = create<LlmModelsStore>((set, get) => ({
  models:        [],
  loading:       false,
  error:         null,
  fetchedApiUrl: null,
  vramGb:        null,

  async fetchModels(apiUrl, opts) {
    const state = get()
    if (!opts?.force && state.fetchedApiUrl === apiUrl && state.models.length > 0) return
    // A forced refresh follows a mutation (download finished, model deleted), so
    // it must not settle for a request issued BEFORE it: joining the in-flight
    // one kept the pre-mutation `downloaded` flags, and the preflight went on
    // reporting "…isn't downloaded" for a model that had just landed.
    const pending = inFlight
    if (pending && !opts?.force) return pending

    set({ loading: true, error: null })
    const id = ++inFlightId
    const request = (async () => {
      if (pending) {
        await pending.catch(() => {})
        set({ loading: true, error: null })  // the request we waited on may have failed
      }
      try {
        const res = await fetch(`${apiUrl}/llm/models`)
        const data: { models?: LlmModel[] } = await res.json()
        set({ models: data.models ?? [], fetchedApiUrl: apiUrl, loading: false, error: null })
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e), loading: false })
      } finally {
        if (inFlightId === id) inFlight = null
      }
    })()
    inFlight = request
    return request
  },

  async fetchHardware(apiUrl) {
    // Once per session: the card does not change while the app runs, and this
    // is called from a hook that renders on every workflow edit.
    if (hardwareFetchedFor === apiUrl) return
    hardwareFetchedFor = apiUrl
    try {
      const res = await fetch(`${apiUrl}/llm/status`)
      const data: { vram_gb?: number | null } = await res.json()
      set({ vramGb: typeof data.vram_gb === 'number' && data.vram_gb > 0 ? data.vram_gb : null })
    } catch {
      // Cleared, not retried here: this effect only re-runs when apiUrl changes,
      // so the next consumer of useLlmModels to mount is what tries again.
      hardwareFetchedFor = null
    }
  },
}))

/**
 * Shared local-LLM catalog: fetched once per apiUrl and cached across every
 * consumer (LLM node, extension param pickers, chat model picker, Settings…)
 * instead of each component firing its own `/llm/models` request.
 *
 * `tag` mirrors the backend's own filter (`GET /llm/models?tag=`): custom
 * GGUFs are always kept since their capabilities aren't known ahead of time.
 */
export function useLlmModels(tag?: string): {
  models:  LlmModel[]
  loading: boolean
  error:   string | null
  /** The card's VRAM in GB, null when unknown. */
  vramGb:  number | null
  refresh: () => Promise<void>
} {
  const apiUrl      = useAppStore((s) => s.apiUrl)
  const models      = useLlmModelsStore((s) => s.models)
  const loading     = useLlmModelsStore((s) => s.loading)
  const error       = useLlmModelsStore((s) => s.error)
  const fetchModels = useLlmModelsStore((s) => s.fetchModels)
  const vramGb      = useLlmModelsStore((s) => s.vramGb)
  const fetchHardware = useLlmModelsStore((s) => s.fetchHardware)

  useEffect(() => { void fetchModels(apiUrl) }, [apiUrl, fetchModels])
  useEffect(() => { void fetchHardware(apiUrl) }, [apiUrl, fetchHardware])

  // Both memoised because callers put them in dependency arrays. A `refresh`
  // rebuilt on every render made ModelLibraryModal's `useEffect(…, [refresh])`
  // re-run on every render: each pass forced a /llm/models + /llm/status fetch,
  // whose setState triggered the next one. The modal flickered and hammered the
  // API for as long as it stayed open.
  const filtered = useMemo(
    () => (tag ? models.filter((m) => m.source === 'custom' || (m.tags ?? []).includes(tag)) : models),
    [models, tag],
  )
  const refresh = useCallback(() => fetchModels(apiUrl, { force: true }), [apiUrl, fetchModels])

  return { models: filtered, loading, error, vramGb, refresh }
}

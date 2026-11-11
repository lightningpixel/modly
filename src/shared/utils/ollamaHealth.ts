// GET /agent/ollama/health — is Ollama up, and is the configured model pulled?

export type OllamaStatus = 'ok' | 'unreachable' | 'model_missing' | 'no_model'

const STATUSES: readonly OllamaStatus[] = ['ok', 'unreachable', 'model_missing', 'no_model']

export interface OllamaHealth {
  status: OllamaStatus
  /** Ollama's server root (no `/v1`). */
  base_url: string
  model: string
  /** Models pulled in Ollama (absent when it is unreachable). */
  available?: string[]
  detail?: string
}

export interface OllamaAdvice {
  title: string
  body: string
  /** A shell command that fixes it, shown copyable. */
  command?: string
}

export function ollamaHealthUrl(apiUrl: string, baseUrl: string, model: string): string {
  const query = new URLSearchParams({ base_url: baseUrl, model })
  return `${apiUrl}/agent/ollama/health?${query.toString()}`
}

export function parseOllamaHealth(data: unknown): OllamaHealth | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (!STATUSES.includes(d.status as OllamaStatus)) return null
  return {
    status: d.status as OllamaStatus,
    base_url: typeof d.base_url === 'string' ? d.base_url : '',
    model: typeof d.model === 'string' ? d.model : '',
    ...(Array.isArray(d.available) ? { available: d.available.filter((m): m is string => typeof m === 'string') } : {}),
    detail: typeof d.detail === 'string' ? d.detail : undefined,
  }
}

function host(baseUrl: string): string {
  return baseUrl.replace(/^https?:\/\//, '') || 'its configured address'
}

/** The advice as one plain-text line, for a chat message. */
export function adviceText(advice: OllamaAdvice): string {
  return [`${advice.title}.`, advice.body, advice.command].filter(Boolean).join(' ')
}

/** What to tell the user, or null when Ollama is ready. */
export function ollamaAdvice(health: OllamaHealth): OllamaAdvice | null {
  switch (health.status) {
    case 'ok':
      return null
    case 'unreachable':
      return {
        title: 'Ollama is not running',
        body: `The agent can't reach Ollama at ${host(health.base_url)}. Start the Ollama app, or run:`,
        command: 'ollama serve',
      }
    case 'model_missing':
      return {
        title: `Model "${health.model}" is not pulled`,
        body: 'Ollama is running but doesn\'t have this model yet. Download it with:',
        command: `ollama pull ${health.model}`,
      }
    case 'no_model':
      return {
        title: 'No Ollama model selected',
        body: 'Pick the model to chat with in Settings → Agent.',
      }
  }
}

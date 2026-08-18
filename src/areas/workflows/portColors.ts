/**
 * Port colours, shared by node handles, type badges and edge gradients so the
 * three can't drift apart (they used to be copy-pasted in each file).
 *
 * `llm` is not a data type: it marks the model-provider connection (an LLM node
 * feeding an extension's `llm-model` param), the way n8n separates its
 * `ai_languageModel` connector from the main data flow.
 */
export const HANDLE_COLOR: Record<string, string> = {
  audio: '#34d399',
  image: '#38bdf8',
  mesh:  '#a78bfa',
  text:  '#fbbf24',
  llm:   '#f472b6',
}

export const FALLBACK_COLOR = '#52525b'

export const TAG_CLS: Record<string, string> = {
  audio: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
  image: 'border-sky-500/30 bg-sky-500/10 text-sky-400',
  mesh:  'border-violet-500/30 bg-violet-500/10 text-violet-400',
  text:  'border-amber-500/30 bg-amber-500/10 text-amber-400',
  llm:   'border-pink-500/30 bg-pink-500/10 text-pink-400',
}

export const TAG_FALLBACK = 'border-zinc-700 bg-zinc-800 text-zinc-400'

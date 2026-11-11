import { useCallback, useEffect, useRef, useState } from 'react'
import { ollamaAdvice, ollamaHealthUrl, parseOllamaHealth } from '@shared/utils/ollamaHealth'
import type { OllamaHealth } from '@shared/utils/ollamaHealth'

/**
 * Pings Ollama (through the Modly API) when `enabled` — on mount and whenever
 * the URL or model changes. `check()` re-pings on demand and resolves with the
 * fresh result. A failure to reach the Modly API itself yields null: the panel
 * reports that separately.
 */
export function useOllamaHealth(enabled: boolean, apiUrl: string, baseUrl: string, model: string) {
  const [health, setHealth]     = useState<OllamaHealth | null>(null)
  const [checking, setChecking] = useState(false)
  const seq                     = useRef(0)

  const check = useCallback(async (): Promise<OllamaHealth | null> => {
    if (!enabled) return null
    const n = ++seq.current
    setChecking(true)
    let result: OllamaHealth | null = null
    try {
      const res = await fetch(ollamaHealthUrl(apiUrl, baseUrl, model))
      result = res.ok ? parseOllamaHealth(await res.json()) : null
    } catch {
      result = null
    }
    // A later check (model switched mid-flight) wins.
    if (n === seq.current) {
      setHealth(result)
      setChecking(false)
    }
    return result
  }, [enabled, apiUrl, baseUrl, model])

  useEffect(() => { void check() }, [check])

  return { health: enabled ? health : null, checking, check }
}

interface Props {
  health: OllamaHealth | null
  checking: boolean
  onRetry: () => void
}

export default function OllamaBanner({ health, checking, onRetry }: Props): JSX.Element | null {
  const [copied, setCopied] = useState(false)
  const advice = health ? ollamaAdvice(health) : null
  if (!advice) return null

  function copy(command: string) {
    navigator.clipboard?.writeText(command).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => {})
  }

  return (
    <div role="alert" className="mx-3 mt-2 shrink-0 rounded-xl border border-amber-700/40 bg-amber-950/30 px-3 py-2.5 flex flex-col gap-1.5">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11.5px] font-medium text-amber-300">{advice.title}</p>
        <button
          onClick={onRetry}
          disabled={checking}
          className="shrink-0 text-[10.5px] text-amber-400/80 hover:text-amber-200 disabled:opacity-50 transition-colors"
        >
          {checking ? 'Checking…' : 'Retry'}
        </button>
      </div>
      <p className="text-[11px] leading-relaxed text-zinc-400">{advice.body}</p>
      {advice.command && (
        <div className="flex items-center gap-2 rounded-lg bg-zinc-950/60 border border-zinc-800 px-2 py-1">
          <code className="flex-1 truncate font-mono text-[11px] text-zinc-200">{advice.command}</code>
          <button
            onClick={() => copy(advice.command!)}
            title="Copy command"
            className="shrink-0 text-[10.5px] text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
    </div>
  )
}

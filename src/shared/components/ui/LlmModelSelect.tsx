import { useLlmModels } from '@shared/stores/llmModelsStore'

/**
 * Dropdown of the shared local-LLM library, optionally filtered by category
 * (`tag`). Catalog models that aren't downloaded yet stay visible (marked) so
 * the user can pick ONE and download only that one in Settings → Agent.
 *
 * Shared by the LLM node and by extension params of type `llm-model`, so both
 * show the same list, the same names and the same warning.
 */
/** A GGUF the user dropped in the models folder has no tags, so the API returns
 *  it for every category ("capabilities unknown" — api/routers/llm.py). Under a
 *  category filter that reads as an endorsement: a general-purpose model showed
 *  up as a CAD model in Text to CAD's picker with nothing to say otherwise. */
function label(m: { source?: string }, tag?: string): string {
  return tag && m.source === 'custom' ? ' — custom, not verified for this use' : ''
}

export default function LlmModelSelect({ value, tag, disabled, className, onChange }: {
  value:      string
  tag?:       string
  disabled?:  boolean
  className?: string
  onChange:   (v: string) => void
}) {
  const { models } = useLlmModels(tag)

  const ready   = models.filter((m) => m.downloaded)
  const missing = models.filter((m) => !m.downloaded)
  const selectedMissing = missing.some((m) => m.id === value)

  return (
    <div className="flex flex-col gap-1">
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={`${className ?? ''} ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
      >
        {value && !models.some((m) => m.id === value) && (
          <option value={value}>{value} (unknown model)</option>
        )}
        {/* Whenever nothing is selected, and not only when the library is empty:
            with models present and value === '' the browser displayed the first
            option while the param stayed empty, so the user saw a model chosen
            and preflight said "needs a model selected" with no visible cause. */}
        {!value && (
          <option value="">
            {models.length === 0 ? 'No models — see Settings → Agent' : 'Select a model…'}
          </option>
        )}
        {ready.map((m) => <option key={m.id} value={m.id}>{m.name}{label(m, tag)}</option>)}
        {missing.map((m) => <option key={m.id} value={m.id}>{m.name}{label(m, tag)} — not downloaded</option>)}
      </select>
      {selectedMissing && (
        <p className="text-[9px] text-amber-400/90 leading-snug">
          Download this model in Settings → Agent before running.
        </p>
      )}
    </div>
  )
}

/**
 * How well a model drives the agent — the one thing the model list never said.
 *
 * Size and VRAM are already shown, and both are poor proxies: a 4B tops the
 * tool-calling tests while a 20B sits below it. `agent_tier` comes from the
 * catalog; when Modly's own eval suite has been run against the model, the
 * measured pass rate is shown with it, and everything else is flagged as an
 * estimate so the two are never confused.
 */

export type AgentTier = 'excellent' | 'solid' | 'limited'

export interface AgentGradeInput {
  agent_tier?:   string | null
  agent_score?:  number | null   // 0..1, Modly's eval suite
  agent_note?:   string | null
  agent_source?: string | null   // 'measured' | 'estimate'
}

export interface AgentGrade {
  label:     string
  className: string
  title:     string
}

const TIERS: Record<AgentTier, { label: string; className: string }> = {
  excellent: { label: 'Agent: excellent', className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' },
  solid:     { label: 'Agent: solid',     className: 'border-amber-500/30 bg-amber-500/10 text-amber-400' },
  limited:   { label: 'Agent: limited',   className: 'border-zinc-600/40 bg-zinc-600/10 text-zinc-400' },
}

export function agentGrade(m: AgentGradeInput | null | undefined): AgentGrade | null {
  const tier = m?.agent_tier as AgentTier | undefined
  if (!tier || !(tier in TIERS)) return null
  const { label, className } = TIERS[tier]

  const measured = m?.agent_source === 'measured' && typeof m?.agent_score === 'number'
  const score = measured ? `${Math.round((m!.agent_score as number) * 100)}% on Modly's tool-calling suite` : null
  const title = [score ?? 'Estimated from published benchmarks — not measured in Modly', m?.agent_note]
    .filter(Boolean)
    .join(' · ')

  return { label: measured ? `${label} (${Math.round((m!.agent_score as number) * 100)}%)` : label, className, title }
}

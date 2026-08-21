import type { AnyExtension, ExtensionNode } from '@shared/types/electron.d'

// ─── Shared types ─────────────────────────────────────────────────────────────

export interface DownloadInfo {
  percent: number
  file?: string
  fileIndex?: number
  totalFiles?: number
  status?: string
  bytesDownloaded?: number
  totalBytes?: number
  stalledSeconds?: number
  paused?: boolean
}

export type DownloadMap = Record<string, DownloadInfo>

export type NodeUiState =
  | { kind: 'ready' }                          // no weights required
  | { kind: 'available' }                      // weights not downloaded yet
  | { kind: 'downloading'; dl: DownloadInfo }
  | { kind: 'installed' }

export function nodeHasManagedWeights(node: ExtensionNode): boolean {
  return Boolean(node.hfRepo || node.hasModelSources)
}

export function getNodeState(
  extId: string,
  node: ExtensionNode,
  installedIds: string[],
  downloading: DownloadMap,
): NodeUiState {
  const fullId = `${extId}/${node.id}`
  if (!nodeHasManagedWeights(node)) return { kind: 'ready' }
  const dl = downloading[fullId]
  if (dl) return { kind: 'downloading', dl }
  if (installedIds.includes(fullId)) return { kind: 'installed' }
  return { kind: 'available' }
}

export function extInstallSummary(
  ext: AnyExtension,
  installedIds: string[],
  downloading: DownloadMap,
): { total: number; done: number; installing: boolean; hasAvailable: boolean } {
  const states = ext.nodes.map((n) => getNodeState(ext.id, n, installedIds, downloading))
  return {
    total: states.length,
    done: states.filter((s) => s.kind === 'installed' || s.kind === 'ready').length,
    installing: states.some((s) => s.kind === 'downloading'),
    hasAvailable: states.some((s) => s.kind === 'available'),
  }
}

export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let idx = 0
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024
    idx += 1
  }
  return `${value >= 10 || idx === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[idx]}`
}

// ─── Small visual bits ────────────────────────────────────────────────────────

export function TypePill({ type }: { type: 'model' | 'process' }): JSX.Element {
  return type === 'process' ? (
    <span className="shrink-0 px-1.5 py-0.5 rounded-[5px] text-[10px] font-semibold uppercase tracking-wider bg-emerald-500/10 text-emerald-400 ring-1 ring-inset ring-emerald-500/25">
      Process
    </span>
  ) : (
    <span className="shrink-0 px-1.5 py-0.5 rounded-[5px] text-[10px] font-semibold uppercase tracking-wider bg-accent/15 text-accent-light ring-1 ring-inset ring-accent/30">
      Model
    </span>
  )
}

export function IOBadge({ node }: { node: ExtensionNode }): JSX.Element {
  const inputs = node.inputs?.length ? node.inputs : [node.input]
  return (
    <span className="flex items-center gap-1 font-mono text-[10px] text-zinc-600 shrink-0">
      {inputs.map((inp, i) => (
        <span key={i} className="px-1.5 py-0.5 rounded-[5px] bg-white/5 text-zinc-400">{inp}</span>
      ))}
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-600 shrink-0">
        <path d="M5 12h13M13 6l6 6-6 6" />
      </svg>
      <span className="px-1.5 py-0.5 rounded-[5px] bg-white/5 text-zinc-400">{node.output}</span>
    </span>
  )
}

const LED_TONES = {
  green:  'bg-emerald-400 shadow-[0_0_0_3px_rgba(52,211,153,0.12)]',
  amber:  'bg-amber-400 shadow-[0_0_0_3px_rgba(251,191,36,0.12)]',
  violet: 'bg-accent-light shadow-[0_0_0_3px_rgba(139,92,246,0.16)] animate-pulse',
} as const

const TEXT_TONES = {
  green:  'text-emerald-400',
  amber:  'text-amber-400',
  violet: 'text-accent-light',
} as const

export function StatusBadge({ tone, children }: { tone: keyof typeof LED_TONES; children: React.ReactNode }): JSX.Element {
  return (
    <span className={`inline-flex items-center gap-2 text-[11.5px] font-medium ${TEXT_TONES[tone]}`}>
      <span className={`w-[7px] h-[7px] rounded-full ${LED_TONES[tone]}`} />
      {children}
    </span>
  )
}

export const ICONS = {
  cube: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" className="w-full h-full">
      <path d="M12 2 3 7v10l9 5 9-5V7l-9-5Z" />
      <path d="m3 7 9 5 9-5M12 12v10" />
    </svg>
  ),
  spark: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="w-full h-full">
      <path d="M12 3v18M3 12h18M6 6l12 12M18 6 6 18" />
    </svg>
  ),
  shield: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full">
      <path d="M12 3 5 6v5c0 4 3 6.5 7 8 4-1.5 7-4 7-8V6l-7-3Z" />
      <path d="m9.3 11.5 1.8 1.8 3.6-3.6" />
    </svg>
  ),
  download: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full">
      <path d="M12 3v12M7 11l5 5 5-5M5 20h14" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full">
      <path d="m5 12 4.5 4.5L19 7" />
    </svg>
  ),
}

// ─── Per-node install control (shared between card and drawer) ────────────────

interface NodeControlProps {
  state: NodeUiState
  disabled?: boolean
  onInstall: () => void
  onPause: () => void
  onResume: () => void
  onCancel: () => void
}

export function NodeInstallControl({ state, disabled, onInstall, onPause, onResume, onCancel }: NodeControlProps): JSX.Element | null {
  if (state.kind === 'ready') return null

  if (state.kind === 'installed') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-emerald-400">
        <span className="w-3 h-3">{ICONS.check}</span>
        Installed
      </span>
    )
  }

  if (state.kind === 'downloading') {
    const { dl } = state
    const paused = dl.paused ?? false
    return (
      <span className="flex items-center gap-1.5">
        <span className="flex flex-col items-end gap-1">
          <span className="block w-[84px] h-1 rounded-full bg-zinc-800 overflow-hidden">
            <span
              className={`block h-full rounded-full transition-all duration-300 ${paused ? 'bg-zinc-500' : 'bg-gradient-to-r from-accent to-accent-light'}`}
              style={{ width: `${dl.percent}%` }}
            />
          </span>
          <span className={`font-mono text-[10px] ${paused ? 'text-zinc-500' : 'text-accent-light'}`}>
            {paused ? 'Paused' : `${dl.percent}%`}
          </span>
        </span>
        <button
          onClick={(e) => { e.stopPropagation(); paused ? onResume() : onPause() }}
          title={paused ? 'Resume download' : 'Pause download'}
          className="p-1 rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
        >
          {paused ? (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
          )}
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onCancel() }}
          title="Cancel download"
          className="p-1 rounded-md text-zinc-500 hover:text-red-400 hover:bg-red-950/40 transition-colors"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </span>
    )
  }

  return (
    <button
      onClick={(e) => { e.stopPropagation(); onInstall() }}
      disabled={disabled}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[7px] text-[11px] font-semibold bg-accent/15 text-accent-light ring-1 ring-inset ring-accent/30 hover:bg-accent hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-accent/15 disabled:hover:text-accent-light"
    >
      <span className="w-3 h-3">{ICONS.download}</span>
      Install
    </button>
  )
}

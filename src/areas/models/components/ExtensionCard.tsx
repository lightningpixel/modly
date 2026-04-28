import { useState } from 'react'
import type { AnyExtension } from '@shared/types/electron.d'
export type { AnyExtension as Extension }
export type { ExtensionNode } from '@shared/types/electron.d'

interface Props {
  ext:              AnyExtension
  installedIds:     string[]
  downloading:      Record<string, {
    percent: number
    file?: string
    fileIndex?: number
    totalFiles?: number
    status?: string
    bytesDownloaded?: number
    totalBytes?: number
    stalledSeconds?: number
  }>
  loadError?:       string
  disabled?:        boolean
  onInstall:        (node: import('@shared/types/electron.d').ExtensionNode, fullId: string) => void
  onUninstall:      (extId: string) => void
  onUninstallNode?: (fullId: string) => void
  onRepaired?:      () => void
}

const TYPE_BADGE: Record<string, { label: string; cls: string }> = {
  model:   { label: 'Model',   cls: 'bg-accent/15 border-accent/25 text-accent-light' },
  process: { label: 'Process', cls: 'bg-emerald-500/15 border-emerald-500/25 text-emerald-400' },
}

function TruncatedText({
  content,
  className,
}: {
  content?: string
  className: string
}): JSX.Element {
  const text = content?.trim() || '—'
  return <span className={className}>{text}</span>
}

export function ExtensionCard({ ext, installedIds, downloading, loadError, disabled, onInstall, onUninstall, onUninstallNode, onRepaired }: Props): JSX.Element {
  const [repairing,   setRepairing]   = useState(false)
  const [repairError, setRepairError] = useState<string | null>(null)

  const badge = TYPE_BADGE[ext.type] ?? TYPE_BADGE.model

  async function handleRepair() {
    setRepairing(true)
    setRepairError(null)
    const result = await window.electron.extensions.repair(ext.id)
    setRepairing(false)
    if (result.success) {
      onRepaired?.()
    } else {
      setRepairError(result.error ?? 'Repair failed')
    }
  }

  function formatBytes(bytes?: number): string {
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

  return (
    <div className="flex flex-col gap-3 px-4 py-4 rounded-2xl border border-zinc-800 bg-zinc-900/60 hover:border-zinc-700 transition-all overflow-hidden">

      {/* Header */}
      <div className="flex items-start gap-2.5">
        <div className="shrink-0 w-8 h-8 rounded-xl bg-zinc-800 border border-zinc-700/50 flex items-center justify-center text-zinc-400">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/>
            <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
            <line x1="12" y1="22.08" x2="12" y2="12"/>
          </svg>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <TruncatedText content={ext.name} className="text-xs font-semibold text-zinc-200 truncate leading-tight max-w-full" />

            {/* Type badge */}
            <span className={`inline-flex items-center px-1.5 py-0.5 rounded-md border text-[10px] font-semibold shrink-0 ${badge.cls}`}>
              {badge.label}
            </span>

            {/* Trust badge — only shown for official extensions */}
            {ext.trusted && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-zinc-800/80 border border-zinc-700/40 text-zinc-400 text-[10px] font-medium shrink-0">
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                  <polyline points="9 12 11 14 15 10"/>
                </svg>
                Official
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5 mt-0.5">
            {ext.version && (
              <span className="text-[10px] text-zinc-500 font-mono">v{ext.version}</span>
            )}
            {ext.author && (
              <span className="text-[10px] text-zinc-600">{ext.author}</span>
            )}
          </div>
        </div>

        {/* Uninstall button */}
        {!ext.builtin && (
          <button
            onClick={() => onUninstall(ext.id)}
            disabled={disabled}
            title={disabled ? 'Cannot uninstall while an install is in progress' : 'Uninstall extension'}
            className="shrink-0 p-1.5 rounded-lg text-zinc-700 hover:text-red-400 hover:bg-red-950/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:text-zinc-700 disabled:hover:bg-transparent"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
              <path d="M10 11v6M14 11v6"/>
              <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
            </svg>
          </button>
        )}
      </div>

      {/* Load error */}
      {(loadError || repairError) && (
        <div className="flex flex-col gap-1.5 px-2.5 py-2 rounded-lg bg-red-950/30 border border-red-800/30">
          <div className="flex items-start gap-1.5">
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-red-400 shrink-0 mt-px">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <p className="text-[10px] text-red-400 break-all">{repairError ?? loadError}</p>
          </div>
          {!repairError && ext.type === 'model' && (
            <button
              onClick={handleRepair}
              disabled={repairing || disabled}
              className="flex items-center justify-center gap-1 w-full py-1 rounded-md bg-red-900/40 border border-red-700/40 text-[10px] font-semibold text-red-300 hover:bg-red-900/60 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {repairing ? (
                <div className="w-2.5 h-2.5 rounded-full border border-red-400/40 border-t-red-300 animate-spin" />
              ) : (
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/>
                </svg>
              )}
              {repairing ? 'Repairing…' : 'Repair (re-run setup)'}
            </button>
          )}
        </div>
      )}

      {/* Description */}
      {ext.description && (
        <p className="text-[11px] text-zinc-500 leading-relaxed line-clamp-2">{ext.description}</p>
      )}

      {/* Nodes */}
      {ext.nodes.length > 0 && (
        <div className="flex flex-col gap-2 pt-2 border-t border-zinc-800/60">
          {ext.nodes.map((node) => {
            const fullId        = `${ext.id}/${node.id}`
            const hasWeights    = !!node.hfRepo
            const installed     = !hasWeights || installedIds.includes(fullId)
            const dlInfo        = downloading[fullId]
            const isDownloading = dlInfo !== undefined
            const dlPercent     = dlInfo?.percent ?? 0
            const dlFile        = dlInfo?.file
            const dlFileIndex   = dlInfo?.fileIndex
            const dlTotalFiles  = dlInfo?.totalFiles
            const dlStatus      = dlInfo?.status
            const dlBytes       = dlInfo?.bytesDownloaded
            const dlTotalBytes  = dlInfo?.totalBytes
            const dlStalled     = dlInfo?.stalledSeconds ?? 0

            return (
              <div key={node.id} className="flex items-center gap-2">
                {/* Node name */}
                <TruncatedText content={node.name} className="text-[11px] text-zinc-400 font-medium shrink-0 truncate max-w-[5rem]" />

                {/* I/O types */}
                <div className="flex items-center gap-1 shrink-0">
                  <span className="text-[9px] text-zinc-600">{node.input}</span>
                  <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-zinc-700 shrink-0">
                    <path d="M5 12h14M13 6l6 6-6 6"/>
                  </svg>
                  <span className="text-[9px] text-zinc-600">{node.output}</span>
                </div>

                {/* Status (only for nodes that need model weights) */}
                <div className="flex-1 min-w-0">
                  {!hasWeights ? (
                    <div className="flex items-center gap-1 px-2 py-1 rounded-lg bg-emerald-950/40 border border-emerald-800/30">
                      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-emerald-400 shrink-0">
                        <polyline points="20 6 9 17 4 12"/>
                      </svg>
                      <span className="text-[10px] font-semibold text-emerald-400">Ready</span>
                    </div>
                  ) : installed ? (
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-emerald-950/40 border border-emerald-800/30">
                      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-emerald-400 shrink-0">
                        <polyline points="20 6 9 17 4 12"/>
                      </svg>
                      <TruncatedText content={node.name} className="text-[10px] font-semibold text-emerald-400 flex-1 truncate" />
                      {onUninstallNode && (
                        <button
                          onClick={(e) => { e.stopPropagation(); onUninstallNode(fullId) }}
                          disabled={disabled}
                          title="Remove model weights"
                          className="shrink-0 text-emerald-700 hover:text-red-400 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                            <polyline points="3 6 5 6 21 6"/>
                            <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
                          </svg>
                        </button>
                      )}
                    </div>
                  ) : isDownloading ? (
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center justify-between">
                        <TruncatedText
                          content={dlFile ?? dlStatus ?? 'Downloading…'}
                          className="text-[10px] text-zinc-500 truncate max-w-[140px]"
                        />
                        <span className="text-[10px] font-mono text-zinc-400 shrink-0 ml-1">
                          {dlFileIndex && dlTotalFiles ? `${dlFileIndex}/${dlTotalFiles} · ${dlPercent}%` : `${dlPercent}%`}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <TruncatedText content={dlStatus ?? 'Downloading…'} className="text-[9px] text-zinc-600 truncate" />
                        <span className={`text-[9px] shrink-0 ${dlStalled >= 30 ? 'text-amber-400' : 'text-zinc-600'}`}>
                          {dlStalled >= 30 ? `No progress ${dlStalled}s` : formatBytes(dlBytes)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <TruncatedText
                          content={dlTotalBytes && dlTotalBytes > 0
                            ? `${formatBytes(dlBytes)} / ${formatBytes(dlTotalBytes)}`
                            : formatBytes(dlBytes)}
                          className="text-[9px] text-zinc-600 truncate"
                        />
                        {dlTotalBytes && dlTotalBytes > 0 && (
                          <span className="text-[9px] text-zinc-600 shrink-0">
                            {Math.min(100, Math.round(((dlBytes ?? 0) / dlTotalBytes) * 100))}%
                          </span>
                        )}
                      </div>
                      <div className="h-1 rounded-full bg-zinc-800 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-accent transition-all duration-300"
                          style={{ width: `${dlPercent}%` }}
                        />
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => !disabled && onInstall(node, fullId)}
                      disabled={disabled}
                      className={`w-full flex items-center justify-center gap-1 px-2 py-1 rounded-lg border text-[10px] font-semibold transition-all ${
                        !disabled
                          ? 'bg-accent/15 border-accent/25 text-accent-light hover:bg-accent/25 hover:border-accent/40 cursor-pointer'
                          : 'bg-zinc-800/40 border-zinc-700/30 text-zinc-600 cursor-not-allowed'
                      }`}
                    >
                      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                        <polyline points="7 10 12 15 17 10"/>
                        <line x1="12" y1="15" x2="12" y2="3"/>
                      </svg>
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

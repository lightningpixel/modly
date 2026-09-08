import { useEffect, useState } from 'react'
import type { AnyExtension } from '@shared/types/electron.d'
import type { ExtensionNode } from '@shared/types/electron.d'
export type { AnyExtension as Extension }
export type { ExtensionNode } from '@shared/types/electron.d'

import {
  DownloadMap,
  ICONS,
  IOBadge,
  NodeInstallControl,
  StatusBadge,
  TypePill,
  extInstallSummary,
  getNodeState,
} from './extensionShared'

interface Props {
  ext:              AnyExtension
  installedIds:     string[]
  downloading:      DownloadMap
  loadError?:       string
  disabled?:        boolean
  onInstall:        (node: ExtensionNode, fullId: string) => void
  onInstallAll:     (ext: AnyExtension) => void
  onPauseDownload:  (fullId: string) => void
  onCancelDownload: (fullId: string) => void
  onOpen:           (ext: AnyExtension) => void
}

export function ExtensionCard({
  ext, installedIds, downloading, loadError, disabled,
  onInstall, onInstallAll, onPauseDownload, onCancelDownload, onOpen,
}: Props): JSX.Element {
  const isModel = ext.type === 'model'
  const isLocal = typeof ext.source === 'string' && ext.source.startsWith('local://')
  const { total, done, installing, hasAvailable } = extInstallSummary(ext, installedIds, downloading)

  // Readiness state for model nodes
  const [readiness, setReadiness] = useState<Record<string, { ready: boolean; status: string }>>({})

  useEffect(() => {
    if (!isModel) return
    let mounted = true
    const checkReadiness = async () => {
      for (const node of ext.nodes) {
        if (!node.hfRepo) continue
        const fullId = `${ext.id}/${node.id}`
        try {
          const result = await window.electron.model.readiness(fullId)
          if (mounted) {
            setReadiness(prev => ({ ...prev, [fullId]: { ready: result.ready, status: result.status } }))
          }
        } catch { /* ignore */ }
      }
    }
    checkReadiness()
    const interval = setInterval(checkReadiness, 30000) // Refresh every 30s
    return () => { mounted = false; clearInterval(interval) }
  }, [ext.id, ext.nodes, isModel])

  const handleOpen = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    onOpen(ext)
  }
  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onOpen(ext)
    }
  }

  let status: JSX.Element
  if (loadError) {
    status = <StatusBadge tone="amber">Load error</StatusBadge>
  } else if (installing) {
    status = <StatusBadge tone="violet">Installing…</StatusBadge>
  } else if (!isModel) {
    status = <StatusBadge tone="green">Ready</StatusBadge>
  } else if (done === total) {
    status = <StatusBadge tone="green">All nodes ready</StatusBadge>
  } else {
    status = <StatusBadge tone="amber">{done}/{total} nodes installed</StatusBadge>
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleOpen}
      onKeyDown={handleKey}
      aria-label={`${ext.name} — open details`}
      className="relative flex flex-col min-h-[218px] p-4 rounded-2xl bg-zinc-900/60 border border-zinc-800 overflow-hidden cursor-pointer transition-all duration-150 hover:bg-zinc-900 hover:border-zinc-700 hover:-translate-y-0.5 hover:shadow-[0_14px_30px_-14px_rgba(0,0,0,0.7)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
    >
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className={`shrink-0 w-10 h-10 p-2.5 rounded-[11px] bg-zinc-800 ring-1 ring-inset ring-zinc-700/50 ${isModel ? 'text-accent-light' : 'text-emerald-400'}`}>
          {isModel ? ICONS.spark : ICONS.cube}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-zinc-100 truncate">{ext.name}</span>
            <TypePill type={ext.type} />
          </div>
          <div className="flex items-center gap-1.5 mt-1 text-[11px] text-zinc-600 flex-wrap">
            {ext.version && <span className="font-mono text-zinc-500">v{ext.version}</span>}
            {ext.version && ext.author && <span className="opacity-50">·</span>}
            {ext.author && <span>{ext.author}</span>}
            {ext.trusted && (
              <>
                <span className="opacity-50">·</span>
                <span className="inline-flex items-center gap-1 text-zinc-500">
                  <span className="w-[11px] h-[11px] text-accent-light">{ICONS.shield}</span>
                  Official
                </span>
              </>
            )}
            {isLocal && (
              <>
                <span className="opacity-50">·</span>
                <span className="text-orange-400/80">Local</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Description */}
      <p className="mt-3 text-xs leading-5 text-zinc-500 line-clamp-2 min-h-[2.5rem]">
        {ext.description?.trim() || '—'}
      </p>

      {/* Load error */}
      {loadError && (
        <div className="mt-2 px-2.5 py-1.5 rounded-lg bg-red-950/30 border border-red-800/30">
          <p className="text-[10px] text-red-400 line-clamp-1 break-all">{loadError}</p>
        </div>
      )}

      {/* Nodes */}
      {ext.nodes.length > 0 && (
        <div className="mt-3 flex flex-col gap-1.5">
          {ext.nodes.map((node) => {
            const fullId = `${ext.id}/${node.id}`
            const state = getNodeState(ext.id, node, installedIds, downloading)
            const nodeReadiness = readiness[fullId]
            return (
              <div
                key={node.id}
                className="flex items-center justify-between gap-2.5 px-2.5 py-1.5 rounded-lg bg-white/[0.02] border border-zinc-800"
              >
                <div className="flex flex-col gap-1 min-w-0 items-start">
                  <span className="text-xs font-medium text-zinc-200 truncate max-w-full">{node.name}</span>
                  <IOBadge node={node} />
                </div>
                {isModel && (
                  <div className="shrink-0 flex items-center gap-2">
                    {nodeReadiness && (
                      <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded ${nodeReadiness.ready ? 'bg-emerald-500/20 text-emerald-400' : nodeReadiness.status === 'weights_missing' ? 'bg-amber-500/20 text-amber-400' : 'bg-violet-500/20 text-violet-400'}`}>
                        {nodeReadiness.ready ? 'Ready' : nodeReadiness.status === 'weights_missing' ? 'Weights missing' : 'Setup required'}
                      </span>
                    )}
                    <NodeInstallControl
                      state={state}
                      disabled={disabled}
                      onInstall={() => onInstall(node, fullId)}
                      onPause={() => onPauseDownload(fullId)}
                      onResume={() => onInstall(node, fullId)}
                      onCancel={() => onCancelDownload(fullId)}
                    />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Footer */}
      <div className="mt-auto pt-3 flex items-center justify-between gap-2">
        {status}
        {isModel && hasAvailable && !installing && (
          <button
            onClick={(e) => { e.stopPropagation(); onInstallAll(ext) }}
            disabled={disabled}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-accent/15 text-accent-light ring-1 ring-inset ring-accent/30 hover:bg-accent hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-accent/15 disabled:hover:text-accent-light"
          >
            <span className="w-3 h-3">{ICONS.download}</span>
            Install all
          </button>
        )}
      </div>
    </div>
  )
}

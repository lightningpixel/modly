import { useEffect, useState } from 'react'
import type { AnyExtension, ExtensionNode } from '@shared/types/electron.d'
import { useNavStore } from '@shared/stores/navStore'
import { getLocalSourcePath, localExtensionSetupMessage, supportsExtensionRepair } from '../utils'
import {
  DownloadMap,
  ICONS,
  IOBadge,
  NodeInstallControl,
  TypePill,
  extInstallSummary,
  formatBytes,
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
  onUninstallNode:  (fullId: string) => void
  onUninstall:      (extId: string) => void
  onRepaired:       () => void
  onSynced:         () => void
  onClose:          () => void
}

export function ExtensionDrawer({
  ext, installedIds, downloading, loadError, disabled,
  onInstall, onInstallAll, onPauseDownload, onCancelDownload,
  onUninstallNode, onUninstall, onRepaired, onSynced, onClose,
}: Props): JSX.Element {
  const navigate = useNavStore((s) => s.navigate)
  const [repairing,   setRepairing]   = useState(false)
  const [repairError, setRepairError] = useState<string | null>(null)
  const [syncing,     setSyncing]     = useState(false)
  const [syncError,   setSyncError]   = useState<string | null>(null)

  const isModel     = ext.type === 'model'
  const repairable  = supportsExtensionRepair(ext)
  // Built-ins are corrupted-flagged too (builtin-sync repairs them on restart),
  // but they can't be deleted — show the banner without the delete action.
  const isCorrupted = !!ext.corrupted
  const corruptedMsg =
    ext.manifestError === 'invalid'
      ? 'This extension folder has a manifest that cannot be parsed. Fix the JSON syntax in its manifest.json, or delete the folder and reinstall.'
      : ext.manifestError === 'incomplete'
        ? 'A previous install of this extension never completed. Delete the folder, then install the extension again.'
        : 'This extension folder is incomplete (its manifest is missing) — usually the leftover of an interrupted install. Delete the folder, then install the extension again.'
  const localPath = getLocalSourcePath(ext)
  const isLocal = localPath !== null
  const localSetupMessage = localExtensionSetupMessage(ext)
  const { total, done, installing, hasAvailable } = extInstallSummary(ext, installedIds, downloading)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  async function handleRepair() {
    setRepairing(true)
    setRepairError(null)
    const result = await window.electron.extensions.repair(ext.id)
    setRepairing(false)
    if (result.success) onRepaired()
    else setRepairError(result.error ?? 'Repair failed')
  }

  async function handleSync() {
    setSyncing(true)
    setSyncError(null)
    try {
      const result = await window.electron.extensions.reload()
      if (!result.success) setSyncError(result.error ?? 'Sync failed')
      else onSynced()
    } catch (e) {
      setSyncError(String(e))
    } finally {
      setSyncing(false)
    }
  }

  const error = syncError ?? repairError ?? loadError

  return (
    <>
      {/* Overlay */}
      <div
        className="absolute inset-0 z-40 bg-zinc-950/50 backdrop-blur-[2px] animate-fade-in"
        onClick={onClose}
      />

      {/* Drawer */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={ext.name}
        className="absolute inset-y-0 right-0 z-50 w-[418px] max-w-[92%] flex flex-col bg-zinc-950 border-l border-zinc-700/60 shadow-[-30px_0_60px_rgba(0,0,0,0.5)] animate-drawer-in"
      >
        {/* Head */}
        <div className="relative px-5 pt-5 pb-4 border-b border-zinc-800/80 shrink-0">
          <button
            onClick={onClose}
            title="Close"
            className="absolute right-4 top-4 w-[30px] h-[30px] grid place-items-center rounded-lg text-zinc-600 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
              <path d="M5 5l14 14M19 5 5 19" />
            </svg>
          </button>
          <div className="flex items-center gap-3.5 pr-8">
            <div className={`shrink-0 w-[52px] h-[52px] p-3 rounded-[13px] bg-zinc-800 ring-1 ring-inset ring-zinc-700/50 ${isModel ? 'text-accent-light' : 'text-emerald-400'}`}>
              {isModel ? ICONS.spark : ICONS.cube}
            </div>
            <div className="min-w-0">
              <h3 className="text-lg font-semibold text-zinc-100 leading-tight truncate">{ext.name}</h3>
              <div className="flex items-center gap-2 mt-1.5 text-xs text-zinc-600 flex-wrap">
                <TypePill type={ext.type} />
                {ext.version && <span className="font-mono text-zinc-500">v{ext.version}</span>}
                {ext.trusted && (
                  <span className="inline-flex items-center gap-1 text-accent-light">
                    <span className="w-[11px] h-[11px]">{ICONS.shield}</span>
                    Official
                  </span>
                )}
                {isLocal && <span className="text-orange-400/80">Local</span>}
              </div>
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-5">
          {/* Corrupted install */}
          {isCorrupted && (
            <div className="mb-5 flex items-start gap-2.5 px-3 py-3 rounded-lg bg-amber-950/30 border border-amber-800/40">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-amber-400 shrink-0 mt-0.5">
                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <div className="min-w-0">
                <p className="text-[12px] font-semibold text-amber-400">Corrupted installation</p>
                <p className="text-[11px] leading-5 text-amber-400/80 mt-1">
                  {ext.builtin ? 'This built-in extension folder is damaged — restart Modly to let it re-sync.' : corruptedMsg}
                </p>
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="mb-5 flex items-start gap-2 px-3 py-2.5 rounded-lg bg-red-950/30 border border-red-800/30">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-red-400 shrink-0 mt-0.5">
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <p className="text-[11px] text-red-400 break-all">{error}</p>
            </div>
          )}

          {localSetupMessage && (
            <div className="mb-5 px-3 py-2.5 rounded-lg bg-orange-950/20 border border-orange-800/30">
              <p className="text-[11px] leading-5 text-orange-300/80">{localSetupMessage}</p>
            </div>
          )}

          {/* Description */}
          <div className="mb-6">
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-zinc-600 mb-2.5">Description</div>
            <p className="text-[13px] leading-6 text-zinc-400">{ext.description?.trim() || 'No description provided.'}</p>
          </div>

          {/* Nodes */}
          <div className="mb-6">
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-zinc-600 mb-2.5">
              {isModel ? `Nodes · ${done}/${total} installed` : `Actions · ${total}`}
            </div>
            <div className="flex flex-col gap-2">
              {ext.nodes.map((node) => {
                const fullId = `${ext.id}/${node.id}`
                const state = getNodeState(ext.id, node, installedIds, downloading)
                const dl = state.kind === 'downloading' ? state.dl : null
                const sub =
                  state.kind === 'ready'       ? 'Available on the node graph'
                  : state.kind === 'installed' ? 'Installed'
                  : state.kind === 'available' ? 'Not installed'
                  : dl?.paused                 ? 'Download paused'
                  : `Downloading… ${dl?.percent ?? 0}%`

                return (
                  <div key={node.id} className="px-3.5 py-3 rounded-[10px] bg-zinc-900/70 border border-zinc-800">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-[13px] font-semibold text-zinc-200 truncate">{node.name}</div>
                        <div className="text-[11px] text-zinc-600 mt-0.5 truncate">{sub}</div>
                      </div>
                      <div className="flex flex-col items-end gap-2 shrink-0">
                        <IOBadge node={node} />
                        {isModel && (
                          <div className="flex items-center gap-1.5">
                            <NodeInstallControl
                              state={state}
                              disabled={disabled}
                              onInstall={() => onInstall(node, fullId)}
                              onPause={() => onPauseDownload(fullId)}
                              onResume={() => onInstall(node, fullId)}
                              onCancel={() => onCancelDownload(fullId)}
                            />
                            {state.kind === 'installed' && (
                              <button
                                onClick={() => onUninstallNode(fullId)}
                                disabled={disabled}
                                title="Remove model weights"
                                className="p-1 rounded-md text-zinc-600 hover:text-red-400 hover:bg-red-950/40 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                              >
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                                  <polyline points="3 6 5 6 21 6" />
                                  <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                                </svg>
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Download detail */}
                    {dl && (
                      <div className="mt-3 flex flex-col gap-1">
                        <div className="flex items-center justify-between gap-2 text-[10px] text-zinc-600">
                          <span className="truncate">{dl.paused ? 'Paused' : (dl.file ?? dl.status ?? 'Downloading…')}</span>
                          <span className="font-mono shrink-0">
                            {dl.fileIndex && dl.totalFiles ? `${dl.fileIndex}/${dl.totalFiles} · ${dl.percent}%` : `${dl.percent}%`}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-2 text-[10px]">
                          <span className="text-zinc-600 truncate">
                            {dl.totalBytes && dl.totalBytes > 0
                              ? `${formatBytes(dl.bytesDownloaded)} / ${formatBytes(dl.totalBytes)}`
                              : formatBytes(dl.bytesDownloaded)}
                          </span>
                          {(dl.stalledSeconds ?? 0) >= 30 && (
                            <span className="text-amber-400 shrink-0">No progress {dl.stalledSeconds}s</span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {/* Details */}
          <div>
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-zinc-600 mb-2.5">Details</div>
            <dl className="grid grid-cols-[1fr_auto] gap-x-3.5 gap-y-2.5 text-xs">
              <dt className="text-zinc-600">Author</dt>
              <dd className="text-zinc-400 text-right font-mono text-[11.5px]">{ext.author ?? '—'}</dd>
              <dt className="text-zinc-600">Version</dt>
              <dd className="text-zinc-400 text-right font-mono text-[11.5px]">{ext.version ? `v${ext.version}` : '—'}</dd>
              <dt className="text-zinc-600">Source</dt>
              <dd className="text-zinc-400 text-right font-mono text-[11.5px] max-w-[230px] truncate" style={{ direction: 'rtl' }} title={localPath ?? ext.source ?? undefined}>
                {localPath ?? ext.source ?? (ext.builtin ? 'Built-in' : '—')}
              </dd>
              <dt className="text-zinc-600">Nodes</dt>
              <dd className="text-zinc-400 text-right font-mono text-[11.5px]">{ext.nodes.length}</dd>
            </dl>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-zinc-800/80 flex items-center gap-2.5 shrink-0">
          {isCorrupted && !ext.builtin ? (
            <button
              onClick={() => onUninstall(ext.id)}
              disabled={disabled}
              className="flex-1 inline-flex items-center justify-center gap-2 px-3.5 py-2.5 rounded-[9px] text-xs font-semibold bg-red-600/90 text-white hover:bg-red-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                <path d="M10 11v6M14 11v6" />
              </svg>
              Delete broken folder
            </button>
          ) : isModel && hasAvailable ? (
            <button
              onClick={() => onInstallAll(ext)}
              disabled={disabled || installing}
              className="flex-1 inline-flex items-center justify-center gap-2 px-3.5 py-2.5 rounded-[9px] text-xs font-semibold bg-accent text-white hover:bg-accent-dark transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <span className="w-3.5 h-3.5">{ICONS.download}</span>
              {installing ? 'Installing…' : 'Install all nodes'}
            </button>
          ) : (
            <button
              onClick={() => { onClose(); navigate('workflows') }}
              className="flex-1 inline-flex items-center justify-center gap-2 px-3.5 py-2.5 rounded-[9px] text-xs font-semibold bg-accent text-white hover:bg-accent-dark transition-colors"
            >
              Use in workflow
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 6l6 6-6 6" />
              </svg>
            </button>
          )}

          {repairable && !isCorrupted && (
            <button
              onClick={handleRepair}
              disabled={repairing || disabled}
              title="Repair — run setup.py for the extension environment"
              className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-[9px] text-xs font-medium border border-zinc-700/60 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {repairing ? (
                <span className="w-3 h-3 rounded-full border-2 border-zinc-500/40 border-t-zinc-300 animate-spin" />
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M23 4v6h-6" /><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
                </svg>
              )}
              {repairing ? 'Repairing…' : 'Repair'}
            </button>
          )}

          {isLocal && (
            <button
              onClick={handleSync}
              disabled={syncing || disabled}
              title="Sync — reload extension from local folder"
              className="p-2.5 rounded-[9px] border border-zinc-700/60 text-zinc-500 hover:text-orange-400 hover:bg-orange-950/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={syncing ? 'animate-spin' : ''}>
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
              </svg>
            </button>
          )}

          {!ext.builtin && !isCorrupted && (
            <button
              onClick={() => onUninstall(ext.id)}
              disabled={disabled}
              title={isLocal ? 'Unlink local extension (removes symlink only, keeps source folder)' : 'Uninstall extension'}
              className="p-2.5 rounded-[9px] border border-zinc-700/60 text-zinc-600 hover:text-red-400 hover:border-red-800/50 hover:bg-red-950/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isLocal ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
                  <line x1="2" y1="2" x2="22" y2="22" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                  <path d="M10 11v6M14 11v6" />
                  <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
                </svg>
              )}
            </button>
          )}
        </div>
      </aside>
    </>
  )
}

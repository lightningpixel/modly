import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useExtensionsStore } from '@shared/stores/extensionsStore'
import type { AnyExtension, ModelExtension } from '@shared/types/electron.d'
import { formatModelName } from './utils'
import { ExtensionCard } from './components/ExtensionCard'
import type { ExtensionNode } from './components/ExtensionCard'

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ModelsPage(): JSX.Element {
  // Extensions store
  const modelExtensions   = useExtensionsStore((s) => s.modelExtensions)
  const processExtensions = useExtensionsStore((s) => s.processExtensions)
  const extLoading        = useExtensionsStore((s) => s.loading)
  const installProgress   = useExtensionsStore((s) => s.installProgress)
  const installError      = useExtensionsStore((s) => s.installError)
  const loadErrors        = useExtensionsStore((s) => s.loadErrors)
  const loadExtensions    = useExtensionsStore((s) => s.loadExtensions)
  const installFromGH     = useExtensionsStore((s) => s.installFromGitHub)
  const uninstallExt      = useExtensionsStore((s) => s.uninstall)
  const reloadExtensions  = useExtensionsStore((s) => s.reload)
  const clearInstall      = useExtensionsStore((s) => s.clearInstallState)

  // All extensions (model + process), sorted builtin-first then by name
  const allExtensions: AnyExtension[] = [
    ...modelExtensions,
    ...processExtensions,
  ].sort((a, b) => {
    if (a.builtin !== b.builtin) return a.builtin ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  // Model weight state (needed for node install status + uninstall cleanup)
  const [installedVariantIds, setInstalledVariantIds] = useState<string[]>([])
  const [downloading, setDownloading] = useState<Record<string, {
    percent: number
    file?: string
    fileIndex?: number
    totalFiles?: number
    status?: string
    bytesDownloaded?: number
    totalBytes?: number
    stalledSeconds?: number
  }>>({})

  // Uninstall modal state
  const [uninstallTarget, setUninstallTarget] = useState<string | null>(null)
  const [modelsToDelete,  setModelsToDelete]  = useState<Set<string>>(new Set())

  // Search
  const [search, setSearch] = useState('')

  // GitHub extension install form
  const [showGHForm, setShowGHForm] = useState(false)
  const [ghUrl,      setGhUrl]      = useState('')
  const [ghErr,      setGhErr]      = useState<string | null>(null)

  // ── Init ──────────────────────────────────────────────────────────────────

  // Check each model node individually via filesystem IPC — reliable regardless of API state
  async function refreshInstalledIds(exts: ModelExtension[]) {
    const ids: string[] = []
    for (const ext of exts) {
      for (const node of ext.nodes) {
        if (!node.hfRepo) continue
        const fullId = `${ext.id}/${node.id}`
        const ok = await window.electron.model.isDownloaded(fullId, node.downloadCheck)
        if (ok) ids.push(fullId)
      }
    }
    setInstalledVariantIds(ids)
  }

  useEffect(() => {
    loadExtensions().then(() => {
      const exts = useExtensionsStore.getState().modelExtensions
      refreshInstalledIds(exts)
    })
    window.electron.model.onProgress(({ modelId: id, percent, file, fileIndex, totalFiles, status, bytesDownloaded, totalBytes, stalledSeconds }) => {
      setDownloading((prev) => ({ ...prev, [id]: { percent, file, fileIndex, totalFiles, status, bytesDownloaded, totalBytes, stalledSeconds } }))
      if (percent === 100) {
        const exts = useExtensionsStore.getState().modelExtensions
        refreshInstalledIds(exts).then(() => {
          setDownloading((prev) => { const n = { ...prev }; delete n[id]; return n })
        })
      }
    })
    return () => window.electron.model.offProgress()
  }, [])

  useEffect(() => {
    if (installError) setGhErr(installError)
  }, [installError])

  // ── GitHub extension install ───────────────────────────────────────────────

  async function handleGHInstall() {
    const url = ghUrl.trim()
    if (!url) { setGhErr('GitHub URL required'); return }
    if (!url.includes('github.com')) { setGhErr('Must be a GitHub URL'); return }
    setGhErr(null)
    clearInstall()
    const result = await installFromGH(url)
    if (result.success) {
      setShowGHForm(false)
      setGhUrl('')
    } else {
      setGhErr(result.error ?? 'Installation failed')
    }
  }

  // ── Uninstall extension ────────────────────────────────────────────────────

  function openUninstallModal(extId: string) {
    const ext = allExtensions.find((e) => e.id === extId)
    if (ext?.type === 'model') {
      const installedModels = ext.nodes.filter((n) => installedVariantIds.includes(`${extId}/${n.id}`))
      setModelsToDelete(new Set(installedModels.map((n) => `${extId}/${n.id}`)))
    } else {
      setModelsToDelete(new Set())
    }
    setUninstallTarget(extId)
  }

  async function handleUninstallExtension(extId: string) {
    for (const modelId of modelsToDelete) {
      await window.electron.model.delete(modelId)
    }
    await uninstallExt(extId)
    setUninstallTarget(null)
    setModelsToDelete(new Set())
    refreshInstalledIds(useExtensionsStore.getState().modelExtensions)
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  const isInstalling = installProgress !== null &&
    installProgress.step !== 'done' &&
    installProgress.step !== 'error'

  const isBusy = isInstalling || Object.keys(downloading).length > 0

  const filteredExtensions = search.trim()
    ? allExtensions.filter((e) =>
        e.name.toLowerCase().includes(search.trim().toLowerCase()) ||
        (e.description ?? '').toLowerCase().includes(search.trim().toLowerCase()) ||
        (e.author ?? '').toLowerCase().includes(search.trim().toLowerCase())
      )
    : allExtensions

  function installProgressLabel(): string {
    if (!installProgress) return ''
    switch (installProgress.step) {
      case 'downloading': return `Downloading… ${installProgress.percent ?? 0}%`
      case 'extracting':  return 'Extracting…'
      case 'validating':  return 'Validating…'
      case 'setting_up':  return 'Setting up environment…'
      case 'done':        return 'Installed!'
      default:            return ''
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="h-full flex flex-col">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="px-6 pt-6 pb-4 border-b border-zinc-800/60 shrink-0">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-base font-semibold text-zinc-100">Extensions</h1>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setShowGHForm((v) => !v)
                setGhErr(null)
                clearInstall()
              }}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold bg-zinc-800/80 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 transition-all border border-zinc-700/60"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.09-.745.083-.729.083-.729 1.205.085 1.84 1.237 1.84 1.237 1.07 1.835 2.807 1.305 3.492.997.108-.776.418-1.305.762-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.468-2.38 1.235-3.22-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.3 1.23A11.51 11.51 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.29-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.91 1.235 3.22 0 4.61-2.805 5.625-5.475 5.92.43.372.823 1.102.823 2.222 0 1.606-.015 2.896-.015 3.286 0 .322.216.694.825.576C20.565 21.796 24 17.298 24 12c0-6.63-5.37-12-12-12z"/>
              </svg>
              {showGHForm ? 'Cancel' : 'Install from GitHub'}
            </button>
          </div>
        </div>

        {/* Search bar */}
        <div className="flex items-center gap-2">
          <div className="flex-1 flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl bg-zinc-800/60 border border-zinc-700/60 focus-within:border-zinc-500 focus-within:bg-zinc-800 transition-colors">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-zinc-500 shrink-0">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search extensions…"
              className="flex-1 bg-transparent text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none"
            />
            {search && (
              <button onClick={() => setSearch('')} className="text-zinc-600 hover:text-zinc-400 transition-colors">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            )}
            {allExtensions.length > 0 && (
              <span className="text-[11px] text-zinc-600 shrink-0">
                {search.trim() ? `${filteredExtensions.length} / ${allExtensions.length}` : `${allExtensions.length}`}
              </span>
            )}
          </div>
          <button
            onClick={reloadExtensions}
            disabled={extLoading}
            title="Reload extensions"
            className="p-2.5 rounded-xl bg-zinc-800/60 border border-zinc-700/60 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 hover:border-zinc-600 transition-colors disabled:opacity-40"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
              className={extLoading ? 'animate-spin' : ''}>
              <polyline points="23 4 23 10 17 10"/>
              <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/>
            </svg>
          </button>
        </div>
      </div>

      {/* ── GitHub install form ──────────────────────────────────────────── */}
      {showGHForm && (
        <div className="px-6 pt-4 pb-5 border-b border-zinc-800/60 shrink-0 animate-fade-in">
          <div className="flex flex-col gap-3 p-4 rounded-xl bg-zinc-900/80 border border-zinc-800">
            <div className="flex gap-2">
              <input
                type="text"
                value={ghUrl}
                onChange={(e) => { setGhUrl(e.target.value); setGhErr(null); clearInstall() }}
                onKeyDown={(e) => e.key === 'Enter' && !isInstalling && handleGHInstall()}
                placeholder="https://github.com/owner/repo"
                autoFocus
                disabled={isInstalling}
                className="flex-1 px-3 py-2 text-xs rounded-lg bg-zinc-800 border border-zinc-700/60 text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors disabled:opacity-50"
              />
              <button
                onClick={handleGHInstall}
                disabled={!ghUrl.trim() || isInstalling}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-accent hover:bg-accent-dark text-white text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {isInstalling ? (
                  <div className="w-3 h-3 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                ) : (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                    <polyline points="7 10 12 15 17 10"/>
                    <line x1="12" y1="15" x2="12" y2="3"/>
                  </svg>
                )}
                {isInstalling ? installProgressLabel() : 'Install'}
              </button>
            </div>

            {isInstalling && installProgress?.step === 'downloading' && (
              <div className="h-1 rounded-full bg-zinc-800 overflow-hidden">
                <div
                  className="h-full rounded-full bg-accent transition-all duration-300"
                  style={{ width: `${installProgress.percent ?? 0}%` }}
                />
              </div>
            )}

            {isInstalling && installProgress?.step === 'setting_up' && (
              <div className="flex flex-col gap-2 px-3 py-2.5 rounded-lg bg-zinc-800/60 border border-zinc-700/40">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-3 h-3 rounded-full border-2 border-accent/40 border-t-accent animate-spin shrink-0" />
                    <span className="text-[10px] text-zinc-400 truncate">
                      {installProgress.message ?? 'Setting up environment…'}
                    </span>
                  </div>
                  <span className="text-[9px] text-zinc-600 shrink-0">May take a few minutes</span>
                </div>
                {/* Indeterminate progress bar */}
                <div className="h-0.5 rounded-full bg-zinc-700 overflow-hidden">
                  <div className="h-full w-1/3 rounded-full bg-accent animate-[slide_1.5s_ease-in-out_infinite]" />
                </div>
              </div>
            )}

            {installProgress?.step === 'done' && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-950/30 border border-emerald-800/30">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-emerald-400 shrink-0">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
                <p className="text-[11px] text-emerald-400">Extension installed successfully!</p>
              </div>
            )}

            {ghErr && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-950/30 border border-red-800/30">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-red-400 shrink-0">
                  <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                <p className="text-[11px] text-red-400">{ghErr}</p>
              </div>
            )}

            <p className="text-[10px] text-zinc-600">
              The repo must contain a <span className="font-mono text-zinc-500">manifest.json</span> and a <span className="font-mono text-zinc-500">generator.py</span> at its root.
            </p>
          </div>
        </div>
      )}

      {/* ── Extensions list ──────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto p-6">
        {allExtensions.length === 0 && !extLoading ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 rounded-2xl border border-dashed border-zinc-800 bg-zinc-900/20">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" className="text-zinc-700">
              <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/>
              <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
              <line x1="12" y1="22.08" x2="12" y2="12"/>
            </svg>
            <div className="text-center">
              <p className="text-sm font-medium text-zinc-400">No extensions installed</p>
              <p className="text-xs text-zinc-600 mt-1">
                Install from GitHub or drop into the Modly extensions directory.
              </p>
            </div>
          </div>
        ) : extLoading ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-5 h-5 rounded-full border-2 border-zinc-700 border-t-zinc-400 animate-spin" />
          </div>
        ) : filteredExtensions.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-zinc-700">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
            <p className="text-sm text-zinc-500">No results for <span className="text-zinc-300">"{search}"</span></p>
          </div>
        ) : (
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
            {filteredExtensions.map((ext) => (
              <ExtensionCard
                key={ext.id}
                ext={ext}
                installedIds={installedVariantIds}
                downloading={downloading}
                disabled={isBusy}
                loadError={
                  loadErrors[ext.id] ??
                  ext.nodes.map((n) => loadErrors[`${ext.id}/${n.id}`]).find(Boolean)
                }
                onInstall={(node: ExtensionNode, fullId: string) => {
                  if (!node.hfRepo) return
                  setDownloading((prev) => ({ ...prev, [fullId]: { percent: 0 } }))
                  window.electron.model.download(node.hfRepo!, fullId, node.hfSkipPrefixes, node.hfIncludePrefixes).then((result: { success: boolean }) => {
                    if (!result.success) {
                      setGhErr('Download failed')
                      setDownloading((prev) => { const n = { ...prev }; delete n[fullId]; return n })
                    }
                  })
                }}
                onUninstallNode={async (fullId: string) => {
                  await window.electron.model.delete(fullId)
                  refreshInstalledIds(useExtensionsStore.getState().modelExtensions)
                }}
                onUninstall={(extId) => openUninstallModal(extId)}
                onRepaired={() => reloadExtensions()}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Confirm uninstall extension ──────────────────────────────────── */}
      {uninstallTarget && (() => {
        const ext = allExtensions.find((e) => e.id === uninstallTarget)
        const installedModels = ext?.type === 'model'
          ? ext.nodes.filter((n) => installedVariantIds.includes(`${uninstallTarget}/${n.id}`))
          : []

        return createPortal(
          <div
            className="fixed inset-0 z-[9999] flex items-center justify-center"
            onMouseDown={(e) => { if (e.target === e.currentTarget) { setUninstallTarget(null); setModelsToDelete(new Set()) } }}
          >
            <div className="absolute inset-0 bg-zinc-950/70 backdrop-blur-sm animate-fade-in" />
            <div className="relative w-96 rounded-2xl bg-zinc-900 border border-accent/20 shadow-2xl shadow-accent/5 overflow-hidden animate-slide-up-center">
              <div className="px-5 py-5 flex flex-col gap-4">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 bg-accent/10 border border-accent/20">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent-light">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                      <path d="M10 11v6M14 11v6" />
                      <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
                    </svg>
                  </div>
                  <div className="flex flex-col gap-1 pt-0.5">
                    <h2 className="text-base font-semibold text-zinc-100 leading-tight">
                      Uninstall &ldquo;{ext?.name ?? uninstallTarget}&rdquo;?
                    </h2>
                    <p className="text-xs text-zinc-500 leading-relaxed">
                      The extension folder will be permanently deleted.
                    </p>
                  </div>
                </div>

                {installedModels.length > 0 && (
                  <div className="flex flex-col gap-2 px-1">
                    <p className="text-[11px] font-medium text-zinc-400">
                      Also delete downloaded model weights:
                    </p>
                    {installedModels.map((v) => {
                      const id      = `${uninstallTarget}/${v.id}`
                      const checked = modelsToDelete.has(id)
                      return (
                        <label
                          key={v.id}
                          className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-zinc-800/60 border border-zinc-700/40 cursor-pointer hover:border-zinc-600/60 transition-colors"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              setModelsToDelete((prev) => {
                                const next = new Set(prev)
                                if (checked) next.delete(id)
                                else next.add(id)
                                return next
                              })
                            }}
                            className="accent-accent w-3.5 h-3.5 rounded"
                          />
                          <span className="text-xs text-zinc-200">{formatModelName(id)}</span>
                        </label>
                      )
                    })}
                  </div>
                )}

                <div className="flex gap-2.5">
                  <button
                    onClick={() => { setUninstallTarget(null); setModelsToDelete(new Set()) }}
                    className="flex-1 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700/80 text-zinc-400 hover:text-zinc-200 text-sm font-medium transition-colors border border-zinc-700/50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => handleUninstallExtension(uninstallTarget)}
                    className="flex-1 py-2.5 rounded-xl bg-accent hover:bg-accent-dark text-white text-sm font-semibold transition-colors shadow-lg shadow-accent/20"
                  >
                    Uninstall
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body
        )
      })()}
    </div>
  )
}

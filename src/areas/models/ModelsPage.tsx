import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '@shared/stores/appStore'
import { useNavStore } from '@shared/stores/navStore'
import { useExtensionsStore } from '@shared/stores/extensionsStore'
import { useApi } from '@shared/hooks/useApi'
import { ConfirmModal } from '@shared/components/ui'
import { LocalModel } from './models'
import { formatModelName } from './utils'
import { ModelCard } from './components/ModelCard'
import { ExtensionCard, ExtensionVariant } from './components/ExtensionCard'

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ModelsPage(): JSX.Element {
  const setGenerationOptions = useAppStore((s) => s.setGenerationOptions)
  const navigate             = useNavStore((s) => s.navigate)

  // Extensions store
  const extensions       = useExtensionsStore((s) => s.extensions)
  const extLoading       = useExtensionsStore((s) => s.loading)
  const installProgress  = useExtensionsStore((s) => s.installProgress)
  const installError     = useExtensionsStore((s) => s.installError)
  const loadErrors       = useExtensionsStore((s) => s.loadErrors)
  const loadExtensions   = useExtensionsStore((s) => s.loadExtensions)
  const installFromGH    = useExtensionsStore((s) => s.installFromGitHub)
  const uninstallExt     = useExtensionsStore((s) => s.uninstall)
  const reloadExtensions = useExtensionsStore((s) => s.reload)
  const clearInstall     = useExtensionsStore((s) => s.clearInstallState)

  const { getAllModelsStatus } = useApi()

  // HF models state
  const [models,             setModels]             = useState<LocalModel[]>([])
  const [installedVariantIds, setInstalledVariantIds] = useState<string[]>([])
  const [downloading,        setDownloading]        = useState<Record<string, { percent: number; file?: string; fileIndex?: number; totalFiles?: number }>>({})
  const [deleteTarget,       setDeleteTarget]       = useState<LocalModel | null>(null)
  const [deleteError,        setDeleteError]        = useState<string | null>(null)
  const [uninstallTarget,    setUninstallTarget]    = useState<string | null>(null)
  const [modelsToDelete,     setModelsToDelete]     = useState<Set<string>>(new Set())

  // GitHub extension install form
  const [showGHForm, setShowGHForm] = useState(false)
  const [ghUrl,      setGhUrl]      = useState('')
  const [ghErr,      setGhErr]      = useState<string | null>(null)

  // ── Init ────────────────────────────────────────────────────────────────────

  async function refresh() {
    const list = await window.electron.model.listDownloaded()
    setModels(list)
    try {
      const statuses = await getAllModelsStatus()
      setInstalledVariantIds(statuses.filter((s) => s.downloaded).map((s) => s.id))
    } catch {
      // fallback: derive from directory list
      setInstalledVariantIds(list.map((m) => m.id))
    }
  }

  useEffect(() => {
    refresh()
    loadExtensions()
    window.electron.model.onProgress(({ modelId: id, percent, file, fileIndex, totalFiles }) => {
      setDownloading((prev) => ({ ...prev, [id]: { percent, file, fileIndex, totalFiles } }))
      if (percent === 100) {
        setDownloading((prev) => { const n = { ...prev }; delete n[id]; return n })
        refresh()
      }
    })
    return () => window.electron.model.offProgress()
  }, [])

  // Reset GitHub form error when install state clears
  useEffect(() => {
    if (installError) setGhErr(installError)
  }, [installError])

  async function handleDelete(model: LocalModel) {
    const result = await window.electron.model.delete(model.id)
    if (!result.success) {
      setDeleteError('Failed to delete the model. Try restarting the app and deleting again.')
      return
    }
    setDeleteTarget(null)
    setDeleteError(null)
    refresh()
  }

  // ── GitHub extension install logic ─────────────────────────────────────────

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
    const ext = extensions.find((e) => e.id === extId)
    const installedModels = ext?.models.filter((v) => installedVariantIds.includes(v.id)) ?? []
    setModelsToDelete(new Set(installedModels.map((v) => v.id)))
    setUninstallTarget(extId)
  }

  async function handleUninstallExtension(extId: string) {
    // Delete selected models first
    for (const modelId of modelsToDelete) {
      await window.electron.model.delete(modelId)
    }
    const result = await uninstallExt(extId)
    setUninstallTarget(null)
    setModelsToDelete(new Set())
    if (!result.success) {
      console.error('[extensions:uninstall]', result.error)
    }
    refresh()
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  const inProgressIds = Object.keys(downloading)

  const isInstalling = installProgress !== null &&
    installProgress.step !== 'done' &&
    installProgress.step !== 'error'

  const isBusy = isInstalling || inProgressIds.length > 0

  function installProgressLabel(): string {
    if (!installProgress) return ''
    switch (installProgress.step) {
      case 'downloading': return `Downloading… ${installProgress.percent ?? 0}%`
      case 'extracting':  return 'Extracting…'
      case 'validating':  return 'Validating…'
      case 'done':        return 'Installed!'
      default:            return ''
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="h-full flex flex-col">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="px-6 pt-6 pb-4 border-b border-zinc-800/60 shrink-0 flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold text-zinc-100">AI Models</h1>
          <p className="text-xs text-zinc-500 mt-0.5">
            {models.length === 0 && inProgressIds.length === 0
              ? 'No models installed yet'
              : `${models.length} model${models.length !== 1 ? 's' : ''} installed`}
          </p>
        </div>
        <button
          onClick={() => { setShowGHForm((v) => !v); setGhErr(null); clearInstall() }}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-zinc-800/80 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 transition-all"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.09-.745.083-.729.083-.729 1.205.085 1.84 1.237 1.84 1.237 1.07 1.835 2.807 1.305 3.492.997.108-.776.418-1.305.762-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.468-2.38 1.235-3.22-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.3 1.23A11.51 11.51 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.29-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.91 1.235 3.22 0 4.61-2.805 5.625-5.475 5.92.43.372.823 1.102.823 2.222 0 1.606-.015 2.896-.015 3.286 0 .322.216.694.825.576C20.565 21.796 24 17.298 24 12c0-6.63-5.37-12-12-12z"/>
          </svg>
          {showGHForm ? 'Cancel' : 'Install from GitHub'}
        </button>
      </div>

      {/* ── GitHub install form (collapsible) ───────────────────────────── */}
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

            {/* Progress bar during install */}
            {isInstalling && installProgress?.step === 'downloading' && (
              <div className="h-1 rounded-full bg-zinc-800 overflow-hidden">
                <div
                  className="h-full rounded-full bg-accent transition-all duration-300"
                  style={{ width: `${installProgress.percent ?? 0}%` }}
                />
              </div>
            )}

            {/* Success */}
            {installProgress?.step === 'done' && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-950/30 border border-emerald-800/30">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-emerald-400 shrink-0">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
                <p className="text-[11px] text-emerald-400">Extension installed successfully!</p>
              </div>
            )}

            {/* Error */}
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

      {/* ── Content ─────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto p-6">

        {/* Extensions section */}
        <div className="flex flex-col gap-2 mb-8">

          {/* Section header */}
          <div className="flex items-center justify-between mb-1">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500">Extensions</p>
            <button
              onClick={reloadExtensions}
              disabled={extLoading}
              title="Reload extensions"
              className="p-1 rounded text-zinc-600 hover:text-zinc-400 transition-colors disabled:opacity-40"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                className={extLoading ? 'animate-spin' : ''}>
                <polyline points="23 4 23 10 17 10"/>
                <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/>
              </svg>
            </button>
          </div>

          {/* Extensions grid */}
          {extensions.length === 0 && !extLoading ? (
            <div className="flex flex-col items-center justify-center gap-2 py-8 rounded-2xl border border-dashed border-zinc-800 bg-zinc-900/30">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" className="text-zinc-700">
                <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/>
                <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
                <line x1="12" y1="22.08" x2="12" y2="12"/>
              </svg>
              <p className="text-xs text-zinc-600">No extensions installed</p>
              <p className="text-[10px] text-zinc-700">
                Install from GitHub or drop into <span className="font-mono text-zinc-500">%appdata%/Modly/extensions</span>
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-6 gap-3">
              {extensions.map((ext) => (
                <ExtensionCard
                  key={ext.id}
                  ext={ext}
                  installedIds={installedVariantIds}
                  downloading={downloading}
                  disabled={isBusy}
                  loadError={
                    loadErrors[ext.id] ??
                    ext.models.map((v) => loadErrors[v.id]).find(Boolean)
                  }
                  onInstall={(variant: ExtensionVariant) => {
                    setDownloading((prev) => ({ ...prev, [variant.id]: { percent: 0 } }))
                    window.electron.model.download(variant.repoId, variant.id, variant.hfSkipPrefixes).then((result) => {
                      if (!result.success) {
                        setDownloading((prev) => { const n = { ...prev }; delete n[variant.id]; return n })
                      }
                    })
                  }}
                  onUninstall={(extId) => openUninstallModal(extId)}
                />
              ))}
            </div>
          )}
        </div>


        {/* Empty state */}
        {models.length === 0 && inProgressIds.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-4 pb-16">
            <div className="w-16 h-16 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" className="text-zinc-600">
                <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                <path d="M2 17l10 5 10-5"/>
                <path d="M2 12l10 5 10-5"/>
              </svg>
            </div>
            <div className="text-center">
              <p className="text-sm font-medium text-zinc-300">No models installed</p>
              <p className="text-xs text-zinc-600 mt-1">Install an extension to get started</p>
            </div>
          </div>
        )}

        {/* Model grid */}
        {models.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500 mb-1">Installed</p>
            <div className="grid grid-cols-6 gap-3">
              {models.map((model) => (
                <ModelCard
                  key={model.id}
                  model={model}
                  disabled={isBusy}
                  onDelete={() => setDeleteTarget(model)}
                  onGenerate={() => {
                    setGenerationOptions({ modelId: model.id })
                    navigate('generate')
                  }}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Confirm uninstall model weights ─────────────────────────────── */}
      {deleteTarget && (
        <ConfirmModal
          title={`Uninstall ${formatModelName(deleteTarget.id)}?`}
          description={deleteError ?? "This will permanently delete the model weights from your disk. You can re-download it anytime."}
          confirmLabel="Uninstall"
          cancelLabel="Keep"
          variant="danger"
          onConfirm={() => handleDelete(deleteTarget)}
          onCancel={() => { setDeleteTarget(null); setDeleteError(null) }}
        />
      )}

      {/* ── Confirm uninstall extension ──────────────────────────────────── */}
      {uninstallTarget && (() => {
        const ext = extensions.find((e) => e.id === uninstallTarget)
        const installedModels = ext?.models.filter((v) => installedVariantIds.includes(v.id)) ?? []

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
                      Uninstall extension &ldquo;{ext?.name ?? uninstallTarget}&rdquo;?
                    </h2>
                    <p className="text-xs text-zinc-500 leading-relaxed">
                      The extension folder will be deleted.
                    </p>
                  </div>
                </div>

                {installedModels.length > 0 && (
                  <div className="flex flex-col gap-2 px-1">
                    <p className="text-[11px] font-medium text-zinc-400">
                      Also delete downloaded model weights:
                    </p>
                    {installedModels.map((v) => {
                      const checked = modelsToDelete.has(v.id)
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
                                if (checked) next.delete(v.id)
                                else next.add(v.id)
                                return next
                              })
                            }}
                            className="accent-accent w-3.5 h-3.5 rounded"
                          />
                          <span className="text-xs text-zinc-200">{formatModelName(v.id)}</span>
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

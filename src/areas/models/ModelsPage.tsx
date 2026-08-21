import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useExtensionsStore } from '@shared/stores/extensionsStore'
import type { AnyExtension, ModelExtension } from '@shared/types/electron.d'
import { deleteModelsThenUninstallExtension, formatModelName } from './utils'
import { ExtensionCard } from './components/ExtensionCard'
import type { ExtensionNode } from './components/ExtensionCard'
import { ExtensionDrawer } from './components/ExtensionDrawer'
import { ICONS, nodeHasManagedWeights } from './components/extensionShared'

// ─── Filters & sorts ──────────────────────────────────────────────────────────

type FilterId = 'all' | 'process' | 'model' | 'official'
type SortId   = 'name' | 'type'

const FILTERS: { id: FilterId; label: string }[] = [
  { id: 'all',      label: 'All' },
  { id: 'process',  label: 'Processors' },
  { id: 'model',    label: 'Models' },
  { id: 'official', label: 'Official' },
]

const SORTS: { id: SortId; label: string }[] = [
  { id: 'name', label: 'Name (A–Z)' },
  { id: 'type', label: 'Type' },
]

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
  const installFromLocal  = useExtensionsStore((s) => s.installFromLocal)
  const uninstallExt      = useExtensionsStore((s) => s.uninstall)
  const reloadExtensions  = useExtensionsStore((s) => s.reload)
  const clearInstall      = useExtensionsStore((s) => s.clearInstallState)

  const allExtensions: AnyExtension[] = useMemo(
    () => [...modelExtensions, ...processExtensions],
    [modelExtensions, processExtensions],
  )

  // Model weight state (needed for node install status + uninstall cleanup)
  const [installedVariantIds, setInstalledVariantIds] = useState<string[]>([])
  const [localDataIds, setLocalDataIds] = useState<string[]>([])
  const [downloading, setDownloading] = useState<Record<string, {
    percent: number
    file?: string
    fileIndex?: number
    totalFiles?: number
    status?: string
    bytesDownloaded?: number
    totalBytes?: number
    stalledSeconds?: number
    paused?: boolean
  }>>({})

  // Uninstall modal state
  const [uninstallTarget, setUninstallTarget] = useState<string | null>(null)
  const [uninstallError,  setUninstallError]  = useState<string | null>(null)
  const [modelsToDelete,  setModelsToDelete]  = useState<Set<string>>(new Set())

  // Search / filter / sort / detail drawer
  const [search, setSearch]       = useState('')
  const [filter, setFilter]       = useState<FilterId>('all')
  const [sort, setSort]           = useState<SortId>('name')
  const [sortOpen, setSortOpen]   = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // GitHub extension install form
  const [showGHForm, setShowGHForm] = useState(false)
  const [ghUrl,      setGhUrl]      = useState('')
  const [ghErr,      setGhErr]      = useState<string | null>(null)

  // ── Init ──────────────────────────────────────────────────────────────────

  // Check each model node individually via filesystem IPC — reliable regardless of API state
  async function refreshInstalledIds(exts: ModelExtension[]) {
    const ids: string[] = []
    const localIds: string[] = []
    for (const ext of exts) {
      for (const node of ext.nodes) {
        if (!nodeHasManagedWeights(node)) continue
        const fullId = `${ext.id}/${node.id}`
        const [ok, hasLocalData] = await Promise.all([
          window.electron.model.isDownloaded(fullId),
          window.electron.model.hasLocalData(fullId),
        ])
        if (ok) ids.push(fullId)
        if (hasLocalData) localIds.push(fullId)
      }
    }
    setInstalledVariantIds(ids)
    setLocalDataIds(localIds)
  }

  useEffect(() => {
    loadExtensions().then(async () => {
      const exts = useExtensionsStore.getState().modelExtensions
      const active = await window.electron.model.activeDownloads()
      if (active.length > 0) {
        setDownloading((prev) => {
          const next = { ...prev }
          for (const { modelId, ...progress } of active) if (!next[modelId]) next[modelId] = progress
          return next
        })
      }
      refreshInstalledIds(exts)
    })
    window.electron.model.onProgress(({ modelId: id, percent, file, fileIndex, totalFiles, status, bytesDownloaded, totalBytes, stalledSeconds, paused, cancelled }) => {
      if (cancelled) {
        setDownloading((prev) => { const n = { ...prev }; delete n[id]; return n })
        return
      }
      setDownloading((prev) => {
        const current = prev[id]
        return {
          ...prev,
          [id]: {
            percent: paused ? (current?.percent ?? percent) : percent,
            file: file ?? current?.file,
            fileIndex: fileIndex ?? current?.fileIndex,
            totalFiles: totalFiles ?? current?.totalFiles,
            status,
            bytesDownloaded: bytesDownloaded ?? current?.bytesDownloaded,
            totalBytes: totalBytes ?? current?.totalBytes,
            stalledSeconds: stalledSeconds ?? current?.stalledSeconds,
            paused,
          },
        }
      })
      if (percent === 100) {
        const exts = useExtensionsStore.getState().modelExtensions
        refreshInstalledIds(exts).then(() => {
          setDownloading((prev) => { const n = { ...prev }; delete n[id]; return n })
        })
      }
    })
    return () => window.electron.model.offProgress()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- register the progress listener once on mount
  }, [])

  useEffect(() => {
    if (installError) setGhErr(installError)
  }, [installError])

  // "/" focuses the search field
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== '/') return
      const el = document.activeElement
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return
      e.preventDefault()
      searchRef.current?.focus()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // ── Node install / download controls ──────────────────────────────────────

  function handleInstallNode(node: ExtensionNode, fullId: string) {
    if (!nodeHasManagedWeights(node)) return
    setDownloading((prev) => ({ ...prev, [fullId]: { ...(prev[fullId] ?? { percent: 0 }), paused: false, status: 'Starting…' } }))
    window.electron.model.download(fullId).then((result) => {
      if (!result.success && !result.paused && !result.cancelled) {
        setGhErr(result.error ?? 'Download failed')
        setDownloading((prev) => { const n = { ...prev }; delete n[fullId]; return n })
      }
    })
  }

  function handleInstallAll(ext: AnyExtension) {
    if (ext.type !== 'model') return
    for (const node of ext.nodes) {
      if (!nodeHasManagedWeights(node)) continue
      const fullId = `${ext.id}/${node.id}`
      if (installedVariantIds.includes(fullId) || downloading[fullId]) continue
      handleInstallNode(node, fullId)
    }
  }

  async function handlePauseDownload(fullId: string) {
    setDownloading((prev) => prev[fullId] ? ({ ...prev, [fullId]: { ...prev[fullId], paused: true, status: 'Pausing…' } }) : prev)
    await window.electron.model.pauseDownload(fullId)
  }

  async function handleCancelDownload(fullId: string) {
    setDownloading((prev) => { const n = { ...prev }; delete n[fullId]; return n })
    const result = await window.electron.model.cancelDownload(fullId)
    if (!result.success) setGhErr(result.error ?? 'Could not cancel download')
    await refreshInstalledIds(useExtensionsStore.getState().modelExtensions)
  }

  async function handleUninstallNode(fullId: string) {
    await window.electron.model.delete(fullId)
    refreshInstalledIds(useExtensionsStore.getState().modelExtensions)
  }

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

  // ── Local extension install ──────────────────────────────────────────

  async function handleLocalInstall() {
    setGhErr(null)
    clearInstall()
    const result = await installFromLocal()
    if ('cancelled' in result && result.cancelled) return   // user dismissed dialog
    if (!result.success) setGhErr(result.error ?? 'Installation failed')
  }

  // ── Uninstall extension ──────────────────────────────────────────

  function openUninstallModal(extId: string) {
    const ext = allExtensions.find((e) => e.id === extId)
    if (ext?.type === 'model') {
      const localModels = ext.nodes.filter((n) => localDataIds.includes(`${extId}/${n.id}`))
      setModelsToDelete(new Set(localModels.map((n) => `${extId}/${n.id}`)))
    } else {
      setModelsToDelete(new Set())
    }
    setUninstallTarget(extId)
  }

  async function handleUninstallExtension(extId: string) {
    const result = await deleteModelsThenUninstallExtension(
      extId,
      modelsToDelete,
      (modelId) => window.electron.model.delete(modelId),
      uninstallExt,
    )
    if (!result.success) {
      // Keep the dialog open so the failure is visible (locked folder, etc.)
      setUninstallError(result.error ?? 'Could not delete the extension folder.')
      return
    }
    setUninstallError(null)
    setUninstallTarget(null)
    setModelsToDelete(new Set())
    setSelectedId((id) => (id === extId ? null : id))
    refreshInstalledIds(useExtensionsStore.getState().modelExtensions)
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  const isInstalling = installProgress !== null &&
    installProgress.step !== 'done' &&
    installProgress.step !== 'error'

  const isBusy = isInstalling || Object.keys(downloading).length > 0

  const counts = useMemo(() => ({
    all:      allExtensions.length,
    process:  allExtensions.filter((e) => e.type === 'process').length,
    model:    allExtensions.filter((e) => e.type === 'model').length,
    official: allExtensions.filter((e) => e.trusted).length,
  }), [allExtensions])

  const filteredExtensions = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = allExtensions.filter((e) => {
      if (q) {
        const haystack = `${e.name} ${e.description ?? ''} ${e.author ?? ''}`.toLowerCase()
        if (!haystack.includes(q)) return false
      }
      if (filter === 'process')  return e.type === 'process'
      if (filter === 'model')    return e.type === 'model'
      if (filter === 'official') return e.trusted
      return true
    })
    const sorters: Record<SortId, (a: AnyExtension, b: AnyExtension) => number> = {
      name: (a, b) => a.name.localeCompare(b.name),
      type: (a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name),
    }
    return [...list].sort(sorters[sort])
  }, [allExtensions, search, filter, sort])

  const processList = filteredExtensions.filter((e) => e.type === 'process')
  const modelList   = filteredExtensions.filter((e) => e.type === 'model')
  const grouped     = filter === 'all' || filter === 'official'

  const selectedExt = selectedId ? allExtensions.find((e) => e.id === selectedId) ?? null : null

  function extLoadError(ext: AnyExtension): string | undefined {
    return loadErrors[ext.id] ??
      ext.nodes.map((n) => loadErrors[`${ext.id}/${n.id}`]).find(Boolean)
  }

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

  const cardHandlers = {
    installedIds: installedVariantIds,
    downloading,
    disabled: isBusy,
    onInstall: handleInstallNode,
    onInstallAll: handleInstallAll,
    onPauseDownload: handlePauseDownload,
    onCancelDownload: handleCancelDownload,
    onOpen: (ext: AnyExtension) => setSelectedId(ext.id),
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="relative h-full flex flex-col overflow-hidden">

      {/* ── Page head ────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-6 px-7 pt-6 pb-4 shrink-0">
        <div>
          <h1 className="text-[21px] font-semibold text-zinc-100 tracking-tight">Extensions</h1>
          <p className="mt-1 text-[13px] text-zinc-500">
            <b className="font-semibold text-zinc-200">{counts.all}</b> installed
            {' · '}
            <b className="font-semibold text-zinc-200">{counts.process}</b> processors,{' '}
            <b className="font-semibold text-zinc-200">{counts.model}</b> models
          </p>
        </div>
        <div className="flex gap-2.5 shrink-0">
          <button
            onClick={() => {
              setShowGHForm((v) => !v)
              setGhErr(null)
              clearInstall()
            }}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-[9px] text-xs font-medium border border-zinc-700/60 bg-white/[0.025] text-zinc-200 hover:bg-white/[0.06] hover:border-zinc-600 transition-colors whitespace-nowrap"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="opacity-85">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.09-.745.083-.729.083-.729 1.205.085 1.84 1.237 1.84 1.237 1.07 1.835 2.807 1.305 3.492.997.108-.776.418-1.305.762-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.468-2.38 1.235-3.22-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.3 1.23A11.51 11.51 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.29-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.91 1.235 3.22 0 4.61-2.805 5.625-5.475 5.92.43.372.823 1.102.823 2.222 0 1.606-.015 2.896-.015 3.286 0 .322.216.694.825.576C20.565 21.796 24 17.298 24 12c0-6.63-5.37-12-12-12z"/>
            </svg>
            {showGHForm ? 'Cancel' : 'Install from GitHub'}
          </button>
          <button
            onClick={handleLocalInstall}
            disabled={isInstalling}
            title="Link a local extension folder"
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-[9px] text-xs font-medium border border-zinc-700/60 bg-white/[0.025] text-zinc-200 hover:bg-white/[0.06] hover:border-zinc-600 transition-colors whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" className="opacity-85">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
            </svg>
            Link local folder
          </button>
        </div>
      </div>

      {/* ── Toolbar ──────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-7 pb-4 flex-wrap shrink-0">
        {/* Search */}
        <label className="flex-1 min-w-[220px] h-10 flex items-center gap-2.5 px-3.5 rounded-[10px] bg-zinc-900/70 border border-zinc-800 focus-within:border-accent/40 focus-within:bg-zinc-900 transition-colors">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" className="text-zinc-600 shrink-0">
            <circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" />
          </svg>
          <input
            ref={searchRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search extensions, authors…"
            className="flex-1 bg-transparent text-[13px] text-zinc-200 placeholder-zinc-600 focus:outline-none"
          />
          {search ? (
            <button onClick={() => setSearch('')} className="text-zinc-600 hover:text-zinc-400 transition-colors">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          ) : (
            <kbd className="px-1.5 py-0.5 rounded-[5px] border border-zinc-700/60 font-mono text-[10.5px] text-zinc-600">/</kbd>
          )}
        </label>

        {/* Type filter */}
        <div className="flex items-center gap-0.5 p-[3px] rounded-[10px] bg-zinc-900/70 border border-zinc-800">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-[7px] text-xs font-medium transition-colors ${
                filter === f.id ? 'bg-zinc-800 text-zinc-100 shadow-sm' : 'text-zinc-500 hover:text-zinc-200'
              }`}
            >
              {f.label}
              <span className={`px-1.5 py-px rounded-full font-mono text-[10px] bg-white/5 ${filter === f.id ? 'text-zinc-400' : 'text-zinc-600'}`}>
                {counts[f.id]}
              </span>
            </button>
          ))}
        </div>

        {/* Sort */}
        <div className="relative">
          <button
            onClick={() => setSortOpen((o) => !o)}
            onBlur={() => setTimeout(() => setSortOpen(false), 140)}
            className="h-10 flex items-center gap-2 px-3.5 rounded-[10px] bg-zinc-900/70 border border-zinc-800 text-xs font-medium text-zinc-500 hover:text-zinc-200 hover:border-zinc-700 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M7 5v14M7 19l-3-3M7 5l3 3M17 19V5M17 5l-3 3M17 19l3-3" />
            </svg>
            {SORTS.find((s) => s.id === sort)!.label}
          </button>
          {sortOpen && (
            <div className="absolute right-0 top-11 z-30 w-44 rounded-xl bg-zinc-900 border border-zinc-700/60 p-1 shadow-2xl shadow-black/50">
              {SORTS.map((s) => (
                <button
                  key={s.id}
                  onMouseDown={() => { setSort(s.id); setSortOpen(false) }}
                  className={`flex items-center justify-between w-full px-2.5 py-2 rounded-lg text-xs transition-colors ${
                    sort === s.id ? 'text-zinc-100' : 'text-zinc-500 hover:text-zinc-200 hover:bg-white/5'
                  }`}
                >
                  {s.label}
                  {sort === s.id && (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-accent-light">
                      <path d="m5 12 4.5 4.5L19 7" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Reload */}
        <button
          onClick={reloadExtensions}
          disabled={extLoading}
          title="Reload extensions"
          className="h-10 w-10 grid place-items-center rounded-[10px] bg-zinc-900/70 border border-zinc-800 text-zinc-500 hover:text-zinc-200 hover:border-zinc-700 transition-colors disabled:opacity-40"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
            className={extLoading ? 'animate-spin' : ''}>
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
          </svg>
        </button>
      </div>

      {/* ── GitHub install form ──────────────────────────────────────────── */}
      {showGHForm && (
        <div className="px-7 pb-4 shrink-0 animate-fade-in">
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
      <div className="flex-1 min-h-0 overflow-y-auto px-7 pb-9">
        {allExtensions.length === 0 && !extLoading ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 rounded-2xl border border-dashed border-zinc-800 bg-zinc-900/20">
            <div className="w-8 h-8 text-zinc-700">{ICONS.cube}</div>
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
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-zinc-700">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
            </svg>
            <p className="text-sm text-zinc-500">No extension matches <span className="text-zinc-300">&ldquo;{search}&rdquo;</span></p>
          </div>
        ) : grouped ? (
          <>
            {processList.length > 0 && (
              <section className="mt-1">
                <div className="flex items-center gap-2.5 mb-3.5 px-0.5">
                  <span className="w-6 h-6 p-[5px] rounded-[7px] grid place-items-center bg-emerald-500/10 text-emerald-400 ring-1 ring-inset ring-emerald-500/25">
                    {ICONS.cube}
                  </span>
                  <h2 className="text-[13px] font-semibold text-zinc-200 tracking-wide">Processors</h2>
                  <span className="font-mono text-[11px] text-zinc-600">{processList.length}</span>
                  <span className="flex-1 h-px bg-zinc-800" />
                </div>
                <div className="grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(296px, 1fr))' }}>
                  {processList.map((ext) => (
                    <ExtensionCard key={ext.id} ext={ext} loadError={extLoadError(ext)} {...cardHandlers} />
                  ))}
                </div>
              </section>
            )}
            {modelList.length > 0 && (
              <section className={processList.length > 0 ? 'mt-8' : 'mt-1'}>
                <div className="flex items-center gap-2.5 mb-3.5 px-0.5">
                  <span className="w-6 h-6 p-[5px] rounded-[7px] grid place-items-center bg-accent/15 text-accent-light ring-1 ring-inset ring-accent/30">
                    {ICONS.spark}
                  </span>
                  <h2 className="text-[13px] font-semibold text-zinc-200 tracking-wide">Models</h2>
                  <span className="font-mono text-[11px] text-zinc-600">{modelList.length}</span>
                  <span className="flex-1 h-px bg-zinc-800" />
                </div>
                <div className="grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(296px, 1fr))' }}>
                  {modelList.map((ext) => (
                    <ExtensionCard key={ext.id} ext={ext} loadError={extLoadError(ext)} {...cardHandlers} />
                  ))}
                </div>
              </section>
            )}
          </>
        ) : (
          <div className="grid gap-3.5 mt-1" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(296px, 1fr))' }}>
            {filteredExtensions.map((ext) => (
              <ExtensionCard key={ext.id} ext={ext} loadError={extLoadError(ext)} {...cardHandlers} />
            ))}
          </div>
        )}
      </div>

      {/* ── Detail drawer ────────────────────────────────────────────────── */}
      {selectedExt && (
        <ExtensionDrawer
          ext={selectedExt}
          installedIds={installedVariantIds}
          localDataIds={localDataIds}
          downloading={downloading}
          loadError={extLoadError(selectedExt)}
          disabled={isBusy}
          onInstall={handleInstallNode}
          onInstallAll={handleInstallAll}
          onPauseDownload={handlePauseDownload}
          onCancelDownload={handleCancelDownload}
          onUninstallNode={handleUninstallNode}
          onUninstall={(extId) => openUninstallModal(extId)}
          onRepaired={() => reloadExtensions()}
          onSynced={() => reloadExtensions()}
          onClose={() => setSelectedId(null)}
        />
      )}

      {/* ── Confirm uninstall extension ──────────────────────────────────── */}
      {uninstallTarget && (() => {
        const ext = allExtensions.find((e) => e.id === uninstallTarget)
        const installedModels = ext?.type === 'model'
          ? ext.nodes.filter((n) => localDataIds.includes(`${uninstallTarget}/${n.id}`))
          : []

        return createPortal(
          <div
            className="fixed inset-0 z-[9999] flex items-center justify-center"
            onMouseDown={(e) => { if (e.target === e.currentTarget) { setUninstallTarget(null); setModelsToDelete(new Set()); setUninstallError(null) } }}
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

                {uninstallError && (
                  <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-red-950/30 border border-red-800/30">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-red-400 shrink-0 mt-0.5">
                      <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                    <p className="text-[11px] text-red-400 break-words">{uninstallError}</p>
                  </div>
                )}

                <div className="flex gap-2.5">
                  <button
                    onClick={() => { setUninstallTarget(null); setModelsToDelete(new Set()); setUninstallError(null) }}
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

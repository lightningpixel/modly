import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@shared/stores/appStore'
import { useNavStore } from '@shared/stores/navStore'
import { useApi } from '@shared/hooks/useApi'
import { droppedImagePath, useImageHandoff } from '@shared/utils/imageInput'
import { showImportedMesh } from '@shared/utils/meshJob'
import { requestLibraryThumbnails } from '@shared/thumbnails/assetThumbnailService'
import type { ProjectedAssetLibraryEntry } from '@areas/generate/assetLibraryProjection'
import { getDefaultAssetLibraryService } from '@areas/generate/assetLibraryService'
import { openAssetLibraryEntry } from '@areas/generate/assetLibraryUi'
import { Thumbnail } from '@areas/library/LibraryGrid'
import ModlyLogo from '@shared/components/ui/ModlyLogo'
import { formatRelativeDate, selectRecentAssets } from './recents'

function Icon({ d, size = 16 }: { d: string, size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

const ICONS = {
  upload:   'M12 16V4m0 0-4.5 4.5M12 4l4.5 4.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3',
  workflow: 'M4 5h5v5H4zM15 14h5v5h-5zM9 7.5h3.5a2 2 0 0 1 2 2V14',
  mesh:     'M12 2 3 7v10l9 5 9-5V7zM3 7l9 5 9-5M12 12v10',
  library:  'M4 4h6.5v6.5H4zM13.5 4H20v6.5h-6.5zM4 13.5h6.5V20H4zM13.5 13.5H20V20h-6.5z',
}

function SectionHeader({ title, action }: { title: string, action?: { label: string, onClick: () => void } }): JSX.Element {
  return (
    <div className="mb-3 flex items-baseline justify-between">
      <h2 className="text-[13px] font-semibold text-zinc-200">{title}</h2>
      {action && (
        <button type="button" onClick={action.onClick} className="text-xs font-medium text-zinc-500 transition-colors hover:text-zinc-200">
          {action.label}
        </button>
      )}
    </div>
  )
}

function QuickAction({ icon, label, detail, busy, onClick }: { icon: string, label: string, detail: string, busy?: boolean, onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="group flex min-w-0 flex-1 items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/50 px-4 py-3 text-left transition-colors hover:border-zinc-700 hover:bg-zinc-900 disabled:cursor-wait disabled:opacity-60"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-800/80 text-zinc-400 transition-colors group-hover:text-accent-light">
        <Icon d={icon} />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-medium text-zinc-200">{busy ? 'Importing…' : label}</span>
        <span className="block truncate text-[11px] text-zinc-500">{detail}</span>
      </span>
    </button>
  )
}

function DropZone({ onImage }: { onImage: (path: string) => void }): JSX.Element {
  const [dragging, setDragging] = useState(false)
  return (
    <button
      type="button"
      onClick={() => { void window.electron.fs.selectImage().then((path) => { if (path) onImage(path) }) }}
      onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault()
        setDragging(false)
        const path = droppedImagePath(event.dataTransfer.files[0])
        if (path) onImage(path)
      }}
      className={`flex w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors
        ${dragging ? 'border-accent bg-accent/10' : 'border-zinc-800 bg-zinc-900/30 hover:border-zinc-700 hover:bg-zinc-900/60'}`}
    >
      <span className={`flex h-12 w-12 items-center justify-center rounded-2xl ${dragging ? 'bg-accent/20 text-accent-light' : 'bg-zinc-800/80 text-zinc-400'}`}>
        <Icon d={ICONS.upload} size={22} />
      </span>
      <span>
        <span className="block text-[15px] font-medium text-zinc-100">Drop an image to generate a 3D model</span>
        <span className="mt-1 block text-xs text-zinc-500">or click to choose a file · PNG, JPG, WEBP</span>
      </span>
    </button>
  )
}

function RecentAsset({ entry, opening, onOpen }: { entry: ProjectedAssetLibraryEntry, opening: boolean, onOpen: () => void }): JSX.Element {
  const date = formatRelativeDate(entry.updatedAt ?? entry.createdAt)
  return (
    <button type="button" onClick={onOpen} title={`${entry.workspacePath}\nOpen in Generate`} className="group min-w-0 text-left">
      <div className="relative aspect-square w-full overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 transition-colors group-hover:border-zinc-600 group-focus-visible:border-accent-light">
        <Thumbnail entry={entry} iconSize={28} />
        {opening && (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-950/60">
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-white/25 border-t-white" aria-hidden="true" />
          </div>
        )}
      </div>
      <p className="mt-2 truncate text-[12.5px] font-medium text-zinc-200">{entry.displayName}</p>
      {date && <p className="truncate text-[11px] text-zinc-500">{date}</p>}
    </button>
  )
}

function Empty({ text }: { text: string }): JSX.Element {
  return (
    <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/30 px-4 py-5">
      <p className="text-xs text-zinc-500">{text}</p>
    </div>
  )
}

export default function HomePage(): JSX.Element {
  const navigate = useNavStore((s) => s.navigate)
  const showError = useAppStore((s) => s.showError)
  const { importMesh } = useApi()
  const service = useMemo(() => getDefaultAssetLibraryService(), [])

  const [assets, setAssets] = useState<ProjectedAssetLibraryEntry[]>([])
  const [assetsLoaded, setAssetsLoaded] = useState(false)
  const [openingId, setOpeningId] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)

  const loadAssets = useCallback(async () => {
    try {
      const result = await service.list()
      if (!result.success) return
      const recent = selectRecentAssets(result.entries)
      setAssets(recent)
      // Render only the thumbnails this page shows.
      void requestLibraryThumbnails(recent)
    } finally {
      setAssetsLoaded(true)
    }
  }, [service])

  useEffect(() => { void loadAssets() }, [loadAssets])

  async function openAsset(entry: ProjectedAssetLibraryEntry) {
    if (openingId) return
    setOpeningId(entry.id)
    try {
      const result = await openAssetLibraryEntry(service, entry)
      if (!result.success) {
        showError(result.message)
        return
      }
      const { setCurrentJob, pushMeshUrl } = useAppStore.getState()
      setCurrentJob(result.selection.job)
      pushMeshUrl(result.selection.historyUrl)
      navigate('generate')
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err))
    } finally {
      setOpeningId(null)
    }
  }

  async function importFromDisk() {
    const filePath = await window.electron.fs.selectMeshFile()
    if (!filePath) return
    setImporting(true)
    try {
      const { url } = await importMesh(filePath)
      showImportedMesh(url)
      navigate('generate')
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Could not import the mesh.')
    } finally {
      setImporting(false)
    }
  }

  const returning = assets.length > 0

  return (
    <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col justify-center gap-10 px-7 py-12">
      <header className="flex flex-col items-center text-center">
        <ModlyLogo size={56} className="mb-5" />
        <h1 className="text-[28px] font-semibold tracking-tight text-zinc-50">{returning ? 'Welcome back' : 'Welcome to Modly'}</h1>
      </header>

      <div className="flex flex-col gap-3">
        <DropZone onImage={(path) => { useImageHandoff.getState().offer(path); navigate('generate') }} />
        <div className="flex flex-col gap-3 sm:flex-row">
          <QuickAction icon={ICONS.workflow} label="Open a workflow" detail="Build or run a node pipeline" onClick={() => navigate('workflows')} />
          <QuickAction icon={ICONS.mesh} label="Import a mesh" detail="GLB, OBJ, STL, PLY" busy={importing} onClick={() => { void importFromDisk() }} />
          <QuickAction icon={ICONS.library} label="Browse the library" detail="Everything you've made" onClick={() => navigate('library')} />
        </div>
      </div>

      <section>
        <SectionHeader title="Recent creations" action={assets.length > 0 ? { label: 'See all', onClick: () => navigate('library') } : undefined} />
        {assets.length > 0 ? (
          <div className="grid grid-cols-3 gap-4 lg:grid-cols-6">
            {assets.map((entry) => (
              <RecentAsset key={entry.id} entry={entry} opening={openingId === entry.id} onOpen={() => { void openAsset(entry) }} />
            ))}
          </div>
        ) : assetsLoaded ? (
          <Empty text="The meshes you generate or import will show up here." />
        ) : (
          <div className="h-24" aria-hidden="true" />
        )}
      </section>
    </div>
  )
}

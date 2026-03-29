import { useState } from 'react'
import { useAppStore, type GenerationJob } from '@shared/stores/appStore'
import { useCollectionsStore } from '@shared/stores/collectionsStore'
import { ConfirmModal } from '@shared/components/ui'
import { formatTime, formatDate } from '@shared/utils/format'

function ThumbnailItem({ job, isActive, onClick, onDelete, disabled }: {
  job: GenerationJob
  isActive: boolean
  onClick: () => void
  onDelete: () => void
  disabled?: boolean
}): JSX.Element {
  return (
    <div
      title={disabled ? 'A generation is in progress' : undefined}
      className={`
        relative group aspect-square rounded-xl overflow-hidden border transition-all duration-150
        ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}
        ${isActive
          ? 'border-accent ring-1 ring-accent/40'
          : 'border-zinc-700/50 hover:border-zinc-500'
        }
      `}
      onClick={onClick}
    >
      {job.thumbnailUrl ? (
        <img src={job.thumbnailUrl} alt="Generated model" className="w-full h-full object-cover" />
      ) : (
        <div className="w-full h-full bg-zinc-900 flex items-center justify-center">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" className="text-zinc-700">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
          </svg>
        </div>
      )}

      <div className="absolute inset-0 bg-zinc-950/75 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-0.5 pointer-events-none">
        <span className="text-xs font-medium text-zinc-100">{formatTime(job.createdAt)}</span>
        <span className="text-[10px] text-zinc-400">{formatDate(job.createdAt)}</span>
      </div>

      <button
        onClick={(e) => { e.stopPropagation(); onDelete() }}
        className="absolute top-2 right-2 w-9 h-9 rounded-xl bg-zinc-950/80 border border-zinc-700/50 flex items-center justify-center text-zinc-500 hover:text-red-400 hover:border-red-500/50 hover:bg-red-950/60 opacity-0 group-hover:opacity-100 transition-all duration-150"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
          <path d="M10 11v6M14 11v6" />
          <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
        </svg>
      </button>

      {isActive && (
        <div className="absolute top-1.5 left-1.5 w-1.5 h-1.5 rounded-full bg-accent shadow-sm shadow-accent/50" />
      )}
    </div>
  )
}

export function WorkspaceToggle(): JSX.Element {
  const { toggleWorkspacePanel, workspacePanelOpen } = useAppStore()
  const jobCount = useCollectionsStore((s) =>
    s.collections.find((c) => c.id === s.activeCollectionId)?.jobs.length ?? 0
  )

  return (
    <button
      onClick={toggleWorkspacePanel}
      className={`
        absolute top-4 right-4 z-20 flex items-center gap-2 px-3 py-2 rounded-xl
        border backdrop-blur-sm transition-all duration-150 text-xs font-medium
        ${workspacePanelOpen
          ? 'bg-zinc-800/90 border-zinc-600 text-zinc-200'
          : 'bg-zinc-900/70 border-zinc-700/50 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'
        }
      `}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
      Workspace
      {jobCount > 0 && (
        <span className="px-1.5 py-0.5 text-[10px] bg-zinc-700 text-zinc-300 rounded-md">
          {jobCount}
        </span>
      )}
    </button>
  )
}

export default function WorkspacePanel(): JSX.Element {
  const { currentJob, setCurrentJob, setSelectedImagePath, setSelectedImagePreviewUrl, setGenerationOptions } = useAppStore()
  const { collections, activeCollectionId, setActiveCollection, removeFromWorkspace, createCollection } = useCollectionsStore()
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [collapsed, setCollapsed] = useState(true)

  const isGenerating = currentJob?.status === 'uploading' || currentJob?.status === 'generating'
  const activeCollection = collections.find((c) => c.id === activeCollectionId)
  const jobs = activeCollection?.jobs ?? []

  const handleDeleteConfirm = () => {
    if (pendingDeleteId) {
      if (currentJob?.id === pendingDeleteId) setCurrentJob(null)
      removeFromWorkspace(pendingDeleteId)
    }
    setPendingDeleteId(null)
  }

  const handleCreateCollection = async () => {
    const name = newName.trim()
    if (!name) return
    await createCollection(name)
    setCreating(false)
    setNewName('')
  }

  const handleJobClick = async (job: GenerationJob) => {
    setCurrentJob({ ...job, outputUrl: job.originalOutputUrl ?? job.outputUrl })
    if (job.generationOptions) {
      setGenerationOptions(job.generationOptions)
    } else if (job.modelId) {
      setGenerationOptions({ modelId: job.modelId })
    }
    setSelectedImagePath(job.imageFile)
    try {
      const base64 = await window.electron.fs.readFileBase64(job.imageFile)
      const byteArray = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      const blob = new Blob([byteArray], { type: 'image/png' })
      setSelectedImagePreviewUrl(URL.createObjectURL(blob))
    } catch {
      setSelectedImagePreviewUrl(null)
    }
  }

  return (
    <div className={`absolute bottom-8 right-4 z-10 flex flex-col rounded-2xl border border-zinc-700/60 bg-zinc-900/90 backdrop-blur-md shadow-2xl overflow-hidden ${collapsed ? 'w-auto' : 'w-[500px]'}`}>
      {/* Header */}
      <div onClick={collapsed ? () => setCollapsed(false) : undefined} className={`flex items-center gap-2 px-3 py-2 shrink-0 ${!collapsed ? 'border-b border-zinc-800/80' : 'cursor-pointer'}`}>
        {!collapsed && (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400 shrink-0">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
        )}
        <span className="text-sm font-medium text-zinc-200 shrink-0">Workspace</span>

        {!collapsed && (creating ? (
          <input
            autoFocus
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreateCollection()
              if (e.key === 'Escape') { setCreating(false); setNewName('') }
            }}
            onBlur={() => { setCreating(false); setNewName('') }}
            placeholder="Collection name…"
            className="flex-1 min-w-0 text-xs bg-zinc-800 text-zinc-200 border border-accent/50 rounded-lg px-2 py-1 outline-none placeholder:text-zinc-600"
          />
        ) : (
          <select
            value={activeCollectionId}
            onChange={(e) => setActiveCollection(e.target.value)}
            className="flex-1 min-w-0 text-xs bg-zinc-800 text-zinc-300 border border-zinc-700/60 rounded-lg px-2 py-1 outline-none focus:border-accent/50 cursor-pointer transition-colors hover:border-zinc-500"
          >
            {collections.map((c) => (
              <option key={c.id} value={c.id} className="bg-zinc-900 text-zinc-200">
                {c.name}
              </option>
            ))}
          </select>
        ))}

        {!collapsed && !creating && jobs.length > 0 && (
          <span className="px-1.5 py-0.5 text-[10px] font-medium bg-zinc-800 text-zinc-400 rounded-md shrink-0">
            {jobs.length}
          </span>
        )}

        <div className="flex-1" />

        {!collapsed && (
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { setCreating((v) => !v); setNewName('') }}
            title="New collection"
            className={`shrink-0 w-6 h-6 flex items-center justify-center rounded-lg transition-colors ${
              creating
                ? 'bg-zinc-700 hover:bg-zinc-600 text-zinc-300'
                : 'bg-accent hover:bg-accent-dark text-white'
            }`}
          >
            {creating ? (
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            )}
          </button>
        )}

        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => { e.stopPropagation(); setCollapsed((v) => !v); setCreating(false) }}
          title={collapsed ? 'Expand' : 'Collapse'}
          className="shrink-0 w-6 h-6 flex items-center justify-center rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-700 transition-colors"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <polyline points={collapsed ? '18 15 12 9 6 15' : '6 9 12 15 18 9'} />
          </svg>
        </button>
      </div>

      {/* Content */}
      {!collapsed && <div className="p-2 overflow-y-auto h-[300px]">
        {jobs.length === 0 ? (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-zinc-700">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="0.75">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            <p className="text-xs text-center leading-relaxed text-zinc-600">
              Generated models<br />will appear here
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-4 gap-1.5 w-full content-start">
            {jobs.map((job) => (
              <ThumbnailItem
                key={job.id}
                job={job}
                isActive={currentJob?.id === job.id}
                onClick={() => !isGenerating && handleJobClick(job)}
                onDelete={() => !isGenerating && setPendingDeleteId(job.id)}
                disabled={isGenerating}
              />
            ))}
          </div>
        )}
      </div>}

      {pendingDeleteId && (
        <ConfirmModal
          title="Delete this generation?"
          description="This will remove it from the collection. This action cannot be undone."
          confirmLabel="Delete"
          cancelLabel="Cancel"
          variant="danger"
          onConfirm={handleDeleteConfirm}
          onCancel={() => setPendingDeleteId(null)}
        />
      )}
    </div>
  )
}

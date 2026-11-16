import { useEffect, useState } from 'react'
import { Section, Card, Row, PathRow } from '@shared/ui'

// ─── MoveFolderModal ──────────────────────────────────────────────────────────

function MoveFolderModal({ title, currentDir, items, otherCount, itemLabel, moveLabel, moveDesc, deleteLabel, deleteDesc, status, error, onCancel, onMove, onDelete }: {
  title: string
  currentDir: string
  items: string[]
  /** Entries Modly did not create: they are never moved or deleted. */
  otherCount: number
  itemLabel: string
  moveLabel: string
  moveDesc: string
  deleteLabel: string
  deleteDesc: string
  status: 'idle' | 'busy' | 'error'
  error?: string | null
  onCancel: () => void
  onMove: () => void
  onDelete: () => void
}): JSX.Element {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[440px] rounded-2xl border border-zinc-700/60 bg-zinc-900 shadow-2xl overflow-hidden">

        <div className="px-6 pt-5 pb-4">
          <h3 className="text-sm font-semibold text-zinc-100">{title}</h3>
          <p className="text-xs text-zinc-500 mt-1">
            {items.length} {itemLabel}{items.length > 1 ? 's' : ''} already at:
          </p>
          <p className="mt-2.5 px-3 py-2 bg-zinc-800/70 rounded-lg text-[11px] font-mono text-zinc-400 truncate border border-zinc-700/50">
            {currentDir}
          </p>
          {otherCount > 0 && (
            <p className="text-[11px] text-zinc-500 mt-2.5">
              {otherCount} other item{otherCount > 1 ? 's' : ''} in this folder {otherCount > 1 ? 'were' : 'was'} not created by Modly and will stay where {otherCount > 1 ? 'they are' : 'it is'}.
            </p>
          )}
          <p className="text-xs text-zinc-500 mt-3">What should happen to them?</p>
        </div>

        <div className="px-6 pb-5 flex flex-col gap-2">
          {status === 'error' && (
            <p className="text-[11px] text-red-400 mb-0.5 break-words">{error || 'Something went wrong. Please try again.'}</p>
          )}

          <button
            onClick={onMove}
            disabled={status === 'busy'}
            className="w-full px-4 py-3 rounded-xl bg-accent/10 hover:bg-accent/20 border border-accent/30 hover:border-accent/50 text-left transition-all disabled:opacity-40"
          >
            <p className="text-xs font-semibold text-accent-light">{moveLabel}</p>
            <p className="text-[11px] text-zinc-500 mt-0.5">{moveDesc}</p>
          </button>

          <button
            onClick={onDelete}
            disabled={status === 'busy'}
            className="w-full px-4 py-3 rounded-xl bg-zinc-800/50 hover:bg-red-950/30 border border-zinc-700/50 hover:border-red-800/50 text-left transition-all disabled:opacity-40"
          >
            <p className="text-xs font-semibold text-red-400">{deleteLabel}</p>
            <p className="text-[11px] text-zinc-500 mt-0.5">{deleteDesc}</p>
          </button>

          <button
            onClick={onCancel}
            disabled={status === 'busy'}
            className="w-full px-4 py-2.5 mt-0.5 rounded-xl text-xs font-medium text-zinc-300 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 hover:border-zinc-600 transition-colors disabled:opacity-40"
          >
            {status === 'busy' ? 'Please wait…' : 'Cancel'}
          </button>
        </div>

      </div>
    </div>
  )
}

// ─── StorageSection ───────────────────────────────────────────────────────────

export function StorageSection(): JSX.Element {
  const [modelsDir,     setModelsDir]     = useState('')
  const [workspaceDir,  setWorkspaceDir]  = useState('')
  const [workflowsDir,  setWorkflowsDir]  = useState('')
  const [cacheStatus, setCacheStatus]     = useState<'idle' | 'clearing' | 'done' | 'error'>('idle')
  const [storageError, setStorageError]   = useState<string | null>(null)
  // Items of the current folder Modly did not create (one modal at a time).
  const [otherItems,   setOtherItems]     = useState(0)

  const [pendingModelsDir,     setPendingModelsDir]     = useState<string | null>(null)
  const [existingModels,       setExistingModels]       = useState<string[]>([])
  const [modelsActionError,  setModelsActionError]  = useState<string | null>(null)
  const [modelsActionStatus,   setModelsActionStatus]   = useState<'idle' | 'busy' | 'error'>('idle')

  const [pendingWorkspaceDir,   setPendingWorkspaceDir]   = useState<string | null>(null)
  const [existingWorkspaces,    setExistingWorkspaces]    = useState<string[]>([])
  const [workspaceActionError,  setWorkspaceActionError]  = useState<string | null>(null)
  const [workspaceActionStatus, setWorkspaceActionStatus] = useState<'idle' | 'busy' | 'error'>('idle')

  const [pendingWorkflowsDir,   setPendingWorkflowsDir]   = useState<string | null>(null)
  const [existingWorkflows,     setExistingWorkflows]     = useState<string[]>([])
  const [workflowsActionError,  setWorkflowsActionError]  = useState<string | null>(null)
  const [workflowsActionStatus, setWorkflowsActionStatus] = useState<'idle' | 'busy' | 'error'>('idle')

  useEffect(() => {
    window.electron.settings.get().then((s) => {
      setModelsDir(s.modelsDir)
      setWorkspaceDir(s.workspaceDir)
      setWorkflowsDir(s.workflowsDir)
    })
  }, [])

  async function applyModelsDir(path: string) {
    await window.electron.settings.set({ modelsDir: path })
    await window.electron.api.updatePaths({ modelsDir: path })
    setModelsDir(path)
  }

  async function applyWorkspaceDir(path: string) {
    await window.electron.settings.set({ workspaceDir: path })
    await window.electron.api.updatePaths({ workspaceDir: path })
    setWorkspaceDir(path)
  }

  async function applyWorkflowsDir(path: string) {
    await window.electron.settings.set({ workflowsDir: path })
    setWorkflowsDir(path)
  }

  /** Refuses a drive root or system folder before anything is changed. */
  async function checkLocation(dir: string): Promise<boolean> {
    const result = await window.electron.fs.checkStorageLocation(dir)
    setStorageError(result.ok ? null : `${dir}: ${result.error ?? 'not a valid storage folder'}`)
    return result.ok
  }

  async function applyOrReport(apply: () => Promise<void>) {
    try {
      await apply()
    } catch (err) {
      setStorageError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleBrowseModels() {
    const newPath = await window.electron.fs.selectDirectory(modelsDir)
    if (!newPath || newPath === modelsDir) return
    if (!(await checkLocation(newPath))) return

    // Only what Modly created there is offered for moving or deleting.
    const { modly, other } = await window.electron.fs.storageEntries('models')
    if (modly.length > 0) {
      setExistingModels(modly)
      setOtherItems(other.length)
      setPendingModelsDir(newPath)
      return
    }

    await applyOrReport(() => applyModelsDir(newPath))
  }

  async function handleBrowseWorkspace() {
    const newPath = await window.electron.fs.selectDirectory(workspaceDir)
    if (!newPath || newPath === workspaceDir) return
    if (!(await checkLocation(newPath))) return

    // Only what Modly created there is offered for moving or deleting.
    const { modly, other } = await window.electron.fs.storageEntries('workspace')
    if (modly.length > 0) {
      setExistingWorkspaces(modly)
      setOtherItems(other.length)
      setPendingWorkspaceDir(newPath)
      return
    }

    await applyOrReport(() => applyWorkspaceDir(newPath))
  }

  async function handleBrowseWorkflows() {
    const newPath = await window.electron.fs.selectDirectory(workflowsDir)
    if (!newPath || newPath === workflowsDir) return
    if (!(await checkLocation(newPath))) return

    // Only what Modly created there is offered for moving or deleting.
    const { modly, other } = await window.electron.fs.storageEntries('workflows')
    if (modly.length > 0) {
      setExistingWorkflows(modly)
      setOtherItems(other.length)
      setPendingWorkflowsDir(newPath)
      return
    }

    await applyOrReport(() => applyWorkflowsDir(newPath))
  }

  async function handleMoveModels() {
    if (!pendingModelsDir) return
    setModelsActionStatus('busy')
    const result = await window.electron.fs.moveDirectory({ src: modelsDir, dest: pendingModelsDir })
    try {
      if (!result.success) throw new Error(result.error ?? 'Something went wrong. Please try again.')
      await applyModelsDir(pendingModelsDir)
      closeModelsModal()
    } catch (err) {
      setModelsActionError(err instanceof Error ? err.message : String(err))
      setModelsActionStatus('error')
    }
  }

  async function handleDeleteModels() {
    if (!pendingModelsDir) return
    setModelsActionStatus('busy')
    const result = await window.electron.fs.deleteDirectory(modelsDir)
    try {
      if (!result.success) throw new Error(result.error ?? 'Something went wrong. Please try again.')
      await applyModelsDir(pendingModelsDir)
      closeModelsModal()
    } catch (err) {
      setModelsActionError(err instanceof Error ? err.message : String(err))
      setModelsActionStatus('error')
    }
  }

  function closeModelsModal() {
    setPendingModelsDir(null)
    setExistingModels([])
    setModelsActionError(null)
    setModelsActionStatus('idle')
  }

  async function handleMoveWorkspace() {
    if (!pendingWorkspaceDir) return
    setWorkspaceActionStatus('busy')
    const result = await window.electron.fs.moveDirectory({ src: workspaceDir, dest: pendingWorkspaceDir })
    try {
      if (!result.success) throw new Error(result.error ?? 'Something went wrong. Please try again.')
      await applyWorkspaceDir(pendingWorkspaceDir)
      closeWorkspaceModal()
    } catch (err) {
      setWorkspaceActionError(err instanceof Error ? err.message : String(err))
      setWorkspaceActionStatus('error')
    }
  }

  async function handleDeleteWorkspace() {
    if (!pendingWorkspaceDir) return
    setWorkspaceActionStatus('busy')
    const result = await window.electron.fs.deleteDirectory(workspaceDir)
    try {
      if (!result.success) throw new Error(result.error ?? 'Something went wrong. Please try again.')
      await applyWorkspaceDir(pendingWorkspaceDir)
      closeWorkspaceModal()
    } catch (err) {
      setWorkspaceActionError(err instanceof Error ? err.message : String(err))
      setWorkspaceActionStatus('error')
    }
  }

  function closeWorkspaceModal() {
    setPendingWorkspaceDir(null)
    setExistingWorkspaces([])
    setWorkspaceActionError(null)
    setWorkspaceActionStatus('idle')
  }

  async function handleMoveWorkflows() {
    if (!pendingWorkflowsDir) return
    setWorkflowsActionStatus('busy')
    const result = await window.electron.fs.moveDirectory({ src: workflowsDir, dest: pendingWorkflowsDir })
    try {
      if (!result.success) throw new Error(result.error ?? 'Something went wrong. Please try again.')
      await applyWorkflowsDir(pendingWorkflowsDir)
      closeWorkflowsModal()
    } catch (err) {
      setWorkflowsActionError(err instanceof Error ? err.message : String(err))
      setWorkflowsActionStatus('error')
    }
  }

  async function handleDeleteWorkflows() {
    if (!pendingWorkflowsDir) return
    setWorkflowsActionStatus('busy')
    const result = await window.electron.fs.deleteDirectory(workflowsDir)
    try {
      if (!result.success) throw new Error(result.error ?? 'Something went wrong. Please try again.')
      await applyWorkflowsDir(pendingWorkflowsDir)
      closeWorkflowsModal()
    } catch (err) {
      setWorkflowsActionError(err instanceof Error ? err.message : String(err))
      setWorkflowsActionStatus('error')
    }
  }

  function closeWorkflowsModal() {
    setPendingWorkflowsDir(null)
    setExistingWorkflows([])
    setWorkflowsActionError(null)
    setWorkflowsActionStatus('idle')
  }

  async function handleClearCache() {
    setCacheStatus('clearing')
    const result = await window.electron.cache.clear()
    if (!result.success) console.error('[cache:clear] renderer:', result.error)
    setCacheStatus(result.success ? 'done' : 'error')
    setTimeout(() => setCacheStatus('idle'), 2500)
  }

  return (
    <Section title="Storage" subtitle="Manage where models and outputs are saved on disk.">
      <div className="grid grid-cols-2 gap-4">

        <Card title="Directories" description="Paths used to store model weights and generated files.">
          <PathRow
            label="Models"
            description="Where downloaded AI model weights are stored."
            value={modelsDir}
            onBrowse={handleBrowseModels}
          />
          <PathRow
            label="Workspace"
            description="Where generated 3D files are saved."
            value={workspaceDir}
            onBrowse={handleBrowseWorkspace}
          />
          <PathRow
            label="Workflows"
            description="Where workflow definitions are saved."
            value={workflowsDir}
            onBrowse={handleBrowseWorkflows}
          />
          {storageError && <p className="text-[11px] text-red-400 break-words">{storageError}</p>}
        </Card>

        <Card title="Cache" description="Temporary files created during generation processing.">
          <Row label="Temp files" description="Intermediate files accumulated over time.">
            <button
              onClick={handleClearCache}
              disabled={cacheStatus === 'clearing'}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all disabled:opacity-50 ${
                cacheStatus === 'done'  ? 'bg-green-500/15 text-green-400' :
                cacheStatus === 'error' ? 'bg-red-500/15 text-red-400' :
                'bg-zinc-800 hover:bg-zinc-700 text-zinc-300'
              }`}
            >
              {cacheStatus === 'clearing' ? 'Clearing…' :
               cacheStatus === 'done'     ? '✓ Cleared' :
               cacheStatus === 'error'    ? '✗ Failed'  :
               'Clear cache'}
            </button>
          </Row>
        </Card>

      </div>

      {pendingModelsDir && (
        <MoveFolderModal
          title="Change models folder"
          currentDir={modelsDir}
          items={existingModels}
          otherCount={otherItems}
          itemLabel="model"
          moveLabel="Move to new folder"
          moveDesc="Transfer all models to the new location."
          deleteLabel="Delete models"
          deleteDesc="Remove from current folder. You'll need to re-download."
          status={modelsActionStatus}
          error={modelsActionError}
          onCancel={closeModelsModal}
          onMove={handleMoveModels}
          onDelete={handleDeleteModels}
        />
      )}

      {pendingWorkspaceDir && (
        <MoveFolderModal
          title="Change workspace folder"
          currentDir={workspaceDir}
          items={existingWorkspaces}
          otherCount={otherItems}
          itemLabel="item"
          moveLabel="Move to new folder"
          moveDesc="Transfer Modly's workspace files to the new location."
          deleteLabel="Delete workspace files"
          deleteDesc="Remove Modly's files from the current folder."
          status={workspaceActionStatus}
          error={workspaceActionError}
          onCancel={closeWorkspaceModal}
          onMove={handleMoveWorkspace}
          onDelete={handleDeleteWorkspace}
        />
      )}

      {pendingWorkflowsDir && (
        <MoveFolderModal
          title="Change workflows folder"
          currentDir={workflowsDir}
          items={existingWorkflows}
          otherCount={otherItems}
          itemLabel="workflow"
          moveLabel="Move to new folder"
          moveDesc="Transfer all workflow files to the new location."
          deleteLabel="Delete workflows"
          deleteDesc="Remove all workflow files from the current folder."
          status={workflowsActionStatus}
          error={workflowsActionError}
          onCancel={closeWorkflowsModal}
          onMove={handleMoveWorkflows}
          onDelete={handleDeleteWorkflows}
        />
      )}
    </Section>
  )
}

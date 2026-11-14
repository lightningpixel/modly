import { useAppStore, type GenerationJob } from '@shared/stores/appStore'

/** The viewer job for a mesh imported from disk (already converted by the API). */
export function importedMeshJob(url: string, now = Date.now()): GenerationJob {
  return {
    id: `import-${now}`,
    imageFile: '',
    status: 'done',
    progress: 100,
    outputUrl: url,
    originalOutputUrl: url,
    createdAt: now,
  }
}

/** Shows an imported mesh in Generate's viewer, as its first undo state. */
export function showImportedMesh(url: string): void {
  const { setCurrentJob, pushMeshUrl } = useAppStore.getState()
  setCurrentJob(importedMeshJob(url))
  pushMeshUrl(url)
}

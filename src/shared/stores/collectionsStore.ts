import { create } from 'zustand'
import type { Collection } from '@shared/types/collections'
import type { GenerationJob } from '@shared/stores/appStore'
import { useAppStore } from '@shared/stores/appStore'

interface JobMeta {
  id: string
  modelId?: string
  imageFile: string
  thumbnailUrl?: string
  originalTriangles?: number
  generationOptions?: import('@shared/stores/appStore').GenerationOptions
  createdAt: number
  filename: string
}

interface CollectionsState {
  collections: Collection[]
  activeCollectionId: string
  isLoaded: boolean

  loadCollections: () => Promise<void>
  createCollection: (name: string) => Promise<void>
  renameCollection: (oldName: string, newName: string) => Promise<void>
  deleteCollection: (name: string) => Promise<void>
  setActiveCollection: (id: string) => void
  addToWorkspace: (job: GenerationJob) => Promise<void>
  updateWorkspaceItem: (jobId: string, patch: Partial<GenerationJob>) => Promise<void>
  removeFromWorkspace: (jobId: string) => Promise<void>
}

async function syncCurrentJob(firstJob: GenerationJob | undefined) {
  const { setCurrentJob, setViewImage, clearViewImages, setGenerationOptions } = useAppStore.getState()
  if (!firstJob) {
    setCurrentJob(null)
    return
  }

  setCurrentJob({ ...firstJob, outputUrl: firstJob.originalOutputUrl ?? firstJob.outputUrl })
  clearViewImages()

  if (firstJob.generationOptions) {
    setGenerationOptions(firstJob.generationOptions)
  } else if (firstJob.modelId) {
    setGenerationOptions({ modelId: firstJob.modelId })
  }

  try {
    const base64 = await window.electron.fs.readFileBase64(firstJob.imageFile)
    const byteArray = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const blob = new Blob([byteArray], { type: 'image/png' })
    setViewImage('front', { path: firstJob.imageFile, previewUrl: URL.createObjectURL(blob), data: null })
  } catch {
    // Image file not readable, skip preview
  }
}

function jobFromMeta(meta: JobMeta, collectionName: string): GenerationJob {
  const url = `/workspace/${collectionName}/${meta.filename}`
  return {
    id: meta.id,
    imageFile: meta.imageFile,
    status: 'done',
    progress: 100,
    outputUrl: url,
    originalOutputUrl: url,
    thumbnailUrl: meta.thumbnailUrl,
    modelId: meta.modelId,
    originalTriangles: meta.originalTriangles,
    generationOptions: meta.generationOptions,
    createdAt: meta.createdAt,
  }
}

export const useCollectionsStore = create<CollectionsState>()((set, get) => ({
  collections: [],
  activeCollectionId: '',
  isLoaded: false,

  loadCollections: async () => {
    if (get().isLoaded) return

    let names: string[] = []
    try {
      names = await window.electron.workspace.listCollections()
    } catch {
      names = []
    }

    // Ensure at least Default exists
    if (names.length === 0) {
      await window.electron.workspace.createCollection('Default')
      names = ['Default']
    }

    const collections: Collection[] = await Promise.all(
      names.map(async (name) => {
        const rawMetas = await window.electron.workspace.listJobs(name)
        const jobs: GenerationJob[] = (rawMetas as JobMeta[])
          .map((m) => jobFromMeta(m, name))
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, 200)
        return { id: name, name, createdAt: Date.now(), jobs }
      })
    )

    const storedActiveId = localStorage.getItem('modly-activeCollection') ?? collections[0].id
    const activeCollectionId = collections.find((c) => c.id === storedActiveId)
      ? storedActiveId
      : collections[0].id

    set({ collections, activeCollectionId, isLoaded: true })
    const active = collections.find((c) => c.id === activeCollectionId)
    syncCurrentJob(active?.jobs[0])
  },

  createCollection: async (name) => {
    await window.electron.workspace.createCollection(name)
    const col: Collection = { id: name, name, createdAt: Date.now(), jobs: [] }
    set((s) => ({ collections: [...s.collections, col], activeCollectionId: name }))
    localStorage.setItem('modly-activeCollection', name)
    syncCurrentJob(undefined)
  },

  renameCollection: async (oldName, newName) => {
    await window.electron.workspace.renameCollection(oldName, newName)
    set((s) => {
      const collections = s.collections.map((c) => {
        if (c.id !== oldName) return c
        const jobs = c.jobs.map((j) => {
          const url = j.outputUrl?.replace(`/workspace/${oldName}/`, `/workspace/${newName}/`)
          const origUrl = j.originalOutputUrl?.replace(`/workspace/${oldName}/`, `/workspace/${newName}/`)
          return { ...j, outputUrl: url, originalOutputUrl: origUrl }
        })
        return { ...c, id: newName, name: newName, jobs }
      })
      const activeCollectionId = s.activeCollectionId === oldName ? newName : s.activeCollectionId
      if (s.activeCollectionId === oldName) {
        localStorage.setItem('modly-activeCollection', newName)
      }
      return { collections, activeCollectionId }
    })
  },

  deleteCollection: async (name) => {
    const { collections } = get()
    if (collections.length <= 1) return
    await window.electron.workspace.deleteCollection(name)
    set((s) => {
      const next = s.collections.filter((c) => c.id !== name)
      const activeCollectionId = s.activeCollectionId === name ? next[0].id : s.activeCollectionId
      if (s.activeCollectionId === name) {
        localStorage.setItem('modly-activeCollection', next[0].id)
        syncCurrentJob(next[0].jobs[0])
      }
      return { collections: next, activeCollectionId }
    })
  },

  setActiveCollection: (id) => {
    set((s) => {
      const firstJob = s.collections.find((c) => c.id === id)?.jobs[0]
      syncCurrentJob(firstJob)
      localStorage.setItem('modly-activeCollection', id)
      return { activeCollectionId: id }
    })
  },

  addToWorkspace: async (job) => {
    const parts = job.outputUrl?.split('/') ?? []
    const collectionName = parts[2] ?? get().activeCollectionId
    const filename = parts[3] ?? ''

    if (filename) {
      const meta: JobMeta = {
        id: job.id,
        modelId: job.modelId,
        imageFile: job.imageFile,
        thumbnailUrl: job.thumbnailUrl,
        originalTriangles: job.originalTriangles,
        generationOptions: job.generationOptions ?? useAppStore.getState().generationOptions,
        createdAt: job.createdAt,
        filename,
      }
      await window.electron.workspace.saveJobMeta(collectionName, filename, meta)
    }

    set((s) => {
      const collections = s.collections.map((c) => {
        if (c.id !== collectionName) return c
        const jobs = [job, ...c.jobs].slice(0, 200)
        return { ...c, jobs }
      })
      return { collections }
    })
  },

  updateWorkspaceItem: async (jobId, patch) => {
    set((s) => {
      const collections = s.collections.map((c) => ({
        ...c,
        jobs: c.jobs.map((j) => (j.id === jobId ? { ...j, ...patch } : j)),
      }))
      return { collections }
    })

    if (patch.thumbnailUrl !== undefined || patch.originalTriangles !== undefined) {
      const { collections } = get()
      for (const col of collections) {
        const job = col.jobs.find((j) => j.id === jobId)
        if (!job?.outputUrl) continue
        const parts = job.outputUrl.split('/')
        const collectionName = parts[2]
        const filename = parts[3]
        if (!filename) continue
        const meta: JobMeta = {
          id: job.id,
          modelId: job.modelId,
          imageFile: job.imageFile,
          thumbnailUrl: job.thumbnailUrl,
          originalTriangles: job.originalTriangles,
          generationOptions: job.generationOptions,
          createdAt: job.createdAt,
          filename,
        }
        await window.electron.workspace.saveJobMeta(collectionName, filename, meta)
        break
      }
    }
  },

  removeFromWorkspace: async (jobId) => {
    const { collections, activeCollectionId } = get()
    const col = collections.find((c) => c.id === activeCollectionId)
    const job = col?.jobs.find((j) => j.id === jobId)
    if (job?.outputUrl) {
      const parts = job.outputUrl.split('/')
      const collectionName = parts[2]
      const filename = parts[3]
      if (filename) {
        await window.electron.workspace.deleteJob(collectionName, filename)
      }
    }
    set((s) => {
      const collections = s.collections.map((c) => {
        if (c.id !== s.activeCollectionId) return c
        return { ...c, jobs: c.jobs.filter((j) => j.id !== jobId) }
      })
      return { collections }
    })
  },
}))

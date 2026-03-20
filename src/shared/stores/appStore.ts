import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type BackendStatus = 'not_started' | 'starting' | 'ready' | 'error'
export type SetupStatus = 'idle' | 'checking' | 'needed' | 'installing' | 'done' | 'error'
export interface SetupProgress { step: string; percent: number; currentPackage?: string }

export type GenerationStatus =
  | 'idle'
  | 'uploading'
  | 'generating'
  | 'done'
  | 'error'

export interface GenerationJob {
  id: string
  imageFile: string
  status: GenerationStatus
  progress: number
  step?: string
  outputUrl?: string
  originalOutputUrl?: string   // mesh URL before any optimization
  thumbnailUrl?: string
  modelId?: string             // model used for this generation
  originalTriangles?: number   // polygon count of the original mesh
  generationOptions?: GenerationOptions
  error?: string
  createdAt: number
}

export interface GenerationOptions {
  modelId: string
  vertexCount: number
  remesh: 'quad' | 'triangle' | 'none'
  enableTexture: boolean
  textureResolution: number
  octreeResolution: number
  guidanceScale: number
  seed: number
  numInferenceSteps: number
}

export type ViewSlot = 'front' | 'left' | 'back' | 'right'
export const VIEW_SLOTS: ViewSlot[] = ['front', 'left', 'back', 'right']

export interface ViewImage {
  path: string
  previewUrl: string
  data: string | null  // base64 for drag & drop
}

const DEFAULT_OPTIONS: GenerationOptions = {
  modelId: '',
  vertexCount: 10000,
  remesh: 'quad',
  enableTexture: false,
  textureResolution: 512,
  octreeResolution: 380,
  guidanceScale: 5.5,
  seed: -1,
  numInferenceSteps: 30,
}

interface AppState {
  // Backend
  backendStatus: BackendStatus
  apiUrl: string
  backendError: string | null

  // Current generation
  currentJob: GenerationJob | null

  // Selected images by view slot (front, left, back, right)
  viewImages: Partial<Record<ViewSlot, ViewImage>>
  setViewImage: (slot: ViewSlot, image: ViewImage) => void
  removeViewImage: (slot: ViewSlot) => void
  clearViewImages: () => void

  // Generation options
  generationOptions: GenerationOptions

  // Mesh stats (set by Viewer3D, read by GenerationHUD)
  meshStats: { vertices: number; triangles: number } | null
  setMeshStats: (stats: { vertices: number; triangles: number } | null) => void

  // Workspace panel
  workspacePanelOpen: boolean
  toggleWorkspacePanel: () => void

  // Setup
  setupStatus:   SetupStatus
  setupProgress: SetupProgress | null
  setupError:    string | null
  checkSetup:    () => Promise<void>
  runSetup:      () => Promise<void>

  // Actions
  initApp: () => Promise<void>
  setCurrentJob: (job: GenerationJob | null) => void
  updateCurrentJob: (patch: Partial<GenerationJob>) => void
  setGenerationOptions: (patch: Partial<GenerationOptions>) => void
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      backendStatus: 'not_started',
      apiUrl: '',
      backendError: null,

      setupStatus: 'idle',
      setupProgress: null,
      setupError: null,

      checkSetup: async () => {
        set({ setupStatus: 'checking' })
        const { needed } = await window.electron.setup.check()
        set({ setupStatus: needed ? 'needed' : 'done' })
      },

      runSetup: async () => {
        set({ setupStatus: 'installing', setupProgress: null, setupError: null })

        window.electron.setup.offProgress()
        window.electron.setup.offComplete()
        window.electron.setup.offError()

        window.electron.setup.onProgress((data) => {
          set({ setupProgress: data })
        })
        window.electron.setup.onComplete(() => {
          set({ setupStatus: 'done', setupProgress: null })
        })
        window.electron.setup.onError((data) => {
          set({ setupStatus: 'error', setupError: data.message })
        })

        // Fire and forget — progress comes via IPC events
        window.electron.setup.run()
      },

      currentJob: null,
      viewImages: {},
      setViewImage: (slot, image) => set((s) => ({
        viewImages: { ...s.viewImages, [slot]: image },
      })),
      removeViewImage: (slot) => set((s) => {
        const next = { ...s.viewImages }
        delete next[slot]
        return { viewImages: next }
      }),
      clearViewImages: () => set({ viewImages: {} }),
      generationOptions: DEFAULT_OPTIONS,
      meshStats: null,
      setMeshStats: (stats) => set({ meshStats: stats }),
      workspacePanelOpen: false,
      toggleWorkspacePanel: () => set((s) => ({ workspacePanelOpen: !s.workspacePanelOpen })),

      initApp: async () => {
        set({ backendStatus: 'starting', backendError: null })

        window.electron.python.offCrashed()
        window.electron.python.onCrashed(() => {
          set({ backendStatus: 'error', apiUrl: '', backendError: 'FastAPI crashed unexpectedly' })
        })

        try {
          const result = await window.electron.python.start()
          if (!result.success) throw new Error(result.error ?? 'Failed to start backend')
          const { apiUrl } = await window.electron.app.info()
          set({ backendStatus: 'ready', apiUrl })
        } catch (err) {
          set({
            backendStatus: 'error',
            backendError: err instanceof Error ? err.message : String(err),
          })
        }
      },

      setCurrentJob: (job) => set({ currentJob: job, meshStats: job === null ? null : get().meshStats }),

      updateCurrentJob: (patch) => {
        const current = get().currentJob
        if (!current) return
        set({ currentJob: { ...current, ...patch } })
      },

      setGenerationOptions: (patch) => {
        set((state) => ({ generationOptions: { ...state.generationOptions, ...patch } }))
      },
    }),
    {
      name: 'modly-store',
      partialize: (state) => ({
        generationOptions: state.generationOptions,
        workspacePanelOpen: state.workspacePanelOpen,
      }),
    }
  )
)

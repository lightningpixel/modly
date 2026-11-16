import { create } from 'zustand'
import type { ModelExtension, ProcessExtension, AnyExtension } from '@shared/types/electron.d'

// ─── Re-exports for consumers ─────────────────────────────────────────────────

export type { ModelExtension, ProcessExtension, AnyExtension }


export type InstallStep = 'downloading' | 'extracting' | 'validating' | 'setting_up' | 'done' | 'error'

export interface InstallProgress {
  step:         InstallStep
  percent?:     number
  extensionId?: string
  message?:     string
}

// ─── Store ────────────────────────────────────────────────────────────────────

interface ExtensionsStore {
  modelExtensions:   ModelExtension[]
  processExtensions: ProcessExtension[]
  loading:           boolean
  installProgress:   InstallProgress | null
  installError:      string | null
  loadErrors:        Record<string, string>
  /** Installed weight variant ids, keyed by "ext_id/node_id", for nodes that declare variants */
  installedWeightVariants: Record<string, string[]>

  loadExtensions:    () => Promise<void>
  refreshInstalledWeightVariants: () => Promise<void>
  installFromGitHub: (url: string) => Promise<{ success: boolean; error?: string }>
  installFromLocal:  () => Promise<{ success: boolean; error?: string; cancelled?: boolean; needsRepair?: boolean }>
  uninstall:         (extensionId: string) => Promise<{ success: boolean; error?: string }>
  reload:            () => Promise<void>
  clearInstallState: () => void
}

export function partitionExtensionsByType(list: AnyExtension[]): {
  modelExtensions: ModelExtension[]
  processExtensions: ProcessExtension[]
} {
  return {
    modelExtensions: list.filter((extension): extension is ModelExtension =>
      extension.type === 'model',
    ),
    processExtensions: list.filter((extension): extension is ProcessExtension =>
      extension.type === 'process',
    ),
  }
}

export const useExtensionsStore = create<ExtensionsStore>((set, get) => ({
  modelExtensions:   [],
  processExtensions: [],
  loading:           false,
  installProgress:   null,
  installError:      null,
  loadErrors:        {},
  installedWeightVariants: {},

  // ── Load list ──────────────────────────────────────────────────────────────

  async loadExtensions() {
    set({ loading: true })
    try {
      const list = (await window.electron.extensions.list()) as AnyExtension[]
      const extensions = partitionExtensionsByType(list)
      set({
        ...extensions,
        loading:           false,
      })
      await get().refreshInstalledWeightVariants()
    } catch {
      set({ loading: false })
    }
  },

  async refreshInstalledWeightVariants() {
    const entries = await Promise.all(
      get().modelExtensions.flatMap((ext) => ext.nodes
        .filter((node) => node.weightVariants)
        .map(async (node) => {
          const fullId = `${ext.id}/${node.id}`
          return [fullId, await window.electron.model.installedWeightVariants(fullId)] as const
        })),
    )
    // A node whose state could not be read stays absent: undefined reads as "unknown",
    // which the UI keeps neutral, while [] would claim no variant is installed.
    set({
      installedWeightVariants: Object.fromEntries(
        entries.filter((entry): entry is readonly [string, string[]] => entry[1] !== null),
      ),
    })
  },

  // ── Install from GitHub ────────────────────────────────────────────────────

  async installFromGitHub(url: string) {
    return installExtension(() => window.electron.extensions.installFromGitHub(url), set)
  },

  // ── Install from local folder ──────────────────────────────────────────────

  async installFromLocal() {
    const result = await installExtension(() => window.electron.extensions.installFromLocal(), set)
    // If user cancelled the folder picker, treat as a no-op (not an error)
    if ((result as any).cancelled) {
      set({ installProgress: null, installError: null })
      return { success: false, cancelled: true }
    }
    return result
  },

  // ── Uninstall ──────────────────────────────────────────────────────────────

  async uninstall(extensionId: string) {
    const result = await window.electron.extensions.uninstall(extensionId)
    if (result.success) {
      set((state) => ({
        modelExtensions:   state.modelExtensions.filter((e)   => e.id !== extensionId),
        processExtensions: state.processExtensions.filter((e) => e.id !== extensionId),
      }))
    }
    return result
  },

  // ── Reload (rescan extensions dir + Python registry) ──────────────────────

  async reload() {
    const result = await window.electron.extensions.reload()
    if (result.success) {
      set({ loadErrors: result.errors ?? {} })
    }
    await get().loadExtensions()
  },

  // ── Helpers ────────────────────────────────────────────────────────────────

  clearInstallState() {
    set({ installProgress: null, installError: null })
  },
}))

async function installExtension(
  invoke: () => Promise<{
    success: boolean
    error?: string
    extension?: AnyExtension
    extensionId?: string
    needsRepair?: boolean
  }>,
  set: (partial: Partial<ExtensionsStore> | ((state: ExtensionsStore) => Partial<ExtensionsStore>)) => void,
) {
    set({ installProgress: { step: 'downloading', percent: 0 }, installError: null })

    window.electron.extensions.onInstallProgress((data) => {
      if (data.step === 'error') {
        set({ installProgress: null, installError: data.message ?? 'Unknown error' })
      } else {
        set({ installProgress: data as InstallProgress })
      }
    })

    try {
      const result = await invoke()

      if (result.success && result.extension) {
        const ext = result.extension as AnyExtension
        set((state) => {
          if (ext.type === 'process') {
            const filtered = state.processExtensions.filter((e) => e.id !== ext.id)
            return {
              processExtensions: [...filtered, ext],
              modelExtensions: state.modelExtensions.filter((e) => e.id !== ext.id),
              installProgress:   { step: 'done', extensionId: result.extensionId },
              installError:      null,
            }
          } else {
            const filtered = state.modelExtensions.filter((e) => e.id !== ext.id)
            return {
              modelExtensions: [...filtered, ext],
              processExtensions: state.processExtensions.filter((e) => e.id !== ext.id),
              installProgress: { step: 'done', extensionId: result.extensionId },
              installError:    null,
            }
          }
        })
      } else if (result.needsRepair && result.extension) {
        const ext = result.extension as AnyExtension
        const error = result.error ?? 'Extension setup is incomplete. Click Repair and retry.'
        set((state) => ({
          modelExtensions: ext.type === 'model'
            ? [...state.modelExtensions.filter((entry) => entry.id !== ext.id), ext]
            : state.modelExtensions.filter((entry) => entry.id !== ext.id),
          processExtensions: ext.type === 'process'
            ? [...state.processExtensions.filter((entry) => entry.id !== ext.id), ext]
            : state.processExtensions.filter((entry) => entry.id !== ext.id),
          loadErrors: { ...state.loadErrors, [ext.id]: error },
          installProgress: null,
          installError: error,
        }))
      } else {
        set({ installProgress: null, installError: result.error ?? 'Installation failed' })
      }

      return result
    } catch (err) {
      const error = String(err)
      set({ installProgress: null, installError: error })
      return { success: false, error }
    } finally {
      window.electron.extensions.offInstallProgress()
    }
}

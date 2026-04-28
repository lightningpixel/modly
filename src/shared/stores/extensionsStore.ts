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

  loadExtensions:    () => Promise<void>
  installFromGitHub: (url: string) => Promise<{ success: boolean; error?: string }>
  uninstall:         (extensionId: string) => Promise<{ success: boolean; error?: string }>
  reload:            () => Promise<void>
  clearInstallState: () => void
}

export const useExtensionsStore = create<ExtensionsStore>((set, get) => ({
  modelExtensions:   [],
  processExtensions: [],
  loading:           false,
  installProgress:   null,
  installError:      null,
  loadErrors:        {},

  // ── Load list ──────────────────────────────────────────────────────────────

  async loadExtensions() {
    set({ loading: true })
    try {
      const list = (await window.electron.extensions.list()) as AnyExtension[]
      set({
        modelExtensions:   list.filter((e): e is ModelExtension   => e.type === 'model'),
        processExtensions: list.filter((e): e is ProcessExtension => e.type === 'process'),
        loading:           false,
      })
    } catch {
      set({ loading: false })
    }
  },

  // ── Install from GitHub ────────────────────────────────────────────────────

  async installFromGitHub(url: string) {
    return installExtension(() => window.electron.extensions.installFromGitHub(url), set)
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
  invoke: () => Promise<{ success: boolean; error?: string; extension?: AnyExtension; extensionId?: string }>,
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
              installProgress:   { step: 'done', extensionId: result.extensionId },
              installError:      null,
            }
          } else {
            const filtered = state.modelExtensions.filter((e) => e.id !== ext.id)
            return {
              modelExtensions: [...filtered, ext],
              installProgress: { step: 'done', extensionId: result.extensionId },
              installError:    null,
            }
          }
        })
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

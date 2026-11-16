import type { AnyExtension } from '@shared/types/electron.d'

export function formatModelName(id: string): string {
  return id
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

export function isExtensionRepairable(extension: AnyExtension): boolean {
  if (extension.type !== 'model') return false
  if (!extension.corrupted) return true
  return !extension.builtin && extension.manifestError === 'incomplete'
}

export async function finishExtensionRepair(
  result: { success: boolean; error?: string },
  refreshExtensions: () => void | Promise<void>,
): Promise<string | null> {
  // Quarantine begins before setup, so even a failed Repair changes which
  // extensions may appear in renderer/workflow state.
  await refreshExtensions()
  return result.success ? null : (result.error ?? 'Repair failed')
}

interface ActionResult {
  success: boolean
  error?: string
}

export async function deleteModelsThenUninstallExtension(
  extensionId: string,
  modelIds: Iterable<string>,
  deleteModel: (modelId: string) => Promise<ActionResult>,
  uninstallExtension: (extensionId: string) => Promise<ActionResult>,
): Promise<ActionResult> {
  for (const modelId of modelIds) {
    const result = await deleteModel(modelId)
    if (!result.success) {
      return {
        success: false,
        error: result.error ?? 'Could not delete selected model weights.',
      }
    }
  }

  return uninstallExtension(extensionId)
}

export interface ModelInstallResult {
  success: boolean
  error?: string
  paused?: boolean
  cancelled?: boolean
}

export async function installModelAndRefresh(
  install: () => Promise<ModelInstallResult>,
  refresh: () => Promise<void>,
): Promise<ModelInstallResult> {
  try {
    return await install()
  } finally {
    // A failed private source can leave a completed base usable by siblings.
    await refresh()
  }
}

export async function installModelQueue(
  modelIds: Iterable<string>,
  isReady: (id: string) => Promise<boolean>,
  install: (id: string) => Promise<ModelInstallResult>,
): Promise<ModelInstallResult> {
  for (const id of modelIds) {
    if (await isReady(id)) continue
    const result = await install(id)
    if (!result.success) return result
  }
  return { success: true }
}

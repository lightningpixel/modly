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

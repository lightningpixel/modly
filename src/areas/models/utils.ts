import type { AnyExtension } from '@shared/types/electron.d'

export const EXTENSION_REPOSITORY_REQUIREMENTS =
  'The repo must contain a manifest.json plus generator.py for a model extension or the declared entry file for a process extension.'

export function formatModelName(id: string): string {
  return id
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

export function getLocalSourcePath(ext: AnyExtension): string | null {
  return ext.source?.startsWith('local://') ? ext.source.slice('local://'.length) : null
}

export function supportsExtensionRepair(ext: AnyExtension): boolean {
  if (ext.corrupted) return false
  if (ext.type === 'model') return ext.repairable !== false
  if (ext.builtin) return false
  return ext.entry.endsWith('.py') && ext.repairable === true
}

export function localExtensionSetupMessage(ext: AnyExtension): string | null {
  if (!getLocalSourcePath(ext)) return null
  if (ext.type === 'process' && supportsExtensionRepair(ext)) {
    return 'Modly linked this source folder without running setup. Select Repair to install or refresh its Python environment and extension-managed assets.'
  }
  return 'Modly linked this source folder only. Dependencies and assets were not installed automatically.'
}

export function extensionRemovalCopy(
  ext: AnyExtension,
  selectedModelWeights = 0,
): { title: string; body: string; action: string } {
  if (getLocalSourcePath(ext)) {
    const selectedWeightsCopy = selectedModelWeights > 0
      ? ` and ${selectedModelWeights} selected model weight${selectedModelWeights === 1 ? '' : 's'}`
      : ''
    return {
      title: `Unlink “${ext.name}”?`,
      body: `Modly will remove its link${selectedWeightsCopy}. The source folder and files will remain on disk.`,
      action: 'Unlink',
    }
  }
  return {
    title: `Uninstall “${ext.name}”?`,
    body: 'The extension folder will be permanently deleted.',
    action: 'Uninstall',
  }
}

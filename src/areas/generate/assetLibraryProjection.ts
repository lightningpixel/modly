import type { AssetCapability, AssetLibraryEntry, AssetLibrarySourceScope } from '../../shared/types/assetLibrary'

export interface ProjectedAssetLibraryEntry extends AssetLibraryEntry {
  warnings: string[]
}

export type AssetLibraryOpenTarget =
  | { kind: 'self', url: string, workspacePath: string }
  | { kind: 'linked-source', url: string, workspacePath: string, sourceWorkspacePath: string }
  | { kind: 'unavailable', reason: string }

export interface AssetLibraryCapabilityGroup {
  capability: AssetCapability | 'uncategorized'
  entries: ProjectedAssetLibraryEntry[]
}

export interface AssetLibraryScopeGroup {
  scope: AssetLibrarySourceScope
  capabilityGroups: AssetLibraryCapabilityGroup[]
}

function isSafeWorkspacePath(workspacePath: string): boolean {
  const normalized = workspacePath.replace(/\\/g, '/').trim()
  return /^(Default|Workflows|Exports)\//.test(normalized)
    && !normalized.split('/').includes('..')
    && !/%2e|%2f|%5c/i.test(normalized)
    && !normalized.startsWith('/')
    && !/^[a-zA-Z]:[\\/]/.test(workspacePath)
    && !workspacePath.startsWith('\\\\')
}

function isGlbOrGltf(workspacePath: string): boolean {
  return /\.(glb|gltf)$/i.test(workspacePath)
}

export function projectAssetLibraryEntry(entry: AssetLibraryEntry): ProjectedAssetLibraryEntry {
  const warnings = [...new Set(entry.warnings)]
  if (!isSafeWorkspacePath(entry.workspacePath)) {
    return { ...entry, state: 'unsafe', openable: false, nonOpenableReason: entry.nonOpenableReason ?? 'Unsafe workspace path.', warnings }
  }
  const safeSource = entry.source && isSafeWorkspacePath(entry.source.workspacePath) ? entry.source : undefined
  const safeManifest = entry.manifest && isSafeWorkspacePath(entry.manifest.workspacePath) ? entry.manifest : undefined
  const safeParent = entry.semantic?.derivedFrom?.parent && isSafeWorkspacePath(entry.semantic.derivedFrom.parent.workspacePath)
    ? entry.semantic.derivedFrom.parent
    : undefined
  const safeRoot = entry.semantic?.derivedFrom?.root && isSafeWorkspacePath(entry.semantic.derivedFrom.root.workspacePath)
    ? entry.semantic.derivedFrom.root
    : undefined
  if (entry.source && !safeSource) warnings.push('Ignored unsafe source workspace path.')
  if (entry.manifest && !safeManifest) warnings.push('Ignored unsafe manifest workspace path.')
  if (entry.semantic?.derivedFrom && (!safeParent || !safeRoot)) warnings.push('Ignored unsafe asset lineage.')
  const semantic = entry.semantic
    ? {
        ...entry.semantic,
        derivedFrom: safeParent && safeRoot ? { parent: safeParent, root: safeRoot } : undefined,
      }
    : undefined
  return { ...entry, source: safeSource, manifest: safeManifest, semantic, warnings: [...new Set(warnings)] }
}

export function resolveAssetLibraryOpenTarget(entry: ProjectedAssetLibraryEntry): AssetLibraryOpenTarget {
  if (entry.state !== 'ready') {
    return { kind: 'unavailable', reason: entry.nonOpenableReason ?? 'Workspace asset is not openable.' }
  }
  if (entry.source?.workspacePath) {
    if (!isSafeWorkspacePath(entry.source.workspacePath) || entry.source.workspacePath === entry.workspacePath || !isGlbOrGltf(entry.source.workspacePath)) {
      return { kind: 'unavailable', reason: 'Linked source mesh is unavailable.' }
    }
    return {
      kind: 'linked-source',
      url: `/workspace/${entry.source.workspacePath}`,
      workspacePath: entry.workspacePath,
      sourceWorkspacePath: entry.source.workspacePath,
    }
  }
  if (!entry.openable) {
    return { kind: 'unavailable', reason: entry.nonOpenableReason ?? 'Workspace asset is not openable.' }
  }
  if (!isGlbOrGltf(entry.workspacePath)) {
    return { kind: 'unavailable', reason: 'Only safe .glb/.gltf workspace assets are openable in this release.' }
  }
  return { kind: 'self', url: `/workspace/${entry.workspacePath}`, workspacePath: entry.workspacePath }
}

export function filterAssetLibraryEntries(entries: ProjectedAssetLibraryEntry[], query: string): ProjectedAssetLibraryEntry[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return entries
  return entries.filter((entry) => [
    entry.displayName,
    entry.workspacePath,
    entry.capability ?? '',
    entry.sourceScope,
    entry.state,
    entry.source?.workspacePath ?? '',
    entry.manifest?.workspacePath ?? '',
    entry.semantic?.name ?? '',
    entry.semantic?.project ?? '',
    ...(entry.semantic?.tags ?? []),
    entry.semantic?.derivedFrom?.parent.workspacePath ?? '',
    entry.semantic?.derivedFrom?.root.workspacePath ?? '',
  ].some((value) => value.toLowerCase().includes(needle)))
}

export function groupAssetLibraryEntries(entries: ProjectedAssetLibraryEntry[]): AssetLibraryScopeGroup[] {
  const scopes = [...new Set(entries.map((entry) => entry.sourceScope))].sort()
  return scopes.map((scope) => {
    const scopeEntries = entries.filter((entry) => entry.sourceScope === scope)
    const capabilities = [...new Set(scopeEntries.map((entry) => entry.capability ?? 'uncategorized'))].sort()
    return {
      scope,
      capabilityGroups: capabilities.map((capability) => ({
        capability,
        entries: scopeEntries.filter((entry) => (entry.capability ?? 'uncategorized') === capability),
      })),
    }
  })
}

import {
  normalizeModelSources,
  safeModelSourceId,
  type ModelSourceNode,
} from './model-sources'

export interface InstallManifest {
  id?: string
  type?: 'model' | 'process'
  entry?: string
  generator_class?: string
  model_sources?: unknown
  nodes?: Array<{
    id?: string
    input?: unknown
    inputs?: unknown
    output?: unknown
    model_sources?: unknown
  } & ModelSourceNode>
}

export interface ValidatedInstallManifest {
  id: string
  isProcess: boolean
  isPythonProcess: boolean
  entryFile: string
  hasNodes: boolean
}

export interface ExtensionReloadPayload {
  reloaded: true
  models: string[]
  errors: Record<string, string>
}

export function assertSupportedSceneNodeShape(
  kind: 'model' | 'process',
  node: { id?: string; input?: unknown; inputs?: unknown; output?: unknown },
  declaredInputs: unknown[],
  output: unknown,
): void {
  const usesSceneInput = declaredInputs.includes('scene')
  if (kind === 'process' && (usesSceneInput || output === 'scene')) {
    throw new Error('manifest.json: scene input and output are supported only for model nodes')
  }
  if (kind === 'model' && usesSceneInput && (node.inputs !== undefined || node.input !== 'scene')) {
    throw new Error(`manifest.json: ${node.id ?? 'node'} must declare scene as its single input field`)
  }
}

export function assertSupportedVideoNodeShape(
  kind: 'model' | 'process',
  node: { id?: string; input?: unknown; inputs?: unknown; output?: unknown },
  declaredInputs: unknown[],
  output: unknown,
): void {
  const usesVideoInput = declaredInputs.includes('video')
  if (output === 'video') {
    throw new Error('manifest.json: video is supported only as a model input')
  }
  if (kind === 'process' && usesVideoInput) {
    throw new Error('manifest.json: video input is supported only for model nodes')
  }
  if (kind === 'model' && usesVideoInput && (node.inputs !== undefined || node.input !== 'video')) {
    throw new Error(`manifest.json: ${node.id ?? 'node'} must declare video as its single input field`)
  }
}

export type IncompleteInstallRecoveryAction =
  | 'none'
  | 'remove-incomplete'
  | 'restore-backup'

export function validateInstallManifest(
  manifest: InstallManifest,
  opts: {
    hasEntryFile: (entryFile: string) => boolean
    hasGeneratorFile: () => boolean
  },
  sourceLabel: string,
): ValidatedInstallManifest {
  if (!manifest.id) throw new Error('manifest.json: required field "id" missing')

  const isProcess = manifest.type === 'process'
  const entryFile = manifest.entry ?? 'processor.js'
  const nodes = Array.isArray(manifest.nodes) ? manifest.nodes.filter((node) => node?.id) : []
  const allowedInputs = new Set(['image', 'text', 'mesh', 'audio', 'scene', 'video'])
  const allowedOutputs = new Set(['image', 'text', 'mesh', 'audio', 'scene'])

  if (manifest.model_sources !== undefined) {
    throw new Error('manifest.json: model_sources must be declared on a model node')
  }
  for (const node of Array.isArray(manifest.nodes) ? manifest.nodes : []) {
    const declaredInputs = node.inputs === undefined ? [node.input ?? 'image'] : node.inputs
    if (!Array.isArray(declaredInputs) || declaredInputs.length === 0
        || declaredInputs.some((value) => typeof value !== 'string' || !allowedInputs.has(value))) {
      throw new Error(`manifest.json: ${node.id ?? 'node'}.input must use a supported artifact type`)
    }
    const output = node.output ?? 'mesh'
    assertSupportedSceneNodeShape(isProcess ? 'process' : 'model', node, declaredInputs, output)
    assertSupportedVideoNodeShape(isProcess ? 'process' : 'model', node, declaredInputs, output)
    if (typeof output !== 'string' || !allowedOutputs.has(output)) {
      throw new Error(`manifest.json: ${node.id ?? 'node'}.output must use a supported artifact type`)
    }
    if (node.model_sources === undefined) continue
    if (isProcess) {
      throw new Error('manifest.json: model_sources is supported only for model nodes')
    }
    safeModelSourceId(node.id, 'model node id')
    normalizeModelSources(node)
  }

  if (isProcess) {
    if (!opts.hasEntryFile(entryFile)) {
      throw new Error(`manifest.json: entry file "${entryFile}" missing from ${sourceLabel}`)
    }
  } else {
    if (!opts.hasGeneratorFile()) throw new Error(`generator.py missing from ${sourceLabel}`)
    if (!manifest.generator_class) throw new Error('manifest.json: required field "generator_class" missing')
  }

  return {
    id: manifest.id,
    isProcess,
    isPythonProcess: isProcess && entryFile.endsWith('.py'),
    entryFile,
    hasNodes: nodes.length > 0,
  }
}

export function isSetupFailureFatal(kind: {
  isProcess: boolean
  isPythonProcess: boolean
}): boolean {
  return !kind.isProcess || kind.isPythonProcess
}

export function assertCompatibleExtensionUpdateType(
  currentManifest: InstallManifest,
  nextManifest: InstallManifest,
): void {
  const currentType = currentManifest.type === 'process' ? 'process' : 'model'
  const nextType = nextManifest.type === 'process' ? 'process' : 'model'
  if (currentType !== nextType) {
    throw new Error(
      `Cannot update an extension from ${currentType} to ${nextType}. `
      + 'Uninstall the existing extension first, then install the new type.',
    )
  }
}

export function validateExistingExtensionReplacement(
  currentManifestJson: string,
  nextManifest: InstallManifest,
  opts: {
    hasEntryFile: (entryFile: string) => boolean
    hasGeneratorFile: () => boolean
  },
  sourceLabel: string,
): ValidatedInstallManifest {
  let currentManifest: unknown
  try {
    currentManifest = JSON.parse(currentManifestJson)
  } catch {
    throw new Error(
      'Cannot safely replace the existing extension because its manifest.json '
      + 'is unreadable or invalid. Uninstall it first.',
    )
  }

  if (
    typeof currentManifest !== 'object'
    || currentManifest === null
    || Array.isArray(currentManifest)
  ) {
    throw new Error(
      'Cannot safely replace the existing extension because its manifest.json '
      + 'is unreadable or invalid. Uninstall it first.',
    )
  }

  let validated: ValidatedInstallManifest
  try {
    validated = validateInstallManifest(
      currentManifest as InstallManifest,
      opts,
      sourceLabel,
    )
  } catch (error) {
    throw new Error(
      'Cannot safely replace the existing extension because its manifest.json '
      + `or referenced runtime files are invalid. Uninstall it first. ${String(error)}`,
    )
  }

  if (validated.id !== nextManifest.id) {
    throw new Error(
      `Cannot safely replace extension "${nextManifest.id ?? ''}" because the existing `
      + `manifest identifies "${validated.id}". Uninstall it first.`,
    )
  }
  assertCompatibleExtensionUpdateType(currentManifest as InstallManifest, nextManifest)
  return validated
}

export function markExtensionInstallationInterrupted<T extends object>(
  extension: T,
  interrupted: boolean,
): T | (T & { corrupted: true; manifestError: 'incomplete' }) {
  if (!interrupted) return extension
  return {
    ...extension,
    corrupted: true,
    manifestError: 'incomplete',
  }
}

export function expectedModelIds(manifest: InstallManifest): string[] {
  if (manifest.type === 'process') return []
  if (typeof manifest.id !== 'string' || !manifest.id) {
    throw new Error('manifest.json: required field "id" missing')
  }

  const nodeIds = Array.isArray(manifest.nodes)
    ? manifest.nodes
      .map((node) => node?.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
    : []

  return nodeIds.length > 0
    ? [...new Set(nodeIds.map((nodeId) => `${manifest.id}/${nodeId}`))]
    : [manifest.id]
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.values(value).every((entry) => typeof entry === 'string')
}

function parseExtensionReloadPayload(payload: unknown): ExtensionReloadPayload {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('Extension reload returned a malformed response')
  }

  const candidate = payload as Record<string, unknown>
  if (candidate.reloaded !== true
      || !Array.isArray(candidate.models)
      || !candidate.models.every((modelId) => typeof modelId === 'string')
      || !isStringRecord(candidate.errors)) {
    throw new Error('Extension reload returned a malformed response')
  }

  return {
    reloaded: true,
    models: candidate.models as string[],
    errors: candidate.errors,
  }
}

export function validateExtensionReloadPayload(
  payload: unknown,
  extensionId: string,
  expectedIds: string[],
): ExtensionReloadPayload {
  const parsed = parseExtensionReloadPayload(payload)
  const matchingErrors = Object.entries(parsed.errors).filter(([key]) =>
    key === extensionId || key.startsWith(`${extensionId}/`),
  )
  if (matchingErrors.length > 0) {
    const detail = matchingErrors.map(([key, message]) => `${key}: ${message}`).join('; ')
    throw new Error(`Runtime registration failed for extension "${extensionId}": ${detail}`)
  }

  const registered = new Set(parsed.models)
  const missing = expectedIds.filter((modelId) => !registered.has(modelId))
  if (missing.length > 0) {
    throw new Error(
      `Runtime registration failed for extension "${extensionId}": `
      + `missing model ${missing.length === 1 ? 'ID' : 'IDs'} ${missing.join(', ')}`,
    )
  }

  return parsed
}

export function validateExtensionQuarantinePayload(
  payload: unknown,
  extensionId: string,
  forbiddenIds: string[],
): ExtensionReloadPayload {
  const parsed = parseExtensionReloadPayload(payload)
  const registered = new Set(parsed.models)
  const stillRegistered = forbiddenIds.filter((modelId) => registered.has(modelId))
  if (stillRegistered.length > 0) {
    throw new Error(
      `Runtime quarantine failed for extension "${extensionId}": `
      + `model ${stillRegistered.length === 1 ? 'ID is' : 'IDs are'} still registered `
      + stillRegistered.join(', '),
    )
  }
  return parsed
}

export function incompleteInstallRecoveryAction(state: {
  destinationExists: boolean
  destinationIncomplete: boolean
  backupExists: boolean
}): IncompleteInstallRecoveryAction {
  if (!state.destinationExists || state.destinationIncomplete) {
    return state.backupExists ? 'restore-backup' : state.destinationIncomplete ? 'remove-incomplete' : 'none'
  }
  return 'none'
}

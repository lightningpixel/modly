import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export interface ModelSource {
  id: string
  provider: 'huggingface'
  repo_id: string
  revision?: string
  destination: string
  include_prefixes?: string[]
  skip_prefixes?: string[]
  checks: string[]
}

export interface ModelSourceNode {
  model_sources?: unknown
}

export interface ModelWeightGroup {
  id: string
  sources: ModelSource[]
}

export interface ModelWeightManifest {
  weight_groups?: unknown
}

export interface ModelWeightNode extends ModelSourceNode {
  weight_groups?: unknown
}

/** One separately installable set of files inside a node's model directory (e.g. a quantization). */
export interface WeightVariant {
  id: string
  label: string
  size_gb?: number
  vram_gb?: number
  include_prefixes: string[]
  checks: string[]
}

export interface WeightVariants {
  /** params_schema id whose value selects the variant at generation time */
  param: string
  default: string
  options: WeightVariant[]
}

export interface WeightVariantNode {
  weight_variants?: unknown
  hf_repo?: unknown
  download_check?: unknown
  model_sources?: unknown
  weight_groups?: unknown
  params_schema?: unknown
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const WINDOWS_UNSAFE = /[<>"|?*\u0000-\u001f]/

function portableSegment(value: string, field: string): string {
  if (
    !value
    || value === '.'
    || value === '..'
    || value.endsWith('.')
    || value.endsWith(' ')
    || value.includes(':')
    || WINDOWS_UNSAFE.test(value)
    || WINDOWS_DEVICE.test(value)
  ) {
    throw new Error(`${field} contains unsafe path segment "${value}"`)
  }
  return value
}

export function safeModelSourceId(value: unknown, field = 'model source id'): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || !SAFE_ID.test(value)) {
    throw new Error(`${field} must be a safe non-empty identifier`)
  }
  return portableSegment(value, field)
}

export function safeModelRelativePath(value: unknown, field: string, allowDot = false): string {
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    throw new Error(`${field} must be a non-empty relative path`)
  }
  if (allowDot && value === '.') return value
  if (value === '.' || value.startsWith('/') || value.includes('\\') || isAbsolute(value)) {
    throw new Error(`${field} must be a safe relative POSIX path`)
  }
  for (const part of value.split('/')) portableSegment(part, field)
  return value
}

function safePrefix(value: unknown, field: string): string {
  if (typeof value !== 'string') return safeModelRelativePath(value, field)
  const path = value.endsWith('/') ? value.slice(0, -1) : value
  safeModelRelativePath(path, field)
  return value
}

function optionalPrefixes(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`)
  return value.map((entry, index) => safePrefix(entry, `${field}[${index}]`))
}

function safeRepoId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.includes('\\')) {
    throw new Error(`${field} must be a non-empty Hugging Face repository id`)
  }
  const parts = value.split('/')
  if (parts.length > 2 || parts.some((part) => !SAFE_ID.test(part) || part === '.' || part === '..')) {
    throw new Error(`${field} is not a safe Hugging Face repository id`)
  }
  return value
}

function safeRevision(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value || value !== value.trim() || value.startsWith('/') || value.includes('\\') || value.includes('\0')) {
    throw new Error(`${field} must be a safe non-empty revision`)
  }
  if (value.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`${field} must be a safe revision`)
  }
  return value
}

export function normalizeModelSources(
  node: ModelSourceNode,
  fieldName = 'model_sources',
): ModelSource[] | undefined {
  if (!Object.prototype.hasOwnProperty.call(node, 'model_sources')) return undefined
  if (!Array.isArray(node.model_sources) || node.model_sources.length === 0) {
    throw new Error(`${fieldName} must be a non-empty array`)
  }

  const seen = new Map<string, string>()
  return node.model_sources.map((raw, index) => {
    const field = `${fieldName}[${index}]`
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(`${field} must be an object`)
    }
    const value = raw as Record<string, unknown>
    const id = safeModelSourceId(value.id, `${field}.id`)
    const alias = id.normalize('NFC').toLowerCase()
    const previous = seen.get(alias)
    if (previous) throw new Error(`model source ids "${previous}" and "${id}" are not portable-unique`)
    seen.set(alias, id)
    if (value.provider !== 'huggingface') throw new Error(`${field}.provider must be "huggingface"`)
    if (!Array.isArray(value.checks) || value.checks.length === 0) {
      throw new Error(`${field}.checks must be a non-empty array`)
    }

    const source: ModelSource = {
      id,
      provider: 'huggingface',
      repo_id: safeRepoId(value.repo_id, `${field}.repo_id`),
      destination: safeModelRelativePath(value.destination, `${field}.destination`, true),
      checks: value.checks.map((check, checkIndex) => (
        safeModelRelativePath(check, `${field}.checks[${checkIndex}]`)
      )),
    }
    const revision = safeRevision(value.revision, `${field}.revision`)
    const include = optionalPrefixes(value.include_prefixes, `${field}.include_prefixes`)
    const skip = optionalPrefixes(value.skip_prefixes, `${field}.skip_prefixes`)
    if (revision !== undefined) source.revision = revision
    if (include !== undefined) source.include_prefixes = include
    if (skip !== undefined) source.skip_prefixes = skip
    return source
  })
}

export function validateModelNodeIds(nodes: Array<{ id?: unknown }>): void {
  const seen = new Set<string>()
  for (const node of nodes) {
    if (typeof node?.id === 'string' && node.id.toLowerCase() === '_shared') {
      throw new Error('model node id "_shared" is reserved')
    }
    const id = safeModelSourceId(node?.id, 'model node id')
    const alias = id.toLowerCase()
    if (seen.has(alias)) throw new Error(`model node id "${id}" is not portable-unique`)
    seen.add(alias)
  }
}

export function normalizeWeightGroups(manifest: ModelWeightManifest): ModelWeightGroup[] | undefined {
  if (!Object.prototype.hasOwnProperty.call(manifest, 'weight_groups')) return undefined
  if (!Array.isArray(manifest.weight_groups) || manifest.weight_groups.length === 0) {
    throw new Error('weight_groups must be a non-empty array')
  }

  const seen = new Map<string, string>()
  return manifest.weight_groups.map((raw, index) => {
    const field = `weight_groups[${index}]`
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(`${field} must be an object`)
    }
    const value = raw as Record<string, unknown>
    if (typeof value.id === 'string' && value.id.toLowerCase() === '_shared') {
      throw new Error(`${field}.id uses the reserved identifier "_shared"`)
    }
    const id = safeModelSourceId(value.id, `${field}.id`)
    const alias = id.normalize('NFC').toLowerCase()
    const previous = seen.get(alias)
    if (previous) throw new Error(`weight group ids "${previous}" and "${id}" are not portable-unique`)
    seen.set(alias, id)
    const sources = normalizeModelSources(
      { model_sources: value.model_sources },
      `${field}.model_sources`,
    )
    return { id, sources: sources! }
  })
}

export function normalizeWeightGroupReferences(
  node: ModelWeightNode,
  groups: ModelWeightGroup[] | undefined,
  fieldName = 'weight_groups',
): string[] | undefined {
  if (!Object.prototype.hasOwnProperty.call(node, 'weight_groups')) return undefined
  if (!Array.isArray(node.weight_groups) || node.weight_groups.length === 0) {
    throw new Error(`${fieldName} must be a non-empty array of weight group ids`)
  }
  const available = new Map((groups ?? []).map((group) => [group.id.normalize('NFC').toLowerCase(), group.id]))
  const seen = new Map<string, string>()
  return node.weight_groups.map((raw, index) => {
    const id = safeModelSourceId(raw, `${fieldName}[${index}]`)
    const alias = id.normalize('NFC').toLowerCase()
    const previous = seen.get(alias)
    if (previous) throw new Error(`weight group references "${previous}" and "${id}" are not portable-unique`)
    seen.set(alias, id)
    const canonical = available.get(alias)
    if (!canonical) throw new Error(`${fieldName}[${index}] references unknown weight group "${id}"`)
    return canonical
  })
}

function prefixesOverlap(left: string[], right: string[]): boolean {
  return left.some((a) => right.some((b) => {
    const lowerA = a.toLowerCase()
    const lowerB = b.toLowerCase()
    return lowerA.startsWith(lowerB) || lowerB.startsWith(lowerA)
  }))
}

/** Variant ids must be selectable, so the param they key has to exist and offer them. */
function assertParamOffersVariants(param: string, paramsSchema: unknown, ids: string[]): void {
  const entry = Array.isArray(paramsSchema)
    ? paramsSchema.find((p) => typeof p === 'object' && p !== null && (p as { id?: unknown }).id === param)
    : undefined
  if (!entry) throw new Error(`weight_variants.param must name a params_schema entry ("${param}")`)
  const options = (entry as { options?: unknown }).options
  if (!Array.isArray(options)) return
  const values = new Set(options.map((option) =>
    typeof option === 'object' && option !== null ? String((option as { value?: unknown }).value) : String(option)))
  const missing = ids.filter((id) => !values.has(id))
  if (missing.length > 0) {
    throw new Error(`the "${param}" param must offer every weight variant id (missing: ${missing.join(', ')})`)
  }
}

export function normalizeWeightVariants(
  node: WeightVariantNode,
  paramsSchema?: unknown,
): WeightVariants | undefined {
  if (!Object.prototype.hasOwnProperty.call(node, 'weight_variants')) return undefined
  if (Object.prototype.hasOwnProperty.call(node, 'model_sources')) {
    throw new Error('weight_variants cannot be combined with model_sources')
  }
  if (Object.prototype.hasOwnProperty.call(node, 'weight_groups')) {
    throw new Error('weight_variants cannot be combined with weight_groups')
  }
  if (typeof node.hf_repo !== 'string' || !node.hf_repo) {
    throw new Error('weight_variants requires hf_repo on the same node')
  }
  const raw = node.weight_variants
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('weight_variants must be an object')
  }
  const value = raw as Record<string, unknown>
  const param = safeModelSourceId(value.param, 'weight_variants.param')
  if (!Array.isArray(value.options) || value.options.length === 0) {
    throw new Error('weight_variants.options must be a non-empty array')
  }

  const seen = new Map<string, string>()
  const options = value.options.map((rawOption, index): WeightVariant => {
    const field = `weight_variants.options[${index}]`
    if (typeof rawOption !== 'object' || rawOption === null || Array.isArray(rawOption)) {
      throw new Error(`${field} must be an object`)
    }
    const option = rawOption as Record<string, unknown>
    const id = safeModelSourceId(option.id, `${field}.id`)
    const alias = id.normalize('NFC').toLowerCase()
    const previous = seen.get(alias)
    if (previous) throw new Error(`weight variant ids "${previous}" and "${id}" are not portable-unique`)
    seen.set(alias, id)
    const label = option.label ?? id
    if (typeof label !== 'string' || !label.trim()) throw new Error(`${field}.label must be a non-empty string`)
    const sizeGb = option.size_gb
    if (sizeGb !== undefined && (typeof sizeGb !== 'number' || !Number.isFinite(sizeGb) || sizeGb <= 0)) {
      throw new Error(`${field}.size_gb must be a positive number`)
    }
    const vramGb = option.vram_gb
    if (vramGb !== undefined && (typeof vramGb !== 'number' || !Number.isFinite(vramGb) || vramGb <= 0)) {
      throw new Error(`${field}.vram_gb must be a positive number`)
    }
    const include = optionalPrefixes(option.include_prefixes, `${field}.include_prefixes`)
    if (!include?.length) throw new Error(`${field}.include_prefixes must be a non-empty array`)
    if (!Array.isArray(option.checks) || option.checks.length === 0) {
      throw new Error(`${field}.checks must be a non-empty array`)
    }
    const checks = option.checks.map((check, checkIndex) => {
      const path = safeModelRelativePath(check, `${field}.checks[${checkIndex}]`)
      if (!include.some((prefix) => path.startsWith(prefix))) {
        throw new Error(`${field}.checks[${checkIndex}] is not covered by its include_prefixes`)
      }
      return path
    })
    return {
      id,
      label,
      ...(sizeGb === undefined ? {} : { size_gb: sizeGb }),
      ...(vramGb === undefined ? {} : { vram_gb: vramGb }),
      include_prefixes: include,
      checks,
    }
  })

  options.forEach((variant, index) => {
    for (const other of options.slice(index + 1)) {
      if (prefixesOverlap(variant.include_prefixes, other.include_prefixes)) {
        throw new Error(`weight variants "${variant.id}" and "${other.id}" share files`)
      }
    }
  })
  const downloadCheck = node.download_check
  if (typeof downloadCheck === 'string' && options.some((variant) => prefixesOverlap([downloadCheck], variant.include_prefixes))) {
    throw new Error('download_check must name a file outside every weight variant')
  }
  const defaultId = value.default ?? options[0].id
  if (!options.some((variant) => variant.id === defaultId)) {
    throw new Error('weight_variants.default must name one of its options')
  }
  assertParamOffersVariants(param, paramsSchema ?? node.params_schema, options.map((variant) => variant.id))
  return { param, default: defaultId as string, options }
}

function pathHasSymlink(root: string, candidate: string): boolean {
  const rootPath = resolve(root)
  const rel = relative(rootPath, resolve(candidate))
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) return true
  let current = rootPath
  try {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) return true
    for (const part of rel.split(/[/\\]/).filter(Boolean)) {
      current = resolve(current, part)
      if (existsSync(current) && lstatSync(current).isSymbolicLink()) return true
    }
  } catch {
    return true
  }
  return false
}

export function resolveModelRoot(modelsDir: string, modelId: string): string {
  if (typeof modelId !== 'string') throw new Error('Model id must be a string')
  const parts = modelId.split('/')
  if (parts.length !== 2) throw new Error('Model id must identify one extension node')
  const extensionId = safeModelSourceId(parts[0], 'extension id')
  if (parts[1].toLowerCase() === '_shared') throw new Error('Model node id "_shared" is reserved')
  const nodeId = safeModelSourceId(parts[1], 'model node id')
  const root = resolve(modelsDir)
  const extensionRoot = resolveExtensionModelRoot(modelsDir, extensionId)
  const modelRoot = resolve(extensionRoot, nodeId)
  if (pathHasSymlink(root, modelRoot)) throw new Error('Model path resolves through a symlink')
  return modelRoot
}

export function resolveExtensionModelRoot(modelsDir: string, extensionId: string): string {
  const safeExtensionId = safeModelSourceId(extensionId, 'extension id')
  const root = resolve(modelsDir)
  const extensionRoot = resolve(root, safeExtensionId)
  if (pathHasSymlink(root, extensionRoot)) throw new Error('Extension model path resolves through a symlink')
  return extensionRoot
}

export function resolveWeightGroupRoot(modelsDir: string, extensionId: string, groupId: string): string {
  const safeExtensionId = safeModelSourceId(extensionId, 'extension id')
  if (typeof groupId === 'string' && groupId.toLowerCase() === '_shared') {
    throw new Error('Weight group id "_shared" is reserved')
  }
  const safeGroupId = safeModelSourceId(groupId, 'weight group id')
  const root = resolve(modelsDir)
  const extensionRoot = resolveExtensionModelRoot(modelsDir, safeExtensionId)
  const groupRoot = resolve(extensionRoot, '_shared', safeGroupId)
  if (pathHasSymlink(root, groupRoot)) throw new Error('Weight group path resolves through a symlink')
  return groupRoot
}

export function weightGroupTargetId(extensionId: string, groupId: string): string {
  const safeExtensionId = safeModelSourceId(extensionId, 'extension id')
  const safeGroupId = safeModelSourceId(groupId, 'weight group id')
  return `${safeExtensionId}/_shared/${safeGroupId}`
}

export function resolveWeightStorageRoot(modelsDir: string, targetId: string): string {
  if (typeof targetId !== 'string') throw new Error('Weight target id must be a string')
  const parts = targetId.split('/')
  if (parts.length === 2) return resolveModelRoot(modelsDir, targetId)
  if (parts.length === 3 && parts[1] === '_shared') {
    return resolveWeightGroupRoot(modelsDir, parts[0], parts[2])
  }
  throw new Error('Weight target id must identify one model node or extension weight group')
}

export function areModelSourcesDownloadedAtRoot(modelRoot: string, sources: ModelSource[]): boolean {
  try {
    if (!existsSync(modelRoot) || pathHasSymlink(modelRoot, modelRoot)) return false
    return sources.every((source) => {
      const destination = source.destination === '.'
        ? modelRoot
        : resolve(modelRoot, ...source.destination.split('/'))
      if (!existsSync(destination) || pathHasSymlink(modelRoot, destination)) return false
      return source.checks.every((check) => {
        const candidate = resolve(destination, ...check.split('/'))
        if (!existsSync(candidate) || pathHasSymlink(modelRoot, candidate)) return false
        try {
          const stat = statSync(candidate)
          return stat.isFile() && stat.size > 0
        } catch {
          return false
        }
      })
    })
  } catch {
    return false
  }
}

export function areModelSourcesDownloaded(modelsDir: string, modelId: string, sources: ModelSource[]): boolean {
  try {
    const modelRoot = resolveModelRoot(modelsDir, modelId)
    return areModelSourcesDownloadedAtRoot(modelRoot, sources)
  } catch {
    return false
  }
}

export function areWeightGroupSourcesDownloaded(
  modelsDir: string,
  extensionId: string,
  group: ModelWeightGroup,
): boolean {
  try {
    return areModelSourcesDownloadedAtRoot(
      resolveWeightGroupRoot(modelsDir, extensionId, group.id),
      group.sources,
    )
  } catch {
    return false
  }
}

export function modelHasLocalData(modelsDir: string, modelId: string): boolean {
  try {
    const modelRoot = resolveModelRoot(modelsDir, modelId)
    return existsSync(modelRoot) && readdirSync(modelRoot).length > 0
  } catch {
    return false
  }
}

export function weightStorageHasLocalData(modelsDir: string, targetId: string): boolean {
  try {
    const root = resolveWeightStorageRoot(modelsDir, targetId)
    return existsSync(root) && readdirSync(root).length > 0
  } catch {
    return false
  }
}

function isDownloadedFile(root: string, relativePath: string): boolean {
  const candidate = resolve(root, ...relativePath.split('/'))
  if (!existsSync(candidate) || pathHasSymlink(root, candidate)) return false
  try {
    const stat = statSync(candidate)
    return stat.isFile() && stat.size > 0
  } catch {
    return false
  }
}

export function installedWeightVariants(modelsDir: string, modelId: string, variants: WeightVariants): string[] {
  try {
    const modelRoot = resolveModelRoot(modelsDir, modelId)
    return variants.options
      .filter((variant) => variant.checks.every((check) => isDownloadedFile(modelRoot, check)))
      .map((variant) => variant.id)
  } catch {
    return []
  }
}

/** Files of one variant on disk (in-progress `.part` files included), never through a symlink. */
export async function listWeightVariantFiles(modelsDir: string, modelId: string, variant: WeightVariant): Promise<string[]> {
  const modelRoot = resolveModelRoot(modelsDir, modelId)
  if (!existsSync(modelRoot)) return []
  const entries = await readdir(modelRoot, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => resolve(entry.parentPath ?? modelRoot, entry.name))
    .filter((path) => {
      const relativePath = relative(modelRoot, path).split(sep).join('/')
      return variant.include_prefixes.some((prefix) => relativePath.startsWith(prefix))
        && !pathHasSymlink(modelRoot, path)
    })
}

// Mirrors the backend's cancel cleanup (api/routers/model.py): only the in-progress
// `.part` files are removed, so completed sources already on disk survive a cancel.
export async function removePartialDownloadArtifacts(modelRoot: string): Promise<void> {
  if (!existsSync(modelRoot)) return
  const entries = await readdir(modelRoot, { recursive: true, withFileTypes: true })
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.part'))
      .map((entry) => rm(resolve(entry.parentPath ?? modelRoot, entry.name), { force: true })),
  )
}

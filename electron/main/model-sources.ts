import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

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

export function normalizeModelSources(node: ModelSourceNode): ModelSource[] | undefined {
  if (!Object.prototype.hasOwnProperty.call(node, 'model_sources')) return undefined
  if (!Array.isArray(node.model_sources) || node.model_sources.length === 0) {
    throw new Error('model_sources must be a non-empty array')
  }

  const seen = new Map<string, string>()
  return node.model_sources.map((raw, index) => {
    const field = `model_sources[${index}]`
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
  const nodeId = safeModelSourceId(parts[1], 'model node id')
  const root = resolve(modelsDir)
  const modelRoot = resolve(root, extensionId, nodeId)
  if (pathHasSymlink(root, modelRoot)) throw new Error('Model path resolves through a symlink')
  return modelRoot
}

export function areModelSourcesDownloaded(modelsDir: string, modelId: string, sources: ModelSource[]): boolean {
  try {
    const modelRoot = resolveModelRoot(modelsDir, modelId)
    if (!existsSync(modelRoot)) return false
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

export function modelHasLocalData(modelsDir: string, modelId: string): boolean {
  try {
    const modelRoot = resolveModelRoot(modelsDir, modelId)
    return existsSync(modelRoot) && readdirSync(modelRoot).length > 0
  } catch {
    return false
  }
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

import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import {
  EXT_INCOMPLETE_MARKER,
  EXT_REGISTRATION_PENDING_MARKER,
  assertSafeExtensionId,
  resolveExtensionPathWithinRoot,
} from './extension-path-guard'
import { normalizeModelSources, safeModelSourceId, type ModelSource } from './model-sources'

interface InstalledNode {
  id?: unknown
  hf_repo?: unknown
  download_check?: unknown
  hf_skip_prefixes?: unknown
  hf_include_prefixes?: unknown
  model_sources?: unknown
}

interface InstalledManifest {
  id?: unknown
  type?: unknown
  model_sources?: unknown
  nodes?: unknown
}

export type InstalledModelDownloadPlan = {
  kind: 'legacy'
  modelId: string
  extensionId: string
  nodeId: string
  repoId: string
  downloadCheck?: string
  skipPrefixes?: string[]
  includePrefixes?: string[]
} | {
  kind: 'multi-source'
  modelId: string
  extensionId: string
  nodeId: string
  sources: ModelSource[]
}

async function hasPendingRegistration(root: string, extensionId: string): Promise<boolean> {
  try {
    const prefix = `${EXT_REGISTRATION_PENDING_MARKER}-${extensionId}-`
    return (await readdir(root)).some((name) => (
      name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length))
    ))
  } catch {
    return false
  }
}

function parseManifest(raw: string, extensionId: string, nodeId: string): InstalledModelDownloadPlan {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`Extension "${extensionId}" has an invalid manifest.json`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Extension "${extensionId}" has an invalid manifest.json`)
  }
  const manifest = parsed as InstalledManifest
  if (manifest.id !== extensionId) throw new Error(`Installed manifest id does not match extension "${extensionId}"`)
  if (manifest.type !== undefined && manifest.type !== 'model') {
    throw new Error(`Extension "${extensionId}" is not a model extension`)
  }
  if (manifest.model_sources !== undefined) {
    throw new Error('manifest.json: model_sources must be declared on a model node')
  }
  if (!Array.isArray(manifest.nodes)) throw new Error(`Extension "${extensionId}" does not declare model nodes`)

  const matches = manifest.nodes.filter((candidate): candidate is InstalledNode => (
    typeof candidate === 'object'
    && candidate !== null
    && !Array.isArray(candidate)
    && (candidate as InstalledNode).id === nodeId
  ))
  if (matches.length !== 1) {
    throw new Error(`Installed manifest must declare model node "${nodeId}" exactly once`)
  }

  const node = matches[0]
  const modelId = `${extensionId}/${nodeId}`
  const sources = normalizeModelSources(node)
  if (sources) return { kind: 'multi-source', modelId, extensionId, nodeId, sources }

  if (typeof node.hf_repo !== 'string' || !node.hf_repo) {
    throw new Error(`Model node "${modelId}" has no Hugging Face download source`)
  }
  return {
    kind: 'legacy',
    modelId,
    extensionId,
    nodeId,
    repoId: node.hf_repo,
    downloadCheck: typeof node.download_check === 'string' ? node.download_check : undefined,
    skipPrefixes: node.hf_skip_prefixes as string[] | undefined,
    includePrefixes: node.hf_include_prefixes as string[] | undefined,
  }
}

/** Re-read the installed manifest for every model action; renderer metadata is never trusted. */
export async function resolveInstalledModelDownloadPlan(args: {
  modelId: unknown
  userExtensionsDir: string
  builtinExtensionsDir: string
  blockedExtensionIds?: ReadonlySet<string>
}): Promise<InstalledModelDownloadPlan> {
  if (typeof args.modelId !== 'string') throw new Error('Model id must be a string')
  const parts = args.modelId.split('/')
  if (parts.length !== 2) throw new Error('Model id must identify one extension node')
  const extensionId = assertSafeExtensionId(parts[0])
  const nodeId = safeModelSourceId(parts[1], 'model node id')
  if (args.blockedExtensionIds?.has(extensionId)) {
    throw new Error(`Extension "${extensionId}" is being installed or repaired`)
  }

  const userPath = resolveExtensionPathWithinRoot(args.userExtensionsDir, extensionId)
  const builtinPath = resolveExtensionPathWithinRoot(args.builtinExtensionsDir, extensionId)
  const extensionPath = existsSync(userPath) ? userPath : existsSync(builtinPath) ? builtinPath : undefined
  if (!extensionPath) throw new Error(`Extension "${extensionId}" is not installed`)
  const extensionRoot = extensionPath === userPath ? args.userExtensionsDir : args.builtinExtensionsDir
  if (
    existsSync(join(extensionPath, EXT_INCOMPLETE_MARKER))
    || existsSync(join(extensionPath, EXT_REGISTRATION_PENDING_MARKER))
    || await hasPendingRegistration(extensionRoot, extensionId)
  ) {
    throw new Error(`Extension "${extensionId}" has an incomplete installation`)
  }

  const manifestPath = join(extensionPath, 'manifest.json')
  if (!existsSync(manifestPath)) throw new Error(`Extension "${extensionId}" has no manifest.json`)
  return parseManifest(await readFile(manifestPath, 'utf-8'), extensionId, nodeId)
}

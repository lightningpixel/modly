import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type {
  AssetCapability,
  AssetEntryState,
  AssetLibraryEntry,
  AssetLibraryError,
  AssetLibraryListResult,
  AssetLibraryOpenResult,
  AssetLibraryPreviewClip,
  AssetLibraryPreviewKind,
  AssetLibraryPreviewPayload,
  AssetLibraryReadResult,
  AssetLibrarySourceScope,
  AssetLibraryThumbnailResult,
} from '../../src/shared/types/assetLibrary'
import type { ArtifactProvenance } from '../../src/shared/types/artifacts'

const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/
const ENCODED_ESCAPE_PATTERN = /%2e|%2f|%5c/i
const ALLOWED_ROOTS = ['Workflows', 'Exports'] as const
const SKIPPED_DIRS = new Set(['tmp', 'temp', 'cache'])
const INTERNAL_SUFFIXES = ['.artifact.json', '.rigmeta.json'] as const
const TEXT_EXTENSIONS = new Set(['json', 'txt', 'md'])
const INTRINSIC_MOTION_EXTENSIONS = new Set(['bvh', 'npz'])
const MESH_EXTENSIONS = new Set(['glb', 'gltf', 'obj', 'stl', 'ply', 'splat'])

export interface AssetLibraryClassificationCandidate {
  workspacePath: string
  hasRigMetadata?: boolean
}

export interface AssetLibraryClassification {
  capability?: AssetCapability
  state: AssetEntryState
  previewKind: AssetLibraryPreviewKind
  openable: boolean
  nonOpenableReason?: string
}

export interface NormalizedWorkspaceAssetPath {
  workspacePath: string
  absolutePath: string
}

export interface WorkspaceAssetLibraryRequest {
  workspaceDir: string
}

export interface WorkspaceAssetLibraryReadRequest extends WorkspaceAssetLibraryRequest {
  workspacePath: string
  sourceWorkspacePath?: string
}

export interface WorkspaceAssetLibraryThumbnailRequest extends WorkspaceAssetLibraryRequest {
  workspacePath: string
  previewClip?: string
}

interface AssetLibraryMetadata {
  sourceWorkspacePath?: string
  manifestWorkspacePath?: string
  artifactId?: string
  versionId?: string
  provenance?: ArtifactProvenance
  warnings: string[]
}

export interface IpcMainLike {
  handle(channel: string, handler: (event: unknown, payload?: unknown) => Promise<unknown>): void
}

export interface WorkspaceAssetLibraryIpcDeps {
  ipcMain: IpcMainLike
  getWorkspaceDir: () => string
}

function libraryError(code: AssetLibraryError['code'], message: string): AssetLibraryError {
  return { code, message }
}

function normalizeSeparators(input: string): string {
  return input.replace(/\\/g, '/')
}

function isWindowsAbsolutePath(input: string): boolean {
  return WINDOWS_ABSOLUTE_PATH.test(input) || input.startsWith('\\\\')
}

function assertSafeWorkspaceRelativePath(workspacePath: string): string {
  const normalized = normalizeSeparators(workspacePath.trim())
  if (!normalized || normalized === '.') throw new Error('Workspace library path must be workspace-relative and non-empty')
  if (ENCODED_ESCAPE_PATTERN.test(normalized)) throw new Error('Workspace library path must not contain encoded path escapes')
  if (isAbsolute(normalized) || isWindowsAbsolutePath(workspacePath)) throw new Error('Workspace library path must not be absolute')
  const segments = normalized.split('/').filter((segment) => segment && segment !== '.')
  if (segments.some((segment) => segment === '..')) throw new Error('Workspace library path must not contain traversal segments')
  if (!ALLOWED_ROOTS.includes(segments[0] as typeof ALLOWED_ROOTS[number])) {
    throw new Error('Workspace library path must stay under allowed workspace library roots')
  }
  return segments.join('/')
}

export function normalizeWorkspaceAssetPath(workspaceDir: string, workspacePath: string): NormalizedWorkspaceAssetPath {
  const safePath = assertSafeWorkspaceRelativePath(workspacePath)
  const root = resolve(workspaceDir)
  const absolutePath = resolve(root, ...safePath.split('/'))
  const back = relative(root, absolutePath)
  if (!back || back.startsWith('..') || isAbsolute(back)) throw new Error('Workspace library path escapes the workspace root')
  return { workspacePath: safePath, absolutePath }
}

function extensionOf(workspacePath: string): string {
  return extname(workspacePath).slice(1).toLowerCase()
}

function isGlbOrGltf(workspacePath: string): boolean {
  return /\.(glb|gltf)$/i.test(workspacePath)
}

function sourceScopeFor(workspacePath: string): AssetLibrarySourceScope {
  return workspacePath.startsWith('Exports/') ? 'exports' : 'workflows'
}

export function classifyAssetLibraryCandidate(candidate: AssetLibraryClassificationCandidate): AssetLibraryClassification {
  const extension = extensionOf(candidate.workspacePath)

  if (candidate.workspacePath.endsWith('.landmarks.v1.json')) {
    return { capability: 'landmarks-sidecar', state: 'ready', previewKind: 'text', openable: false, nonOpenableReason: 'Landmark sidecars require opening their source mesh.' }
  }
  if (candidate.workspacePath.endsWith('.world.json')) {
    return { capability: 'generated-world', state: 'ready', previewKind: 'text', openable: false, nonOpenableReason: 'Generated worlds are list-only in this release.' }
  }
  if (candidate.workspacePath.endsWith('.scene.json')) {
    return { capability: 'scene-manifest', state: 'ready', previewKind: 'text', openable: false, nonOpenableReason: 'Scene manifests are list-only in this release.' }
  }
  if (INTRINSIC_MOTION_EXTENSIONS.has(extension)) {
    return { capability: 'animation-motion', state: 'ready', previewKind: 'binary', openable: false, nonOpenableReason: 'Motion files are list-only in this release.' }
  }
  if (extension === 'glb' || extension === 'gltf') {
    return { capability: candidate.hasRigMetadata ? 'rigged-mesh' : 'mesh', state: 'ready', previewKind: '3d-model', openable: true }
  }
  if (MESH_EXTENSIONS.has(extension)) {
    return { capability: 'mesh', state: 'ready', previewKind: 'binary', openable: false, nonOpenableReason: `.${extension} workspace assets are list-only in this release.` }
  }
  if (TEXT_EXTENSIONS.has(extension)) {
    return { state: 'unsupported', previewKind: 'text', openable: false, nonOpenableReason: 'Unsupported workspace asset.' }
  }
  return { state: 'unsupported', previewKind: 'binary', openable: false, nonOpenableReason: 'Unsupported workspace asset.' }
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function objectField(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function manifestCapabilityFor(workspacePath: string): 'generated-world' | 'scene-manifest' | undefined {
  if (workspacePath.endsWith('.world.json')) return 'generated-world'
  if (workspacePath.endsWith('.scene.json')) return 'scene-manifest'
  return undefined
}

async function safeLinkedWorkspacePath(workspaceDir: string, ownerWorkspacePath: string, candidate: unknown, expected?: { mustBeMesh?: boolean, mustBeManifest?: boolean }): Promise<{ workspacePath?: string, warning?: string }> {
  const raw = stringField(candidate)
  if (!raw) return {}
  let normalized: NormalizedWorkspaceAssetPath
  try {
    normalized = normalizeWorkspaceAssetPath(workspaceDir, raw)
  } catch {
    return { warning: 'Ignored unsafe linked workspace path.' }
  }
  if (normalized.workspacePath === ownerWorkspacePath) return { warning: 'Ignored self-linked workspace path.' }
  if (expected?.mustBeMesh && !isGlbOrGltf(normalized.workspacePath)) return { warning: 'Ignored non-GLB/GLTF source workspace path.' }
  if (expected?.mustBeManifest && !manifestCapabilityFor(normalized.workspacePath)) return { warning: 'Ignored non-manifest workspace path.' }
  try {
    await stat(normalized.absolutePath)
  } catch {
    return { warning: 'Ignored missing linked workspace path.' }
  }
  return { workspacePath: normalized.workspacePath }
}

async function readMetadata(workspaceDir: string, workspacePath: string, absolutePath: string): Promise<AssetLibraryMetadata> {
  const metadata: AssetLibraryMetadata = { warnings: [] }
  if (extensionOf(workspacePath) !== 'json') return metadata

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(await readFile(absolutePath, 'utf8')) as Record<string, unknown>
  } catch {
    return metadata
  }

  const sourceRaw = parsed.sourceWorkspacePath ?? parsed.source_workspace_path ?? parsed.sourcePath ?? objectField(parsed.source)?.workspacePath
  const source = await safeLinkedWorkspacePath(workspaceDir, workspacePath, sourceRaw, { mustBeMesh: true })
  if (source.workspacePath) metadata.sourceWorkspacePath = source.workspacePath
  if (source.warning) metadata.warnings.push(source.warning)

  const manifestRaw = parsed.manifestWorkspacePath ?? parsed.manifest_workspace_path ?? objectField(parsed.manifest)?.workspacePath
  const manifest = await safeLinkedWorkspacePath(workspaceDir, workspacePath, manifestRaw, { mustBeManifest: true })
  if (manifest.workspacePath) metadata.manifestWorkspacePath = manifest.workspacePath
  if (manifest.warning) metadata.warnings.push(manifest.warning)

  metadata.artifactId = stringField(parsed.artifactId ?? parsed.artifact_id)
  metadata.versionId = stringField(parsed.versionId ?? parsed.version_id)
  metadata.provenance = objectField(parsed.provenance) as ArtifactProvenance | undefined
  return metadata
}

function shouldSkipDirectory(name: string): boolean {
  return name.startsWith('.') || SKIPPED_DIRS.has(name.toLowerCase())
}

function shouldSkipFile(name: string): boolean {
  return name.startsWith('.') || INTERNAL_SUFFIXES.some((suffix) => name.endsWith(suffix))
}

async function hasRigMetadata(absolutePath: string): Promise<boolean> {
  if (!/\.(glb|gltf)$/i.test(absolutePath)) return false
  const stem = absolutePath.replace(/\.(glb|gltf)$/i, '')
  try {
    await stat(`${stem}.rigmeta.json`)
    return true
  } catch {
    return false
  }
}

async function buildEntry(workspaceDir: string, workspacePath: string): Promise<AssetLibraryEntry> {
  const { absolutePath } = normalizeWorkspaceAssetPath(workspaceDir, workspacePath)
  const stats = await stat(absolutePath)
  const classification = classifyAssetLibraryCandidate({ workspacePath, hasRigMetadata: await hasRigMetadata(absolutePath) })
  const metadata = await readMetadata(workspaceDir, workspacePath, absolutePath)
  const manifestCapability = metadata.manifestWorkspacePath ? manifestCapabilityFor(metadata.manifestWorkspacePath) : undefined
  return {
    id: `library:${workspacePath}`,
    workspacePath,
    displayName: basename(workspacePath),
    sourceScope: sourceScopeFor(workspacePath),
    capability: classification.capability,
    state: classification.state,
    previewKind: classification.previewKind,
    source: metadata.sourceWorkspacePath ? { workspacePath: metadata.sourceWorkspacePath, displayName: basename(metadata.sourceWorkspacePath), role: 'source-mesh' } : undefined,
    manifest: metadata.manifestWorkspacePath && manifestCapability ? { workspacePath: metadata.manifestWorkspacePath, capability: manifestCapability } : undefined,
    artifactId: metadata.artifactId,
    versionId: metadata.versionId,
    provenance: metadata.provenance,
    warnings: metadata.warnings,
    openable: classification.openable,
    nonOpenableReason: classification.nonOpenableReason,
    createdAt: (stats.birthtime.getTime() > 0 ? stats.birthtime : stats.mtime).toISOString(),
    updatedAt: stats.mtime.toISOString(),
  }
}

async function collectFiles(workspaceDir: string, rootName: typeof ALLOWED_ROOTS[number]): Promise<string[]> {
  const root = join(workspaceDir, rootName)
  const files: string[] = []

  async function walk(dir: string): Promise<void> {
    let entries: Awaited<ReturnType<typeof readdir>>
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!shouldSkipDirectory(entry.name)) await walk(join(dir, entry.name))
        continue
      }
      if (!entry.isFile() || shouldSkipFile(entry.name)) continue
      files.push(relative(workspaceDir, join(dir, entry.name)).split(sep).join('/'))
    }
  }

  await walk(root)
  return files
}

export async function listWorkspaceAssetLibrary(request: WorkspaceAssetLibraryRequest): Promise<AssetLibraryListResult> {
  try {
    const workspacePaths = (await Promise.all(ALLOWED_ROOTS.map((root) => collectFiles(request.workspaceDir, root)))).flat().sort()
    const entries = await Promise.all(workspacePaths.map((workspacePath) => buildEntry(request.workspaceDir, workspacePath)))
    return { success: true, entries: entries.filter((entry) => entry.state !== 'unsupported') }
  } catch (error) {
    return { success: false, error: libraryError('list-failed', error instanceof Error ? error.message : String(error)) }
  }
}

async function previewEntry(absolutePath: string, entry: AssetLibraryEntry): Promise<AssetLibraryPreviewPayload> {
  if (entry.previewKind === '3d-model') return { kind: '3d-model', viewerKind: extensionOf(entry.workspacePath) as 'glb' | 'gltf' }
  const stats = await stat(absolutePath)
  if (entry.previewKind === 'text') {
    const maxBytes = 64 * 1024
    const content = await readFile(absolutePath, 'utf8')
    return { kind: 'text', content: content.slice(0, maxBytes), byteLength: stats.size, truncated: content.length > maxBytes }
  }
  if (entry.previewKind === 'binary') {
    return { kind: 'binary', binaryKind: extensionOf(entry.workspacePath), byteLength: stats.size, message: 'Binary preview is unavailable.' }
  }
  return { kind: 'none' }
}

export async function readWorkspaceAssetLibraryEntry(request: WorkspaceAssetLibraryReadRequest): Promise<AssetLibraryReadResult> {
  try {
    const normalized = normalizeWorkspaceAssetPath(request.workspaceDir, request.workspacePath)
    const sourceValidation = await validateRequestedSource(request.workspaceDir, normalized.workspacePath, request.sourceWorkspacePath)
    if (!sourceValidation.success) return { success: false, error: sourceValidation.error }
    const entry = await buildEntry(request.workspaceDir, normalized.workspacePath)
    return { success: true, entry, preview: await previewEntry(normalized.absolutePath, entry) }
  } catch (error) {
    return { success: false, error: libraryError('unsafe-path', error instanceof Error ? error.message : String(error)) }
  }
}

async function validateRequestedSource(workspaceDir: string, workspacePath: string, sourceWorkspacePath?: string): Promise<{ success: true } | { success: false, error: AssetLibraryError }> {
  if (!sourceWorkspacePath) return { success: true }
  let source: NormalizedWorkspaceAssetPath
  try {
    source = normalizeWorkspaceAssetPath(workspaceDir, sourceWorkspacePath)
  } catch (error) {
    return { success: false, error: libraryError('unsafe-path', error instanceof Error ? error.message : String(error)) }
  }
  if (source.workspacePath === workspacePath) return { success: false, error: libraryError('not-openable', 'Linked source must not point to the same workspace asset.') }
  if (!isGlbOrGltf(source.workspacePath)) return { success: false, error: libraryError('not-openable', 'Linked source must be a safe .glb/.gltf workspace asset.') }
  try {
    await stat(source.absolutePath)
  } catch {
    return { success: false, error: libraryError('not-openable', 'Linked source workspace asset was not found.') }
  }
  const entry = await buildEntry(workspaceDir, workspacePath)
  if (entry.source?.workspacePath !== source.workspacePath) {
    return { success: false, error: libraryError('not-openable', 'Requested source does not match the indexed library source link.') }
  }
  return { success: true }
}

export async function openWorkspaceAssetLibraryEntry(request: WorkspaceAssetLibraryReadRequest): Promise<AssetLibraryOpenResult> {
  const read = await readWorkspaceAssetLibraryEntry(request)
  if (!read.success) return read
  if (request.sourceWorkspacePath) return { success: true, entry: read.entry }
  if (!read.entry.openable) {
    return { success: false, error: libraryError('not-openable', read.entry.nonOpenableReason ?? 'Workspace asset is not openable.') }
  }
  return { success: true, entry: read.entry }
}

function previewManifestAbsolutePathFor(absolutePath: string): string {
  return absolutePath.replace(/\.(glb|gltf)$/i, '.previews.json')
}

interface AssetLibraryPreviewManifestEntry {
  clip: string
  file: string
  duration: number
}

function parsePreviewManifestList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'object' && raw !== null) {
    const container = raw as Record<string, unknown>
    if (Array.isArray(container.previews)) return container.previews
    if (Array.isArray(container.clips)) return container.clips
  }
  return []
}

function parsePreviewManifestEntry(raw: unknown): AssetLibraryPreviewManifestEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const candidate = raw as Record<string, unknown>
  const clip = stringField(candidate.clip)
  const file = stringField(candidate.file)
  const duration = typeof candidate.duration === 'number' && Number.isFinite(candidate.duration) ? candidate.duration : undefined
  if (!clip || !file || duration === undefined) return null
  return { clip, file, duration }
}

// The preview manifest and its clips are generated by a separate pipeline (not
// thumbs.py) and may not exist yet, or may be malformed mid-write — both are
// normal, silent conditions handled the same way a missing thumbnail is.
async function readPreviewManifestEntries(absolutePath: string): Promise<AssetLibraryPreviewManifestEntry[]> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(previewManifestAbsolutePathFor(absolutePath), 'utf8'))
  } catch {
    return []
  }
  return parsePreviewManifestList(parsed)
    .map(parsePreviewManifestEntry)
    .filter((entry): entry is AssetLibraryPreviewManifestEntry => entry !== null)
}

async function readAssetLibraryPreviewClips(absolutePath: string): Promise<AssetLibraryPreviewClip[]> {
  const entries = await readPreviewManifestEntries(absolutePath)
  return entries.map(({ clip, duration }) => ({ clip, duration }))
}

/**
 * Resolves a manifest-listed clip name to a safe absolute WebP path. The
 * manifest's `file` is trusted only as a filename — any directory component is
 * discarded via `basename` — and the reconstructed sibling workspace path is
 * re-validated through the same `normalizeWorkspaceAssetPath` guard every
 * other workspace library read uses, so a stale or malformed manifest can
 * never point outside the asset's own directory.
 */
async function resolvePreviewClipAbsolutePath(
  workspaceDir: string,
  workspacePath: string,
  absolutePath: string,
  previewClip: string,
): Promise<string | null> {
  const entries = await readPreviewManifestEntries(absolutePath)
  const match = entries.find((entry) => entry.clip === previewClip)
  if (!match) return null
  const fileName = basename(match.file)
  if (extensionOf(fileName) !== 'webp') return null
  const siblingWorkspacePath = [...workspacePath.split('/').slice(0, -1), fileName].join('/')
  let normalized: NormalizedWorkspaceAssetPath
  try {
    normalized = normalizeWorkspaceAssetPath(workspaceDir, siblingWorkspacePath)
  } catch {
    return null
  }
  try {
    await stat(normalized.absolutePath)
  } catch {
    return null
  }
  return normalized.absolutePath
}

// Thumbnails are pre-rendered beside their source mesh (see thumbs.py): a
// `<name>.glb` asset may have a sibling `<name>.thumb.png`. Missing files are
// a normal, silent condition, never surfaced as an AssetLibraryError.
//
// The same request also serves looping preview clips generated by a separate
// pipeline as `<name>.preview-<clip>.webp`, listed in a sibling
// `<name>.previews.json` manifest. Passing `previewClip` fetches that clip's
// WebP instead of the static thumbnail; omitting it fetches the static
// thumbnail as before and, when a manifest exists, attaches the clip list so
// the UI can offer hover-to-animate without a second round trip to discover
// it. No manifest yet (the common case until the preview pipeline lands) is
// indistinguishable from today's behavior.
export async function readWorkspaceAssetLibraryThumbnail(request: WorkspaceAssetLibraryThumbnailRequest): Promise<AssetLibraryThumbnailResult> {
  try {
    const normalized = normalizeWorkspaceAssetPath(request.workspaceDir, request.workspacePath)
    if (!isGlbOrGltf(normalized.workspacePath)) return { success: false }

    if (request.previewClip) {
      const clipAbsolutePath = await resolvePreviewClipAbsolutePath(request.workspaceDir, normalized.workspacePath, normalized.absolutePath, request.previewClip)
      if (!clipAbsolutePath) return { success: false }
      const buffer = await readFile(clipAbsolutePath)
      return { success: true, dataUrl: `data:image/webp;base64,${buffer.toString('base64')}` }
    }

    const thumbnailAbsolutePath = normalized.absolutePath.replace(/\.(glb|gltf)$/i, '.thumb.png')
    const buffer = await readFile(thumbnailAbsolutePath)
    const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`
    const previews = await readAssetLibraryPreviewClips(normalized.absolutePath)
    return previews.length > 0 ? { success: true, dataUrl, previews } : { success: true, dataUrl }
  } catch {
    return { success: false }
  }
}

function readPayloadRequest(payload: unknown): { workspacePath?: string, sourceWorkspacePath?: string, previewClip?: string } {
  if (typeof payload !== 'object' || payload === null) return {}
  const values = payload as { workspacePath?: unknown, sourceWorkspacePath?: unknown, previewClip?: unknown }
  return {
    workspacePath: typeof values.workspacePath === 'string' ? values.workspacePath : undefined,
    sourceWorkspacePath: typeof values.sourceWorkspacePath === 'string' ? values.sourceWorkspacePath : undefined,
    previewClip: typeof values.previewClip === 'string' ? values.previewClip : undefined,
  }
}

export function registerWorkspaceAssetLibraryIpcHandlers(deps: WorkspaceAssetLibraryIpcDeps): void {
  deps.ipcMain.handle('workspace:library:list', async () => listWorkspaceAssetLibrary({ workspaceDir: deps.getWorkspaceDir() }))
  deps.ipcMain.handle('workspace:library:read', async (_event, payload) => {
    const { workspacePath, sourceWorkspacePath } = readPayloadRequest(payload)
    if (!workspacePath) return { success: false, error: libraryError('invalid-request', 'workspacePath is required.') }
    return readWorkspaceAssetLibraryEntry({ workspaceDir: deps.getWorkspaceDir(), workspacePath, sourceWorkspacePath })
  })
  deps.ipcMain.handle('workspace:library:open', async (_event, payload) => {
    const { workspacePath, sourceWorkspacePath } = readPayloadRequest(payload)
    if (!workspacePath) return { success: false, error: libraryError('invalid-request', 'workspacePath is required.') }
    return openWorkspaceAssetLibraryEntry({ workspaceDir: deps.getWorkspaceDir(), workspacePath, sourceWorkspacePath })
  })
  deps.ipcMain.handle('workspace:library:thumbnail', async (_event, payload) => {
    const { workspacePath, previewClip } = readPayloadRequest(payload)
    if (!workspacePath) return { success: false }
    return readWorkspaceAssetLibraryThumbnail({ workspaceDir: deps.getWorkspaceDir(), workspacePath, previewClip })
  })
}

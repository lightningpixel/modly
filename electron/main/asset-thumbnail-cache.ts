import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

import type {
  AssetThumbnailError,
  AssetThumbnailSaveResult,
  AssetThumbnailStatusResult,
} from '../../src/shared/types/assetLibrary'

// Thumbnails are rendered by the renderer (offscreen three.js, same rig as
// Viewer3D) and cached here, in a Modly-owned folder outside the workspace.
// Layout, flat in `thumbnailsDir`:
//   <pathKey>.<version>.webp  — the render of one file version
//   <pathKey>.json            — { workspaceDir, workspacePath } so pruning can
//                               find the source again from a hashed name
// pathKey hashes workspace dir + workspace path; version encodes the file's
// mtime and size, so an edited file misses the cache and is re-rendered.

export const THUMBNAIL_PROTOCOL = 'modly-thumb'
const THUMBNAIL_HOST = 'thumbnails'
/** Bump when the render rig changes so every cached thumbnail goes stale. */
export const THUMBNAIL_RENDER_REVISION = 1
const MAX_THUMBNAIL_BYTES = 1024 * 1024
const PATH_KEY_PATTERN = /^[0-9a-f]{32}$/
const THUMBNAIL_FILE_PATTERN = /^([0-9a-f]{32})\.([0-9a-z]+-[0-9a-z]+-r[0-9]+)\.webp$/
const ENCODED_ESCAPE_PATTERN = /%2e|%2f|%5c/i

export interface FileVersionStats {
  mtimeMs: number
  size: number
}

export interface ThumbnailCacheContext {
  workspaceDir: string
  thumbnailsDir: string
}

interface ThumbnailSidecar {
  workspaceDir: string
  workspacePath: string
}

function thumbnailError(code: AssetThumbnailError['code'], message: string): AssetThumbnailError {
  return { code, message }
}

/** Validates a workspace-relative .glb/.gltf path and resolves it inside the workspace. */
export function normalizeThumbnailSourcePath(workspaceDir: string, workspacePath: string): { workspacePath: string, absolutePath: string } {
  const normalized = workspacePath.trim().replace(/\\/g, '/')
  if (!normalized || ENCODED_ESCAPE_PATTERN.test(normalized)) throw new Error('Thumbnail source path is not a safe workspace path')
  if (isAbsolute(normalized) || /^[a-zA-Z]:[\\/]/.test(workspacePath) || workspacePath.startsWith('\\\\')) {
    throw new Error('Thumbnail source path must be workspace-relative')
  }
  const segments = normalized.split('/').filter((segment) => segment && segment !== '.')
  if (segments.length === 0 || segments.includes('..')) throw new Error('Thumbnail source path must not contain traversal segments')
  const safePath = segments.join('/')
  if (!/\.(glb|gltf)$/i.test(safePath)) throw new Error('Only .glb/.gltf meshes have thumbnails')
  const root = resolve(workspaceDir)
  const absolutePath = resolve(root, ...segments)
  const back = relative(root, absolutePath)
  if (!back || back.startsWith('..') || isAbsolute(back)) throw new Error('Thumbnail source path escapes the workspace root')
  return { workspacePath: safePath, absolutePath }
}

export function thumbnailPathKey(workspaceDir: string, workspacePath: string): string {
  return createHash('sha256').update(`${resolve(workspaceDir)}\n${workspacePath}`).digest('hex').slice(0, 32)
}

export function thumbnailVersion(stats: FileVersionStats): string {
  return `${Math.trunc(stats.mtimeMs).toString(36)}-${stats.size.toString(36)}-r${THUMBNAIL_RENDER_REVISION}`
}

export function thumbnailFileName(pathKey: string, version: string): string {
  return `${pathKey}.${version}.webp`
}

export function thumbnailUrlFor(fileName: string): string {
  return `${THUMBNAIL_PROTOCOL}://${THUMBNAIL_HOST}/${fileName}`
}

/** Maps a modly-thumb:// URL back to a cached file, or null for anything that is not one. */
export function resolveThumbnailUrl(thumbnailsDir: string, url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${THUMBNAIL_PROTOCOL}:` || parsed.hostname !== THUMBNAIL_HOST) return null
  const fileName = parsed.pathname.replace(/^\//, '')
  if (!THUMBNAIL_FILE_PATTERN.test(fileName)) return null
  return join(thumbnailsDir, fileName)
}

export function isWebpImage(bytes: Uint8Array): boolean {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end))
  return bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP'
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** URL of the cached thumbnail for this exact file version, if it was rendered already. */
export async function findCachedThumbnailUrl(context: ThumbnailCacheContext, workspacePath: string, stats: FileVersionStats): Promise<string | undefined> {
  const fileName = thumbnailFileName(thumbnailPathKey(context.workspaceDir, workspacePath), thumbnailVersion(stats))
  return await exists(join(context.thumbnailsDir, fileName)) ? thumbnailUrlFor(fileName) : undefined
}

export async function getThumbnailStatus(context: ThumbnailCacheContext, workspacePath: string): Promise<AssetThumbnailStatusResult> {
  let source: { workspacePath: string, absolutePath: string }
  try {
    source = normalizeThumbnailSourcePath(context.workspaceDir, workspacePath)
  } catch (error) {
    return { success: false, error: thumbnailError('unsafe-path', error instanceof Error ? error.message : String(error)) }
  }
  let stats: FileVersionStats
  try {
    stats = await stat(source.absolutePath)
  } catch {
    return { success: false, error: thumbnailError('not-found', 'Workspace mesh was not found.') }
  }
  return {
    success: true,
    workspacePath: source.workspacePath,
    version: thumbnailVersion(stats),
    thumbnailUrl: await findCachedThumbnailUrl(context, source.workspacePath, stats),
  }
}

async function cachedFilesFor(thumbnailsDir: string, pathKey: string): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(thumbnailsDir)
  } catch {
    return []
  }
  return names.filter((name) => THUMBNAIL_FILE_PATTERN.exec(name)?.[1] === pathKey)
}

/**
 * Stores a render under the version the renderer was given. A file edited
 * since then is refused as stale, so a thumbnail never claims a newer version
 * than the one it shows; older versions of the same path are dropped.
 */
export async function saveThumbnail(context: ThumbnailCacheContext, request: { workspacePath: string, version: string, image: unknown }): Promise<AssetThumbnailSaveResult> {
  if (!(request.image instanceof Uint8Array) || request.image.length > MAX_THUMBNAIL_BYTES || !isWebpImage(request.image)) {
    return { success: false, error: thumbnailError('invalid-image', 'Thumbnail must be a WebP image under 1 MB.') }
  }
  const status = await getThumbnailStatus(context, request.workspacePath)
  if (!status.success) return status
  if (status.version !== request.version) {
    return { success: false, error: thumbnailError('stale', 'Workspace mesh changed while its thumbnail was rendering.') }
  }

  const pathKey = thumbnailPathKey(context.workspaceDir, status.workspacePath)
  const fileName = thumbnailFileName(pathKey, status.version)
  const target = join(context.thumbnailsDir, fileName)
  try {
    await mkdir(context.thumbnailsDir, { recursive: true })
    const sidecar: ThumbnailSidecar = { workspaceDir: resolve(context.workspaceDir), workspacePath: status.workspacePath }
    await writeFile(join(context.thumbnailsDir, `${pathKey}.json`), JSON.stringify(sidecar), 'utf8')
    const temp = `${target}.${process.pid}.tmp`
    await writeFile(temp, request.image)
    await rename(temp, target)
    const outdated = (await cachedFilesFor(context.thumbnailsDir, pathKey)).filter((name) => name !== fileName)
    await Promise.all(outdated.map((name) => rm(join(context.thumbnailsDir, name), { force: true })))
  } catch (error) {
    return { success: false, error: thumbnailError('write-failed', error instanceof Error ? error.message : String(error)) }
  }
  return { success: true, thumbnailUrl: thumbnailUrlFor(fileName) }
}

async function removePathKey(thumbnailsDir: string, pathKey: string): Promise<void> {
  const files = [...await cachedFilesFor(thumbnailsDir, pathKey), `${pathKey}.json`]
  await Promise.all(files.map((name) => rm(join(thumbnailsDir, name), { force: true })))
}

/** Drops every cached thumbnail of a workspace path (used when the asset is deleted). */
export async function removeThumbnails(context: ThumbnailCacheContext, workspacePath: string): Promise<void> {
  const normalized = workspacePath.trim().replace(/\\/g, '/').split('/').filter((segment) => segment && segment !== '.').join('/')
  await removePathKey(context.thumbnailsDir, thumbnailPathKey(context.workspaceDir, normalized))
}

async function readSidecar(path: string): Promise<ThumbnailSidecar | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<ThumbnailSidecar>
    return typeof parsed.workspaceDir === 'string' && typeof parsed.workspacePath === 'string'
      ? { workspaceDir: parsed.workspaceDir, workspacePath: parsed.workspacePath }
      : null
  } catch {
    return null
  }
}

/**
 * Garbage-collects the cache: removes thumbnails whose source mesh is gone
 * (however it was deleted), versions that no longer match the file on disk,
 * and renders left without a sidecar.
 */
export async function pruneThumbnails(thumbnailsDir: string): Promise<void> {
  let names: string[]
  try {
    names = await readdir(thumbnailsDir)
  } catch {
    return
  }
  const sidecarKeys = new Set(names.filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length)).filter((key) => PATH_KEY_PATTERN.test(key)))

  for (const pathKey of sidecarKeys) {
    const sidecar = await readSidecar(join(thumbnailsDir, `${pathKey}.json`))
    let current: string | null = null
    if (sidecar) {
      try {
        const { absolutePath } = normalizeThumbnailSourcePath(sidecar.workspaceDir, sidecar.workspacePath)
        current = thumbnailFileName(pathKey, thumbnailVersion(await stat(absolutePath)))
      } catch {
        current = null
      }
    }
    if (!current) {
      await removePathKey(thumbnailsDir, pathKey)
      continue
    }
    const outdated = names.filter((name) => THUMBNAIL_FILE_PATTERN.exec(name)?.[1] === pathKey && name !== current)
    await Promise.all(outdated.map((name) => rm(join(thumbnailsDir, name), { force: true })))
  }

  const orphans = names.filter((name) => {
    const key = THUMBNAIL_FILE_PATTERN.exec(name)?.[1]
    return (key !== undefined && !sidecarKeys.has(key)) || name.endsWith('.tmp')
  })
  await Promise.all(orphans.map((name) => rm(join(thumbnailsDir, name), { force: true })))
}

export interface AssetThumbnailIpcDeps {
  ipcMain: { handle(channel: string, handler: (event: unknown, payload?: unknown) => Promise<unknown>): void }
  getWorkspaceDir: () => string
  thumbnailsDir: string
}

export function registerAssetThumbnailIpcHandlers(deps: AssetThumbnailIpcDeps): void {
  const context = (): ThumbnailCacheContext => ({ workspaceDir: deps.getWorkspaceDir(), thumbnailsDir: deps.thumbnailsDir })
  deps.ipcMain.handle('workspace:thumbnails:status', async (_event, payload) => {
    const workspacePath = (payload as { workspacePath?: unknown } | undefined)?.workspacePath
    if (typeof workspacePath !== 'string') return { success: false, error: thumbnailError('unsafe-path', 'workspacePath is required.') }
    return getThumbnailStatus(context(), workspacePath)
  })
  deps.ipcMain.handle('workspace:thumbnails:save', async (_event, payload) => {
    const values = (payload ?? {}) as { workspacePath?: unknown, version?: unknown, image?: unknown }
    if (typeof values.workspacePath !== 'string' || typeof values.version !== 'string') {
      return { success: false, error: thumbnailError('unsafe-path', 'workspacePath and version are required.') }
    }
    return saveThumbnail(context(), { workspacePath: values.workspacePath, version: values.version, image: values.image })
  })
}

import { randomBytes } from 'node:crypto'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { extname, isAbsolute, join } from 'node:path'

import { resolvePathWithinRoot } from './extension-path-guard'

// Images the renderer hands over as bytes (pasted from the clipboard, dropped
// from a browser) need a file on disk, since every image input in Modly is a
// path. They land in <workspaceDir>/Images/, never in the workspace's tmp/
// folder, which is wiped at each workflow run. Images picked from disk are not
// copied: their own path is used.

export const WORKSPACE_IMAGES_DIR = 'Images'
export const MAX_WORKSPACE_IMAGE_BYTES = 40 * 1024 * 1024

const EXTENSION_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
} as const

type ImageMime = keyof typeof EXTENSION_BY_MIME
type ImageExtension = (typeof EXTENSION_BY_MIME)[ImageMime]

const REVEALABLE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i
const MAX_BASE_NAME_LENGTH = 60

export type WorkspaceImageSaveResult =
  | { success: true, path: string }
  | { success: false, error: string }

function hasPrefix(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  return bytes.length >= offset + prefix.length && prefix.every((value, i) => bytes[offset + i] === value)
}

/** The format the bytes actually are, from their signature; null when not PNG, JPEG or WebP. */
export function sniffImageMime(bytes: Uint8Array): ImageMime | null {
  if (hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (hasPrefix(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (hasPrefix(bytes, [0x52, 0x49, 0x46, 0x46]) && hasPrefix(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp'
  return null
}

/**
 * A short, filesystem-safe stem from a user-facing name: no extension, no path,
 * only [A-Za-z0-9_-], never a reserved Windows device name. Falls back to "image".
 */
export function sanitizeImageBaseName(name: unknown): string {
  if (typeof name !== 'string') return 'image'
  const leaf = name.split(/[\\/]/).pop() ?? ''
  const stem = leaf.slice(0, leaf.length - extname(leaf).length) || leaf
  const safe = stem
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, MAX_BASE_NAME_LENGTH)
    .replace(/[-_]+$/g, '')
  if (!safe || WINDOWS_RESERVED_NAME.test(safe)) return 'image'
  return safe
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** `<stem>-YYYYMMDD-HHMMSS-<suffix>.<ext>`: sortable by time, unique by suffix. */
export function workspaceImageFileName(baseName: string, extension: ImageExtension, now: Date, suffix: string): string {
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${baseName}-${stamp}-${suffix}.${extension}`
}

export interface ValidatedImageRequest {
  bytes: Uint8Array
  extension: ImageExtension
  baseName: string
}

/**
 * Checks a save request from the renderer: bytes under the size cap whose
 * signature is a supported image and agrees with the declared MIME type.
 */
export function validateWorkspaceImageRequest(payload: unknown): ValidatedImageRequest | { error: string } {
  const values = (payload ?? {}) as { bytes?: unknown, name?: unknown, mime?: unknown }
  if (!(values.bytes instanceof Uint8Array) || values.bytes.byteLength === 0) return { error: 'Image bytes are required.' }
  if (values.bytes.byteLength > MAX_WORKSPACE_IMAGE_BYTES) return { error: 'Image is larger than 40 MB.' }
  if (typeof values.mime !== 'string' || !(values.mime in EXTENSION_BY_MIME)) return { error: 'Only PNG, JPEG and WebP images can be saved.' }
  const sniffed = sniffImageMime(values.bytes)
  if (sniffed !== values.mime) return { error: 'Image content does not match its type.' }
  return { bytes: values.bytes, extension: EXTENSION_BY_MIME[sniffed], baseName: sanitizeImageBaseName(values.name) }
}

export interface SaveWorkspaceImageDeps {
  now?: () => Date
  randomSuffix?: () => string
}

/** Writes the image to <workspaceDir>/Images/ under a fresh name and returns its absolute path. */
export async function saveWorkspaceImage(workspaceDir: string, payload: unknown, deps: SaveWorkspaceImageDeps = {}): Promise<WorkspaceImageSaveResult> {
  const request = validateWorkspaceImageRequest(payload)
  if ('error' in request) return { success: false, error: request.error }
  if (typeof workspaceDir !== 'string' || !workspaceDir.trim()) return { success: false, error: 'No workspace folder is set.' }

  const now = deps.now ?? (() => new Date())
  const randomSuffix = deps.randomSuffix ?? (() => randomBytes(3).toString('hex'))
  try {
    const dir = resolvePathWithinRoot(workspaceDir, WORKSPACE_IMAGES_DIR)
    await mkdir(dir, { recursive: true })
    for (let attempt = 0; attempt < 5; attempt++) {
      const fileName = workspaceImageFileName(request.baseName, request.extension, now(), randomSuffix())
      const target = resolvePathWithinRoot(workspaceDir, join(WORKSPACE_IMAGES_DIR, fileName))
      try {
        // 'wx' never overwrites: a clash just draws another suffix.
        await writeFile(target, request.bytes, { flag: 'wx' })
        return { success: true, path: target }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    return { success: false, error: 'Could not find a free file name for the image.' }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** An absolute path to an existing PNG/JPEG/WebP file, safe to reveal in the OS file manager. */
export async function isRevealableImagePath(path: unknown): Promise<boolean> {
  if (typeof path !== 'string' || !isAbsolute(path)) return false
  if (!REVEALABLE_EXTENSIONS.has(extname(path).toLowerCase())) return false
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

export interface WorkspaceImageIpcDeps {
  ipcMain: { handle(channel: string, handler: (event: unknown, payload?: unknown) => Promise<unknown>): void }
  getWorkspaceDir: () => string
  showItemInFolder: (path: string) => void
}

export function registerWorkspaceImageIpcHandlers(deps: WorkspaceImageIpcDeps): void {
  deps.ipcMain.handle('workspace:images:save', async (_event, payload) => saveWorkspaceImage(deps.getWorkspaceDir(), payload))
  deps.ipcMain.handle('workspace:images:reveal', async (_event, payload) => {
    if (!(await isRevealableImagePath(payload))) return { success: false, error: 'Not an image file.' }
    deps.showItemInFolder(payload as string)
    return { success: true }
  })
}

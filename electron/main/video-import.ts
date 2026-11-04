import { randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

const MAX_VIDEO_BYTES = 8 * 1024 ** 3
const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi'])

export interface ImportedWorkspaceVideo {
  workspacePath: string
  absolutePath: string
}

export async function importVideoToWorkspace(source: string, workspaceDir: string): Promise<ImportedWorkspaceVideo> {
  const info = await lstat(source)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Selected video must be a regular file')
  if (info.size <= 0 || info.size > MAX_VIDEO_BYTES) throw new Error('Selected video must be between 1 byte and 8 GiB')
  const extension = extname(source).toLowerCase()
  if (!VIDEO_EXTENSIONS.has(extension)) throw new Error('Selected video uses an unsupported extension')

  const importDir = join(workspaceDir, 'Workflows', 'Imported Videos')
  await mkdir(importDir, { recursive: true })
  const safeName = basename(source).replace(/[^a-zA-Z0-9._-]+/g, '_')
  const fileName = `${randomUUID()}-${safeName}`
  const absolutePath = join(importDir, fileName)
  await copyFile(source, absolutePath)
  const copied = await lstat(absolutePath)
  if (!copied.isFile() || copied.size !== info.size) throw new Error('Imported video copy could not be verified')
  return { workspacePath: `Workflows/Imported Videos/${fileName}`, absolutePath }
}

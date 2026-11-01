/** Fail-closed validation for settings-driven directory moves and deletions. */
import { randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readdir, rename, rm, rmdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/** Top-level Windows folders owned by the OS, refused on any drive. */
const WINDOWS_SYSTEM_DIRS = new Set([
  'windows', 'program files', 'program files (x86)', 'programdata', 'users',
  'perflogs', 'recovery', '$recycle.bin', 'system volume information',
])

type StorageDirs = {
  modelsDir: string
  workspaceDir: string
  workflowsDir: string
  extensionsDir: string
  dependenciesDir: string
  agentDir: string
}

type Options = {
  platform?: NodeJS.Platform
  homeDir?: string
  appDir?: string
}

type PathApi = typeof path.win32

function pathApi(options: Options): PathApi {
  return options.platform === 'win32' || (!options.platform && process.platform === 'win32')
    ? path.win32
    : path.posix
}

function absoluteDirectory(value: string, api: PathApi): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || !api.isAbsolute(value)) {
    throw new Error('Storage path must be a non-empty absolute path')
  }
  // Drive-relative, extended Windows and UNC paths need separate review.
  if (api === path.win32 && !/^[a-z]:[\\/]/i.test(value)) {
    throw new Error('Storage operations require a local drive-absolute path')
  }
  const resolved = api.normalize(value)
  if (resolved === api.parse(resolved).root) {
    throw new Error('Refusing a filesystem or volume root')
  }
  const pieces = resolved.slice(api.parse(resolved).root.length).split(api.sep).filter(Boolean)
  // POSIX top-level folders (/home, /usr, /mnt, /Volumes…) all belong to the system.
  if (api === path.posix && pieces.length < 2) {
    throw new Error('Storage directory must be at least two levels below the filesystem root')
  }
  // On Windows a top-level folder on a data drive (D:\Models) is a normal choice;
  // only the well-known system folders are refused.
  if (api === path.win32 && pieces.length === 1 && WINDOWS_SYSTEM_DIRS.has(pieces[0].toLowerCase())) {
    throw new Error('Refusing a Windows system folder')
  }
  return resolved
}

function equalPath(api: PathApi, a: string, b: string): boolean {
  return api.relative(a, b) === ''
}

function sameOrInside(api: PathApi, parent: string, candidate: string): boolean {
  const relative = api.relative(parent, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + api.sep) && !api.isAbsolute(relative))
}

function storageEntries(dirs: StorageDirs): Array<[string, string]> {
  return [
    ['models', dirs.modelsDir],
    ['workspace', dirs.workspaceDir],
    ['workflows', dirs.workflowsDir],
    ['extensions', dirs.extensionsDir],
    ['dependencies', dirs.dependenciesDir],
    ['agent', dirs.agentDir],
  ]
}

function verifySource(source: string, userData: string, options: Options): string {
  const api = pathApi(options)
  const safe = absoluteDirectory(source, api)
  const protectedRoots = [userData, options.homeDir ?? homedir(), options.appDir]
  for (const item of protectedRoots) {
    if (!item) continue
    const protectedPath = api.normalize(item)
    if (api.isAbsolute(protectedPath) && sameOrInside(api, safe, protectedPath)) {
      throw new Error('Refusing to remove an application, home, or user-data ancestor')
    }
  }
  return safe
}

function verifyNoOtherStorageInside(
  source: string, selectedKey: string, dirs: StorageDirs, options: Options,
): void {
  const api = pathApi(options)
  for (const [key, value] of storageEntries(dirs)) {
    if (key === selectedKey || !value) continue
    const other = api.normalize(value)
    if (api.isAbsolute(other) && sameOrInside(api, source, other)) {
      throw new Error('Refusing to remove another configured storage directory (' + key + ')')
    }
  }
}

/** Only exact configured roots, plus the specific workspace/tmp cleanup, are deletable. */
export function validateStorageDeletion(
  directory: string, dirs: StorageDirs, userData: string, options: Options = {},
): string {
  const api = pathApi(options)
  const target = absoluteDirectory(directory, api)
  const roots: Array<[string, string]> = [
    ['models', dirs.modelsDir],
    ['workspace', dirs.workspaceDir],
    ['workflows', dirs.workflowsDir],
    ['extensions', dirs.extensionsDir],
    ['cache', api.join(userData, 'gen-cache')],
  ]
  const selected = roots.find(([, root]) => root && equalPath(api, api.normalize(root), target))
  if (selected) {
    const safe = verifySource(selected[1], userData, options)
    verifyNoOtherStorageInside(safe, selected[0], dirs, options)
    return safe
  }
  const workspace = verifySource(dirs.workspaceDir, userData, options)
  if (equalPath(api, target, api.join(workspace, 'tmp'))) {
    verifyNoOtherStorageInside(target, 'workspace', dirs, options)
    return target
  }
  throw new Error('Path is not an approved Modly storage directory')
}

/** A folder move may delete its source: restrict source and destination equally. */
export function validateStorageMove(
  source: string, destination: string, dirs: StorageDirs, userData: string, options: Options = {},
): { src: string; dest: string } {
  const api = pathApi(options)
  const src = verifySource(source, userData, options)
  const selected = storageEntries(dirs).find(([key, val]) =>
    ['models', 'workspace', 'workflows'].includes(key) && equalPath(api, api.normalize(val), src))
  if (!selected) throw new Error('Source is not a configured Modly storage directory')
  verifyNoOtherStorageInside(src, selected[0], dirs, options)
  const dest = verifySource(destination, userData, options)
  if (sameOrInside(api, src, dest) || sameOrInside(api, dest, src)) {
    throw new Error('Source and destination must be separate, non-overlapping directories')
  }
  // Reject destinations overlapping ANY configured storage root.
  for (const [, value] of storageEntries(dirs)) {
    if (!value) continue
    const other = api.normalize(value)
    if (sameOrInside(api, other, dest) || sameOrInside(api, dest, other)) {
      throw new Error('Destination overlaps configured storage')
    }
  }
  return { src, dest }
}

/** Reject symlinks or Windows junctions in existing path ancestors. */
export async function assertNoSymlinkAncestors(directory: string, options: Options = {}): Promise<void> {
  const api = pathApi(options)
  const root = api.parse(directory).root
  let current = root
  for (const part of directory.slice(root.length).split(api.sep).filter(Boolean)) {
    current = api.join(current, part)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) throw new Error('Storage path contains a symbolic link: ' + current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
      throw error
    }
  }
}

export async function assertEmptyDestination(directory: string): Promise<void> {
  try {
    if ((await readdir(directory)).length > 0) {
      throw new Error('Destination must be empty to avoid overwriting existing files')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}

/** Main-process IPC handlers must use guarded operations, never raw rm/cp. */
export async function deleteStorageDirectory(
  directory: string, dirs: StorageDirs, userData: string, options: Options = {},
): Promise<void> {
  const safe = validateStorageDeletion(directory, dirs, userData, options)
  await assertNoSymlinkAncestors(safe, options)
  await rm(safe, { recursive: true, force: true })
}

export async function moveStorageDirectory(
  source: string, destination: string, dirs: StorageDirs, userData: string, options: Options = {},
): Promise<void> {
  const api = pathApi(options)
  const { src, dest } = validateStorageMove(source, destination, dirs, userData, options)
  await assertNoSymlinkAncestors(src, options)
  await assertNoSymlinkAncestors(dest, options)
  await assertEmptyDestination(dest)

  const parent = api.dirname(dest)
  await mkdir(parent, { recursive: true })
  // Copy into a fresh sibling folder that only this call writes to: a failed
  // copy can then be discarded without touching the source or the destination,
  // and a retry does not trip over a half-filled destination.
  const staging = api.join(parent, '.' + api.basename(dest) + '.modly-move-' + randomUUID())
  try {
    await cp(src, staging, { recursive: true, force: false, errorOnExist: true })
    // Remove the verified-empty destination; rmdir fails closed if a file appeared.
    try {
      await rmdir(dest)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    await rename(staging, dest)
  } catch (err) {
    await rm(staging, { recursive: true, force: true })
    throw err
  }

  // The source is deleted only once its complete copy sits at the destination.
  await assertNoSymlinkAncestors(src, options)
  await rm(src, { recursive: true, force: true })
}

/** Fail-closed validation for settings-driven directory moves and deletions. */
import { cp, lstat, mkdir, readdir, rm, rmdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

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
  // Never recursively delete a bare top-level user folder, even if configured.
  const pieces = resolved.slice(api.parse(resolved).root.length).split(api.sep).filter(Boolean)
  if (pieces.length < 2) {
    throw new Error('Storage directory must be at least two levels below its volume root')
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
export async function assertNoSymlinkAncestors(directory: string): Promise<void> {
  const api = process.platform === 'win32' ? path.win32 : path.posix
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
  await assertNoSymlinkAncestors(safe)
  await rm(safe, { recursive: true, force: true })
}

export async function moveStorageDirectory(
  source: string, destination: string, dirs: StorageDirs, userData: string, options: Options = {},
): Promise<void> {
  const paths = validateStorageMove(source, destination, dirs, userData, options)
  await assertNoSymlinkAncestors(paths.src)
  await assertNoSymlinkAncestors(paths.dest)
  await assertEmptyDestination(paths.dest)
  // fs.cp with errorOnExist refuses even an EMPTY existing directory. Remove
  // only the verified-empty destination, never the source, before copying.
  // rmdir itself fails closed if a concurrent writer adds a file.
  try {
    await rmdir(paths.dest)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  await mkdir(path.dirname(paths.dest), { recursive: true })
  // With a missing destination, errorOnExist protects against unexpected files.
  await cp(paths.src, paths.dest, { recursive: true, force: false, errorOnExist: true })
  // Re-validate before deleting the source. Never delete it after a copy error.
  validateStorageMove(paths.src, paths.dest, dirs, userData, options)
  await assertNoSymlinkAncestors(paths.src)
  await rm(paths.src, { recursive: true, force: true })
}

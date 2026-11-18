/**
 * Fail-closed validation for settings-driven directory moves and deletions.
 *
 * Modly only moves or deletes what it can tell is its own (#351: deleting the
 * "old models" wiped a whole drive the user had picked as models folder):
 * - a folder Modly created holds STORAGE_MARKER, or is the <base>/<kind>
 *   folder first-run setup creates next to <base>/extensions: all of it is Modly's;
 * - in any other models folder, only the sub-folders named after a known
 *   extension are; everything else is left where it is.
 */
import { randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

export const STORAGE_MARKER = '.modly-storage'
const MARKER_CONTENT = JSON.stringify({
  createdBy: 'Modly',
  note: 'Modly created this folder and may move or delete what is inside it.',
}, null, 2) + '\n'

export type StorageKind = 'models' | 'workspace' | 'workflows'
const STORAGE_KINDS: readonly string[] = ['models', 'workspace', 'workflows']

export type StorageEntries = {
  /** Entry names Modly may move or delete. */
  modly: string[]
  /** Entry names Modly did not create: never moved or deleted. */
  other: string[]
}

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
  /** Installed and built-in extension ids: the names of Modly's model folders. */
  knownModelIds?: Iterable<string>
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

function resolveDeletion(
  directory: string, dirs: StorageDirs, userData: string, options: Options,
): { safe: string; key: string } {
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
    return { safe, key: selected[0] }
  }
  const workspace = verifySource(dirs.workspaceDir, userData, options)
  if (equalPath(api, target, api.join(workspace, 'tmp'))) {
    verifyNoOtherStorageInside(target, 'workspace', dirs, options)
    return { safe: target, key: 'workspace-tmp' }
  }
  throw new Error('Path is not an approved Modly storage directory')
}

/** Only exact configured roots, plus the specific workspace/tmp cleanup, are deletable. */
export function validateStorageDeletion(
  directory: string, dirs: StorageDirs, userData: string, options: Options = {},
): string {
  return resolveDeletion(directory, dirs, userData, options).safe
}

/**
 * A folder the user picks as storage: not a drive root, a system folder, nor
 * an ancestor of the home, application or user-data folders.
 */
export function validateStorageLocation(directory: string, userData: string, options: Options = {}): string {
  return verifySource(directory, userData, options)
}

function resolveMove(
  source: string, destination: string, dirs: StorageDirs, userData: string, options: Options,
): { src: string; dest: string; kind: StorageKind } {
  const api = pathApi(options)
  const src = verifySource(source, userData, options)
  const selected = storageEntries(dirs).find(([key, val]) =>
    STORAGE_KINDS.includes(key) && equalPath(api, api.normalize(val), src))
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
  return { src, dest, kind: selected[0] as StorageKind }
}

/** A folder move may delete its source: restrict source and destination equally. */
export function validateStorageMove(
  source: string, destination: string, dirs: StorageDirs, userData: string, options: Options = {},
): { src: string; dest: string } {
  const { src, dest } = resolveMove(source, destination, dirs, userData, options)
  return { src, dest }
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file)
    return true
  } catch {
    return false
  }
}

/**
 * Whether Modly created `directory`: it holds the marker, or it is the
 * <base>/<kind> folder first-run setup creates beside <base>/extensions
 * (installs made before the marker existed).
 */
export async function isModlyOwnedRoot(
  kind: StorageKind, directory: string, dirs: StorageDirs, options: Options = {},
): Promise<boolean> {
  const api = pathApi(options)
  const dir = api.normalize(directory)
  if (await exists(api.join(dir, STORAGE_MARKER))) return true
  if (!dirs.extensionsDir) return false
  const extensions = api.normalize(dirs.extensionsDir)
  return api.basename(dir).toLowerCase() === kind
    && api.basename(extensions).toLowerCase() === 'extensions'
    && equalPath(api, api.dirname(dir), api.dirname(extensions))
}

/** Splits a storage folder's entries into Modly's own and everything else. */
export async function listStorageEntries(
  kind: StorageKind, directory: string, dirs: StorageDirs, options: Options = {},
): Promise<StorageEntries> {
  let entries
  try {
    entries = (await readdir(directory, { withFileTypes: true })).filter((e) => e.name !== STORAGE_MARKER)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { modly: [], other: [] }
    throw error
  }
  if (await isModlyOwnedRoot(kind, directory, dirs, options)) {
    return { modly: entries.map((e) => e.name), other: [] }
  }
  if (kind !== 'models') return { modly: [], other: entries.map((e) => e.name) }

  const fold = (name: string) => (pathApi(options) === path.win32 ? name.toLowerCase() : name)
  const known = new Set([...(options.knownModelIds ?? [])].map(fold))
  const modly: string[] = []
  const other: string[] = []
  for (const entry of entries) {
    // A real folder named after an extension; never a link out of the folder.
    if (entry.isDirectory() && !entry.isSymbolicLink() && known.has(fold(entry.name))) modly.push(entry.name)
    else other.push(entry.name)
  }
  return { modly, other }
}

/** Removes `directory` if nothing but the marker is left in it. */
async function removeIfEmpty(directory: string): Promise<void> {
  let names: string[]
  try {
    names = await readdir(directory)
  } catch {
    return
  }
  if (names.some((n) => n !== STORAGE_MARKER)) return
  await rm(path.join(directory, STORAGE_MARKER), { force: true })
  await rmdir(directory).catch(() => {})
}

/**
 * Makes `directory` ready as a storage folder and marks it Modly's when it is
 * new or empty. A folder that already holds the user's files stays unmarked,
 * so Modly will never delete them.
 */
export async function claimStorageDirectory(directory: string, userData: string, options: Options = {}): Promise<void> {
  const safe = validateStorageLocation(directory, userData, options)
  await assertNoSymlinkAncestors(safe, options)
  await mkdir(safe, { recursive: true })
  if ((await readdir(safe)).length === 0) await writeFile(path.join(safe, STORAGE_MARKER), MARKER_CONTENT)
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

/**
 * Main-process IPC handlers must use guarded operations, never raw rm/cp.
 * For the models, workspace and workflows folders only Modly's own entries are
 * deleted; the folder itself goes only once nothing else is left in it.
 */
export async function deleteStorageDirectory(
  directory: string, dirs: StorageDirs, userData: string, options: Options = {},
): Promise<{ removed: string[]; kept: string[] }> {
  const api = pathApi(options)
  const { safe, key } = resolveDeletion(directory, dirs, userData, options)
  await assertNoSymlinkAncestors(safe, options)
  if (!STORAGE_KINDS.includes(key)) {
    // Extensions, generation cache and workspace/tmp hold only Modly's files.
    await rm(safe, { recursive: true, force: true })
    return { removed: [api.basename(safe)], kept: [] }
  }
  const { modly, other } = await listStorageEntries(key as StorageKind, safe, dirs, options)
  for (const name of modly) await rm(api.join(safe, name), { recursive: true, force: true })
  await removeIfEmpty(safe)
  return { removed: modly, kept: other }
}

/** Moves Modly's own entries of a storage folder; anything else stays put. */
export async function moveStorageDirectory(
  source: string, destination: string, dirs: StorageDirs, userData: string, options: Options = {},
): Promise<{ moved: string[]; kept: string[] }> {
  const api = pathApi(options)
  const { src, dest, kind } = resolveMove(source, destination, dirs, userData, options)
  await assertNoSymlinkAncestors(src, options)
  await assertNoSymlinkAncestors(dest, options)
  await assertEmptyDestination(dest)
  const { modly, other } = await listStorageEntries(kind, src, dirs, options)

  const parent = api.dirname(dest)
  await mkdir(parent, { recursive: true })
  // Copy into a fresh sibling folder that only this call writes to: a failed
  // copy can then be discarded without touching the source or the destination,
  // and a retry does not trip over a half-filled destination.
  const staging = api.join(parent, '.' + api.basename(dest) + '.modly-move-' + randomUUID())
  try {
    await mkdir(staging)
    for (const name of modly) {
      await cp(api.join(src, name), api.join(staging, name), { recursive: true, force: false, errorOnExist: true })
    }
    // Modly made this folder, so it may manage everything in it later.
    await writeFile(api.join(staging, STORAGE_MARKER), MARKER_CONTENT)
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

  // The source entries are deleted only once their complete copy sits at the destination.
  await assertNoSymlinkAncestors(src, options)
  for (const name of modly) await rm(api.join(src, name), { recursive: true, force: true })
  await removeIfEmpty(src)
  return { moved: modly, kept: other }
}

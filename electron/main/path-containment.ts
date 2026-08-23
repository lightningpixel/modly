/**
 * Is a path inside a directory the app is allowed to touch?
 *
 * The renderer asks the main process to delete and move directories, and the
 * paths it passes are not always its own — they come from settings, from an
 * extension manifest, from a workflow file. `startsWith` on the raw strings is
 * not the test: "<workspace>_backup" starts with "<workspace>" without being
 * inside it, and an empty allowed root makes `startsWith` true for every path
 * on the disk, which turns the guard into a no-op.
 */
import { relative, resolve, isAbsolute } from 'path'

export function isPathInside(root: string, candidate: string): boolean {
  if (!root || !candidate) return false
  const rel = relative(resolve(root), resolve(candidate))
  // '' means the two are the same directory; '..' anywhere means it escaped;
  // an absolute result means they are on different drives.
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** The first allowed root that contains `candidate`, or undefined. */
export function containingRoot(roots: readonly (string | undefined)[], candidate: string): string | undefined {
  return roots.find((root): root is string => Boolean(root) && isPathInside(root as string, candidate))
}

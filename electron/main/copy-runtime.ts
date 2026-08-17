/**
 * Copying the bundled Python runtime out of an ephemeral AppImage mount.
 *
 * Kept apart from python-setup.ts (which imports electron) so the symlink
 * behaviour this depends on can be tested — it is subtle, silent when wrong,
 * and only shows up on the *next* launch.
 */

import { cp } from 'fs/promises'

/**
 * Copies a self-contained runtime tree, keeping relative symlinks relative.
 *
 * `verbatimSymlinks` is the whole point. Without it `fs.cp` resolves a relative
 * link (`bin/python3 -> python3.11`) into an absolute path pointing back at the
 * *source* tree. When the source is an AppImage mount at
 * /tmp/.mount_Modly-XXXXXX/ — which is a different path on every launch — the
 * copy silently keeps a hard dependency on a directory that is about to vanish:
 *
 *   - `bin/python3` in the "stable" copy points into the old mount
 *   - `sys._base_executable` of any venv made from it inherits that path
 *   - every extension venv records it in pyvenv.cfg and as a bin/python symlink
 *   - on the next launch the mount is gone, so every extension venv is dead
 *
 * The user-visible symptom is remote from the cause: the extension registry
 * finds no usable venv, falls back to importing generator.py in the main API
 * process, and reports a missing third-party module such as `No module named 'PIL'`.
 */
export async function copyRuntimeTree(source: string, destination: string): Promise<void> {
  await cp(source, destination, {
    recursive:          true,
    preserveTimestamps: true,
    verbatimSymlinks:   true,
  })
}

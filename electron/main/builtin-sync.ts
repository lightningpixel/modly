import { join } from 'path'
import { app, } from 'electron'
import { cpSync, existsSync, mkdirSync, rmSync } from 'fs'
import { is } from '@electron-toolkit/utils'
import { logger } from './logger'

export function getBuiltinExtensionsDir(): string {
  if (!app.isPackaged) {
    // Dev: use out/builtin-extensions directly so venvs (which have hardcoded
    // absolute paths) are not broken by being copied to a different location.
    return join(__dirname, '../../out/builtin-extensions')
  }
  return join(app.getPath('userData'), 'builtin-extensions')
}

function getBuiltinResourcesDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'builtin-extensions')
  }
  return join(__dirname, '../../out/builtin-extensions')
}

/**
 * Copies built-in extensions from app resources to userData/builtin-extensions.
 * In dev mode this is a no-op — extensions are used directly from out/.
 * Always overwrites — ensures built-ins are always up to date with the app version.
 */
export function syncBuiltinExtensions(): void {
  if (!app.isPackaged) {
    logger.info('[builtin-sync] Dev mode — using out/builtin-extensions directly, skipping sync.')
    return
  }

  const resourcesDir = getBuiltinResourcesDir()

  if (!existsSync(resourcesDir)) {
    logger.info('[builtin-sync] No built-in extensions resources found, skipping.')
    return
  }

  const destDir = getBuiltinExtensionsDir()

  // Wipe dest first so removed extensions don't linger
  try {
    if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true })
  } catch (e) {
    logger.warn(`[builtin-sync] Could not remove existing dir, skipping wipe: ${e}`)
  }
  mkdirSync(destDir, { recursive: true })

  cpSync(resourcesDir, destDir, {
    recursive: true,
    filter: (src) => !src.includes('.git') && !src.includes('venv'),
  })
  logger.info(`[builtin-sync] Built-in extensions synced to ${destDir}`)
}

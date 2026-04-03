import { join } from 'path'
import { app } from 'electron'
import { cpSync, existsSync, mkdirSync, rmSync } from 'fs'
import { logger } from './logger'

export function getBuiltinExtensionsDir(): string {
  return join(app.getPath('userData'), 'builtin-extensions')
}

function getBuiltinResourcesDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'builtin-extensions')
  }
  // Dev: built-ins compiled to out/builtin-extensions by build-builtins.mjs
  return join(__dirname, '../../out/builtin-extensions')
}

/**
 * Copies built-in extensions from app resources to userData/builtin-extensions.
 * Always overwrites — ensures built-ins are always up to date with the app version.
 */
export function syncBuiltinExtensions(): void {
  const resourcesDir = getBuiltinResourcesDir()

  if (!existsSync(resourcesDir)) {
    logger.info('[builtin-sync] No built-in extensions resources found, skipping.')
    return
  }

  const destDir = getBuiltinExtensionsDir()

  // Wipe dest first so removed extensions don't linger
  if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true })
  mkdirSync(destDir, { recursive: true })

  cpSync(resourcesDir, destDir, { recursive: true })
  logger.info(`[builtin-sync] Built-in extensions synced to ${destDir}`)
}

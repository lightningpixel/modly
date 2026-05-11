import { isAbsolute, relative, resolve as resolvePath } from 'node:path'

const EXTENSION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/

export function assertSafeExtensionId(extensionId: unknown): string {
  if (typeof extensionId !== 'string') {
    throw new Error('Extension id must be a string')
  }

  const trimmed = extensionId.trim()
  if (!trimmed) {
    throw new Error('Extension id must not be empty')
  }

  if (trimmed === '.' || trimmed === '..') {
    throw new Error(`Extension id "${extensionId}" is invalid`)
  }

  if (isAbsolute(trimmed)) {
    throw new Error(`Extension id "${extensionId}" must not be an absolute path`)
  }

  if (trimmed.includes('/') || trimmed.includes('\\')) {
    throw new Error(`Extension id "${extensionId}" must not contain path separators`)
  }

  if (!EXTENSION_ID_PATTERN.test(trimmed)) {
    throw new Error(`Extension id "${extensionId}" must match ${EXTENSION_ID_PATTERN}`)
  }

  return trimmed
}

export function resolvePathWithinRoot(rootDir: string, unsafeLeaf: string): string {
  const resolvedRoot = resolvePath(rootDir)
  const resolvedCandidate = resolvePath(resolvedRoot, unsafeLeaf)
  const normalizedRelative = relative(resolvedRoot, resolvedCandidate).replace(/\\/g, '/')

  if (normalizedRelative === '..' || normalizedRelative.startsWith('../') || isAbsolute(normalizedRelative)) {
    throw new Error(`Resolved path escapes root: ${unsafeLeaf}`)
  }

  return resolvedCandidate
}

export function resolveExtensionPathWithinRoot(rootDir: string, extensionId: unknown): string {
  return resolvePathWithinRoot(rootDir, assertSafeExtensionId(extensionId))
}

export function buildExtensionBackupPath(rootDir: string, extensionId: unknown, suffix: string): string {
  const safeId = assertSafeExtensionId(extensionId)
  return resolvePathWithinRoot(rootDir, `.modly-backup-${safeId}-${suffix}`)
}

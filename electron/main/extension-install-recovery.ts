import { existsSync } from 'fs'
import { open, readdir, rename, rm as rmAsync, writeFile } from 'fs/promises'
import { randomBytes } from 'crypto'
import { basename, join } from 'path'
import {
  EXT_BACKUP_PREFIX,
  EXT_INCOMPLETE_MARKER,
  EXT_REGISTRATION_PENDING_MARKER,
  EXT_STAGING_PREFIX,
  EXT_VALIDATED_MARKER,
  assertSafeExtensionId,
  isInternalExtensionDirName,
  parseExtensionBackupName,
  resolveExtensionPathWithinRoot,
  resolvePathWithinRoot,
} from './extension-path-guard'
import { incompleteInstallRecoveryAction } from './extension-install-utils'

const FS_RETRY_DELAYS_MS = [200, 500, 1500, 2500]
const REGISTRATION_PENDING_PREFIX = `${EXT_REGISTRATION_PENDING_MARKER}-`
const REGISTRATION_VALIDATED_PREFIX = `${EXT_VALIDATED_MARKER}-`

export interface InstallRecoveryLogger {
  info: (message: string) => void
  warn: (message: string) => void
}

const consoleLogger: InstallRecoveryLogger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
}

function isLockedFsError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
}

export type FsRetryResult =
  | { ok: true }
  | { ok: false; locked: boolean; error: unknown }

export type ExtensionMutationResult =
  | { ok: true }
  | {
    ok: false
    stage: 'scan' | 'backup' | 'destination' | 'marker'
    locked: boolean
    error: unknown
  }

export interface ExtensionRegistrationValidationCapability {
  extensionId: string
  destinationName: string
  stateName: string
  token: string
}

export type ExtensionRegistrationTransactionResult =
  | {
    ok: true
    validationCapability: ExtensionRegistrationValidationCapability
  }
  | Exclude<ExtensionMutationResult, { ok: true }>

async function fsWithRetry(
  op: () => Promise<void>,
  label: string,
  target: string,
  log: InstallRecoveryLogger,
): Promise<FsRetryResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      await op()
      return { ok: true }
    } catch (err) {
      if (!isLockedFsError(err) || attempt === FS_RETRY_DELAYS_MS.length) {
        log.warn(`[${label}] ${target}: ${err}`)
        return { ok: false, locked: isLockedFsError(err), error: err }
      }
      await new Promise((resolve) => setTimeout(resolve, FS_RETRY_DELAYS_MS[attempt]))
    }
  }
}

export const rmWithRetry = (
  path: string,
  label: string,
  log: InstallRecoveryLogger = consoleLogger,
): Promise<FsRetryResult> =>
  fsWithRetry(() => rmAsync(path, { recursive: true, force: true }), label, path, log)

export const renameWithRetry = (
  from: string,
  to: string,
  label: string,
  log: InstallRecoveryLogger = consoleLogger,
): Promise<FsRetryResult> =>
  fsWithRetry(() => rename(from, to), label, `${from} -> ${to}`, log)

const writeMarkerWithRetry = (
  path: string,
  label: string,
  log: InstallRecoveryLogger,
  content = new Date().toISOString(),
): Promise<FsRetryResult> =>
  fsWithRetry(
    () => writeFile(path, content, { encoding: 'utf-8', mode: 0o600 }),
    label,
    path,
    log,
  )

const writeCapabilityMarkerWithRetry = (
  path: string,
  content: string,
  log: InstallRecoveryLogger,
): Promise<FsRetryResult> =>
  fsWithRetry(
    async () => {
      const handle = await open(path, 'wx', 0o600)
      try {
        if (process.platform !== 'win32') await handle.chmod(0o600)
        await handle.writeFile(content, { encoding: 'utf-8' })
        await handle.sync()
        const fileStat = await handle.stat()
        if (!fileStat.isFile() || fileStat.nlink !== 1) {
          throw new Error('Registration capability sidecar must be a single regular file')
        }
        if (
          process.platform !== 'win32'
          && (
            (fileStat.mode & 0o077) !== 0
            || (typeof process.getuid === 'function' && fileStat.uid !== process.getuid())
          )
        ) {
          throw new Error('Registration capability sidecar permissions are unsafe')
        }
      } finally {
        await handle.close()
      }
    },
    'ext-install',
    path,
    log,
  )

function failedMutation(
  stage: Exclude<ExtensionMutationResult, { ok: true }>['stage'],
  result: Exclude<FsRetryResult, { ok: true }>,
): Exclude<ExtensionMutationResult, { ok: true }> {
  return {
    ok: false,
    stage,
    locked: result.locked,
    error: result.error,
  }
}

async function extensionBackupPaths(
  extensionsDir: string,
  extensionId: string,
): Promise<
  | { ok: true; paths: string[] }
  | { ok: false; stage: 'scan'; locked: boolean; error: unknown }
> {
  let names: string[]
  try {
    names = await readdir(extensionsDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, paths: [] }
    }
    return {
      ok: false,
      stage: 'scan',
      locked: isLockedFsError(error),
      error,
    }
  }

  return {
    ok: true,
    paths: names
      .filter((name) => parseExtensionBackupName(name)?.extensionId === extensionId)
      .sort()
      .reverse()
      .map((name) => join(extensionsDir, name)),
  }
}

function parseRegistrationStateName(
  name: string,
  prefix: string,
): { extensionId: string } | null {
  if (!name.startsWith(prefix)) return null
  const match = name.slice(prefix.length).match(/^(.+)-\d+$/)
  if (!match) return null
  try {
    return { extensionId: assertSafeExtensionId(match[1]) }
  } catch {
    return null
  }
}

export const parseExtensionRegistrationPendingName = (
  name: string,
): { extensionId: string } | null =>
  parseRegistrationStateName(name, REGISTRATION_PENDING_PREFIX)

function buildRegistrationStatePath(
  extensionsDir: string,
  extensionId: string,
  suffix: string,
  prefix: string,
): string {
  const safeId = assertSafeExtensionId(extensionId)
  if (!/^\d+$/.test(suffix)) throw new Error('Registration state suffix must be numeric')
  return resolvePathWithinRoot(extensionsDir, `${prefix}${safeId}-${suffix}`)
}

async function registrationStatePaths(
  extensionsDir: string,
  extensionId: string,
  prefix: string,
): Promise<
  | { ok: true; paths: string[] }
  | { ok: false; stage: 'scan'; locked: boolean; error: unknown }
> {
  let names: string[]
  try {
    names = await readdir(extensionsDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, paths: [] }
    }
    return {
      ok: false,
      stage: 'scan',
      locked: isLockedFsError(error),
      error,
    }
  }

  return {
    ok: true,
    paths: names
      .filter((name) => parseRegistrationStateName(name, prefix)?.extensionId === extensionId)
      .sort()
      .reverse()
      .map((name) => join(extensionsDir, name)),
  }
}

async function removeRegistrationState(
  extensionsDir: string,
  extensionId: string,
  log: InstallRecoveryLogger,
): Promise<ExtensionMutationResult> {
  for (const prefix of [REGISTRATION_PENDING_PREFIX, REGISTRATION_VALIDATED_PREFIX]) {
    const states = await registrationStatePaths(extensionsDir, extensionId, prefix)
    if (!states.ok) return states
    for (const statePath of states.paths) {
      const removed = await rmWithRetry(statePath, 'ext-cleanup', log)
      if (!removed.ok) return failedMutation('marker', removed)
    }
  }
  return { ok: true }
}

export const clearExtensionRegistrationTransaction = (
  extensionsDir: string,
  extensionId: string,
  log: InstallRecoveryLogger = consoleLogger,
): Promise<ExtensionMutationResult> =>
  removeRegistrationState(extensionsDir, extensionId, log)

export async function restoreExtensionBackup(
  destinationDir: string,
  backupDir: string,
  log: InstallRecoveryLogger = consoleLogger,
): Promise<ExtensionMutationResult> {
  const removed = await rmWithRetry(destinationDir, 'ext-restore', log)
  if (!removed.ok) return failedMutation('destination', removed)

  const restored = await renameWithRetry(backupDir, destinationDir, 'ext-restore', log)
  if (!restored.ok) return failedMutation('backup', restored)

  return { ok: true }
}

export async function beginExtensionRegistrationTransaction(
  extensionsDir: string,
  extensionId: string,
  suffix: string,
  log: InstallRecoveryLogger = consoleLogger,
): Promise<ExtensionRegistrationTransactionResult> {
  const safeExtensionId = assertSafeExtensionId(extensionId)
  const pendingPath = buildRegistrationStatePath(
    extensionsDir,
    safeExtensionId,
    suffix,
    REGISTRATION_PENDING_PREFIX,
  )
  const validationCapability: ExtensionRegistrationValidationCapability = {
    extensionId: safeExtensionId,
    destinationName: safeExtensionId,
    stateName: basename(pendingPath),
    token: randomBytes(32).toString('base64url'),
  }
  const marked = await writeCapabilityMarkerWithRetry(
    pendingPath,
    JSON.stringify({
      version: 1,
      extensionId: safeExtensionId,
      destinationName: safeExtensionId,
      token: validationCapability.token,
      consumed: false,
    }),
    log,
  )
  if (!marked.ok) return failedMutation('marker', marked)

  // The capability authorizes exactly one root sidecar. Keep the new marker in
  // place while removing older attempts so there is never an unquarantined
  // window, and a capability cannot implicitly bypass another transaction.
  const pendingStates = await registrationStatePaths(
    extensionsDir,
    safeExtensionId,
    REGISTRATION_PENDING_PREFIX,
  )
  if (!pendingStates.ok) return pendingStates
  for (const statePath of pendingStates.paths) {
    if (statePath === pendingPath) continue
    const removed = await rmWithRetry(statePath, 'ext-install', log)
    if (!removed.ok) return failedMutation('marker', removed)
  }

  return { ok: true, validationCapability }
}

export async function quarantineExtensionRegistrationFailure(
  extensionsDir: string,
  extensionId: string,
  log: InstallRecoveryLogger = consoleLogger,
): Promise<ExtensionMutationResult> {
  const pending = await registrationStatePaths(
    extensionsDir,
    extensionId,
    REGISTRATION_PENDING_PREFIX,
  )
  if (!pending.ok) return pending
  if (pending.paths.length > 0) return { ok: true }
  const started = await beginExtensionRegistrationTransaction(
    extensionsDir,
    extensionId,
    String(Date.now()),
    log,
  )
  return started.ok ? { ok: true } : started
}

export async function runExtensionRepairTransaction(
  options: {
    extensionsDir: string
    extensionId: string
    destinationDir: string
    suffix: string
    quarantine: () => Promise<void>
    setup: () => Promise<void>
    validate: (capability: ExtensionRegistrationValidationCapability) => Promise<void>
  },
  log: InstallRecoveryLogger = consoleLogger,
): Promise<void> {
  // Repair can mutate an existing environment before runtime validation. Mark
  // it pending first so a setup failure or process crash leaves the extension
  // externally quarantined for the next startup.
  const pendingRegistration = await beginExtensionRegistrationTransaction(
    options.extensionsDir,
    options.extensionId,
    options.suffix,
    log,
  )
  if (!pendingRegistration.ok) {
    throw new Error(
      `Could not preserve the extension rollback state during ${pendingRegistration.stage}: `
      + `${String(pendingRegistration.error)}`,
    )
  }

  // Evict any already-loaded generator before setup mutates its environment.
  // Failure here is also fail-closed: pending state remains for restart/UI
  // recovery, and setup never begins while stale runtime code is live.
  await options.quarantine()

  // Intentionally do not clear pending state when quarantine or setup fails. A
  // partially modified environment has not been proven safe to discover or
  // execute.
  await options.setup()

  try {
    await validateExtensionDestinationRegistration(
      options.destinationDir,
      () => options.validate(pendingRegistration.validationCapability),
      'ext-repair',
      log,
    )
  } catch (registrationError) {
    const quarantined = await quarantineExtensionRegistrationFailure(
      options.extensionsDir,
      options.extensionId,
      log,
    )
    if (!quarantined.ok) {
      throw new Error(
        `Runtime registration failed, and Modly could not preserve quarantine `
        + `during ${quarantined.stage}: ${String(quarantined.error)}. `
        + `Original failure: ${String(registrationError)}`,
      )
    }
    try {
      await options.quarantine()
    } catch (runtimeQuarantineError) {
      throw new Error(
        `Runtime registration failed, and Modly preserved filesystem quarantine but `
        + `could not evict partially registered runtime state: `
        + `${String(runtimeQuarantineError)}. Original failure: ${String(registrationError)}`,
      )
    }
    throw registrationError
  }

  const cleaned = await cleanupValidatedExtensionBackups(
    options.extensionsDir,
    options.extensionId,
    log,
  )
  if (!cleaned.ok) {
    throw new Error(
      `Runtime registration succeeded, but Modly could not finish removing the previous `
      + `extension backup during ${cleaned.stage}: ${String(cleaned.error)}. `
      + `Restart Modly to retry the validated cleanup.`,
    )
  }
}

export async function runExtensionRegistrationValidationTransaction(
  options: {
    extensionsDir: string
    extensionId: string
    suffix: string
    quarantine: () => Promise<void>
    activate: () => Promise<void>
    validate: (capability: ExtensionRegistrationValidationCapability) => Promise<void>
  },
  log: InstallRecoveryLogger = consoleLogger,
): Promise<void> {
  const pendingRegistration = await beginExtensionRegistrationTransaction(
    options.extensionsDir,
    options.extensionId,
    options.suffix,
    log,
  )
  if (!pendingRegistration.ok) {
    throw new Error(
      `Could not preserve extension quarantine during ${pendingRegistration.stage}: `
      + `${String(pendingRegistration.error)}`,
    )
  }

  await options.quarantine()

  try {
    await options.activate()
    await options.validate(pendingRegistration.validationCapability)
  } catch (registrationError) {
    const quarantined = await quarantineExtensionRegistrationFailure(
      options.extensionsDir,
      options.extensionId,
      log,
    )
    if (!quarantined.ok) {
      throw new Error(
        `Runtime registration failed, and Modly could not preserve quarantine `
        + `during ${quarantined.stage}: ${String(quarantined.error)}. `
        + `Original failure: ${String(registrationError)}`,
      )
    }
    try {
      await options.quarantine()
    } catch (runtimeQuarantineError) {
      throw new Error(
        `Runtime registration failed, and Modly preserved filesystem quarantine but `
        + `could not evict partially registered runtime state: `
        + `${String(runtimeQuarantineError)}. Original failure: ${String(registrationError)}`,
      )
    }
    throw registrationError
  }

  const cleaned = await cleanupValidatedExtensionBackups(
    options.extensionsDir,
    options.extensionId,
    log,
  )
  if (!cleaned.ok) {
    throw new Error(
      `Runtime registration succeeded, but Modly could not finish transaction cleanup `
      + `during ${cleaned.stage}: ${String(cleaned.error)}. `
      + `Restart Modly to retry the validated cleanup.`,
    )
  }
}

export async function validateExtensionDestinationRegistration(
  destinationDir: string,
  validate: () => Promise<void>,
  label: string,
  log: InstallRecoveryLogger = consoleLogger,
): Promise<void> {
  const removed = await rmWithRetry(join(destinationDir, EXT_INCOMPLETE_MARKER), label, log)
  if (!removed.ok) {
    throw new Error(
      `Could not clear ${EXT_INCOMPLETE_MARKER} before runtime registration: `
      + `${String(removed.error)}`,
    )
  }
  await validate()
}

export async function removeExtensionWithBackups(
  extensionsDir: string,
  extensionId: string,
  log: InstallRecoveryLogger = consoleLogger,
): Promise<ExtensionMutationResult> {
  let destinationLeaf = extensionId
  try {
    destinationLeaf = assertSafeExtensionId(extensionId)
  } catch {
    // Manual/corrupted folders may not conform to extension IDs. They still
    // remain uninstallable under the root-confinement rule, but can never own
    // a valid internal backup name.
  }

  // Resolve before mutating anything. Corrupted folder names are allowed, but
  // traversal outside extensionsDir is never allowed.
  const destinationDir = resolvePathWithinRoot(extensionsDir, destinationLeaf)
  const backups = await extensionBackupPaths(extensionsDir, destinationLeaf)
  if (!backups.ok) return backups

  const stateRemoved = await removeRegistrationState(extensionsDir, destinationLeaf, log)
  if (!stateRemoved.ok) return stateRemoved

  // Backups must go first. If destination deletion later fails, the visible
  // extension remains uninstallable on retry, but startup cannot resurrect it.
  for (const backupDir of backups.paths) {
    const removed = await rmWithRetry(backupDir, 'ext-uninstall', log)
    if (!removed.ok) return failedMutation('backup', removed)
  }

  const removed = await rmWithRetry(destinationDir, 'ext-uninstall', log)
  if (!removed.ok) return failedMutation('destination', removed)
  return { ok: true }
}

export async function cleanupValidatedExtensionBackups(
  extensionsDir: string,
  extensionId: string,
  log: InstallRecoveryLogger = consoleLogger,
): Promise<ExtensionMutationResult> {
  const backups = await extensionBackupPaths(extensionsDir, extensionId)
  if (!backups.ok) return backups

  // Commit registration outside the extension tree before deleting pending
  // state or rollback copies. Repository contents and linked source trees can
  // never forge or retain this transaction marker.
  const validatedPath = buildRegistrationStatePath(
    extensionsDir,
    extensionId,
    String(Date.now()),
    REGISTRATION_VALIDATED_PREFIX,
  )
  const marked = await writeMarkerWithRetry(validatedPath, 'ext-cleanup', log)
  if (!marked.ok) return failedMutation('marker', marked)

  for (const backupDir of backups.paths) {
    const removed = await rmWithRetry(backupDir, 'ext-cleanup', log)
    if (!removed.ok) return failedMutation('backup', removed)
  }

  return removeRegistrationState(extensionsDir, extensionId, log)
}

export async function reconcileInterruptedExtensionInstalls(
  extensionsDir: string,
  log: InstallRecoveryLogger = consoleLogger,
): Promise<void> {
  if (!existsSync(extensionsDir)) return

  const entries = await readdir(extensionsDir, { withFileTypes: true })
  const names = entries.map((entry) => entry.name)

  await Promise.all(
    names
      .filter((name) => name.startsWith(EXT_STAGING_PREFIX))
      .map((name) => rmWithRetry(join(extensionsDir, name), 'ext-cleanup', log)),
  )

  // Transaction markers live beside extension folders, never inside them.
  // This keeps validation markers invisible to Python discovery and prevents a
  // linked extension from writing recovery state into a developer source tree.
  const backups = names.filter((name) => name.startsWith(EXT_BACKUP_PREFIX)).sort().reverse()
  const extensionIdsWithBackups = new Set<string>()
  const backupsByExtension = new Map<string, string[]>()
  const pendingExtensionIds = new Set<string>()
  const validatedExtensionIds = new Set<string>()

  for (const name of backups) {
    const backupPath = join(extensionsDir, name)
    const parsed = parseExtensionBackupName(name)
    if (!parsed) {
      await rmWithRetry(backupPath, 'ext-cleanup', log)
      continue
    }
    extensionIdsWithBackups.add(parsed.extensionId)
    const extensionBackups = backupsByExtension.get(parsed.extensionId) ?? []
    extensionBackups.push(backupPath)
    backupsByExtension.set(parsed.extensionId, extensionBackups)
  }

  for (const [prefix, target] of [
    [REGISTRATION_PENDING_PREFIX, pendingExtensionIds],
    [REGISTRATION_VALIDATED_PREFIX, validatedExtensionIds],
  ] as const) {
    for (const name of names.filter((candidate) => candidate.startsWith(prefix))) {
      const parsed = parseRegistrationStateName(name, prefix)
      if (!parsed) {
        await rmWithRetry(join(extensionsDir, name), 'ext-cleanup', log)
        continue
      }
      target.add(parsed.extensionId)
    }
  }

  const transactionExtensionIds = new Set([
    ...backupsByExtension.keys(),
    ...pendingExtensionIds,
    ...validatedExtensionIds,
  ])

  for (const extensionId of transactionExtensionIds) {
    const extensionBackups = backupsByExtension.get(extensionId) ?? []
    const destDir = resolveExtensionPathWithinRoot(extensionsDir, extensionId)
    const destinationExists = existsSync(destDir)
    const destinationIncomplete = existsSync(join(destDir, EXT_INCOMPLETE_MARKER))
    const destinationPending = existsSync(join(destDir, EXT_REGISTRATION_PENDING_MARKER))

    // Destination commit markers are never trusted: they may have arrived in a
    // repository or persisted from an older implementation. Only root-level,
    // transaction-scoped validated state may authorize backup deletion.
    await rmWithRetry(join(destDir, EXT_VALIDATED_MARKER), 'ext-cleanup', log)

    if (validatedExtensionIds.has(extensionId) && destinationExists) {
      const cleaned = await cleanupValidatedExtensionBackups(extensionsDir, extensionId, log)
      if (!cleaned.ok) {
        log.warn(
          `[ext-cleanup] could not finish validated backup cleanup for "${extensionId}" `
          + `during ${cleaned.stage}: ${cleaned.error}`,
        )
      }
      continue
    }
    if (
      validatedExtensionIds.has(extensionId)
      && !destinationExists
      && extensionBackups.length === 0
    ) {
      await removeRegistrationState(extensionsDir, extensionId, log)
      continue
    }

    if (pendingExtensionIds.has(extensionId)) {
      if (extensionBackups.length > 0) {
        const backupPath = extensionBackups[0]
        const restored = await restoreExtensionBackup(destDir, backupPath, log)
        if (restored.ok) {
          await removeRegistrationState(extensionsDir, extensionId, log)
          log.info(`[ext-restore] restored "${extensionId}" from ${backupPath}`)
        }
      } else if (destinationIncomplete) {
        const removed = await rmWithRetry(destDir, 'ext-cleanup', log)
        if (removed.ok) await removeRegistrationState(extensionsDir, extensionId, log)
      } else if (destinationExists) {
        // Leave the root-level pending state in place. Discovery and the
        // Extensions UI both honor it without writing into a possibly linked
        // destination tree.
        continue
      } else {
        await removeRegistrationState(extensionsDir, extensionId, log)
      }
      continue
    }

    const destinationInterrupted = (
      destinationIncomplete
      || destinationPending
    )
    const action = incompleteInstallRecoveryAction({
      destinationExists,
      destinationIncomplete: destinationInterrupted,
      backupExists: extensionBackups.length > 0,
    })
    if (action === 'restore-backup') {
      const backupPath = extensionBackups[0]
      const restored = await restoreExtensionBackup(destDir, backupPath, log)
      if (restored.ok) {
        if (validatedExtensionIds.has(extensionId)) {
          await removeRegistrationState(extensionsDir, extensionId, log)
        }
        log.info(`[ext-restore] restored "${extensionId}" from ${backupPath}`)
      }
      continue
    }

    // Complete destination + unmarked backup: preserve the rollback copy. Its
    // registration state is unknown, so deleting or restoring would both be
    // destructive guesses.
  }

  // A fresh install has no backup. If it died while marked incomplete, there
  // is no valid extension to load or restore, so remove only that orphan.
  for (const name of names) {
    if (isInternalExtensionDirName(name) || extensionIdsWithBackups.has(name)) continue
    // Corrupted/manual folders may not satisfy the extension-id pattern. They
    // are still safe to reconcile when their literal directory entry remains
    // confined to extensionsDir (same rule used by uninstall).
    const destDir = resolvePathWithinRoot(extensionsDir, name)
    const destinationExists = existsSync(destDir)
    const destinationIncomplete = existsSync(join(destDir, EXT_INCOMPLETE_MARKER))
    const destinationRegistrationPending = existsSync(
      join(destDir, EXT_REGISTRATION_PENDING_MARKER),
    )
    const action = incompleteInstallRecoveryAction({
      destinationExists,
      destinationIncomplete,
      backupExists: false,
    })
    if (action === 'remove-incomplete') {
      await rmWithRetry(destDir, 'ext-cleanup', log)
      continue
    }

    // A pending destination without a rollback copy cannot be proven valid or
    // safely discarded. Leave it quarantined for Models → Repair; both the
    // Electron list and Python registry honor this marker.
    if (destinationRegistrationPending) continue

    const staleValidatedMarker = join(destDir, EXT_VALIDATED_MARKER)
    if (existsSync(staleValidatedMarker)) {
      await rmWithRetry(staleValidatedMarker, 'ext-cleanup', log)
    }
  }
}

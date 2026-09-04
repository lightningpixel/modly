import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Windows refuses symlink creation unless the process is elevated or Developer
// Mode is on, so probe once rather than letting the test report an EPERM as a
// product failure — that turns a stock Windows checkout into a failing suite.
const symlinksAvailable = (() => {
  const probe = mkdtempSync(join(tmpdir(), 'modly-symlink-probe-'))
  try {
    symlinkSync(join(probe, 'target'), join(probe, 'link'), 'dir')
    return true
  } catch {
    return false
  } finally {
    rmSync(probe, { recursive: true, force: true })
  }
})()

function loadModule() {
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-recovery-module-')), 'extension-install-recovery.cjs')
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve('electron/main/extension-install-recovery.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return require(outfile)
}

test('startup reconciliation removes all orphan incomplete folders, including corrupted names', async () => {
  const root = mkdtempSync(join(tmpdir(), 'modly-recovery-test-'))
  const corrupted = join(root, 'Broken Extension')
  const valid = join(root, 'later-extension')
  mkdirSync(corrupted)
  mkdirSync(valid)
  writeFileSync(join(corrupted, '.modly-incomplete'), 'installing', 'utf8')
  writeFileSync(join(valid, '.modly-incomplete'), 'installing', 'utf8')

  try {
    const mod = loadModule()
    await mod.reconcileInterruptedExtensionInstalls(root)

    assert.equal(existsSync(corrupted), false)
    assert.equal(existsSync(valid), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('failed update rollback replaces the unvalidated destination with its backup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'modly-rollback-test-'))
  const destination = join(root, 'pixal3d')
  const backup = join(root, '.modly-backup-pixal3d-100')
  mkdirSync(destination)
  mkdirSync(backup)
  writeFileSync(join(destination, 'version.txt'), 'new-broken', 'utf8')
  writeFileSync(join(destination, '.modly-registration-pending'), 'pending', 'utf8')
  writeFileSync(join(backup, 'version.txt'), 'old-working', 'utf8')

  try {
    const mod = loadModule()
    const result = await mod.restoreExtensionBackup(destination, backup)

    assert.deepEqual(result, { ok: true })
    assert.equal(readFileSync(join(destination, 'version.txt'), 'utf8'), 'old-working')
    assert.equal(existsSync(join(destination, '.modly-registration-pending')), false)
    assert.equal(existsSync(backup), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('startup restores a parked version when registration was interrupted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'modly-pending-recovery-test-'))
  const destination = join(root, 'pixal3d')
  const backup = join(root, '.modly-backup-pixal3d-101')
  mkdirSync(destination)
  mkdirSync(backup)
  writeFileSync(join(destination, 'version.txt'), 'new-unvalidated', 'utf8')
  writeFileSync(join(backup, 'version.txt'), 'old-working', 'utf8')
  writeFileSync(join(root, '.modly-registration-pending-pixal3d-101'), 'pending', 'utf8')

  try {
    const mod = loadModule()
    await mod.reconcileInterruptedExtensionInstalls(root)

    assert.equal(readFileSync(join(destination, 'version.txt'), 'utf8'), 'old-working')
    assert.equal(existsSync(backup), false)
    assert.equal(
      existsSync(join(root, '.modly-registration-pending-pixal3d-101')),
      false,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('update validation keeps pending state hidden from the destination until commit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'modly-update-validation-test-'))
  const destination = join(root, 'pixal3d')
  const backup = join(root, '.modly-backup-pixal3d-104')
  mkdirSync(destination)
  mkdirSync(backup)
  writeFileSync(join(destination, '.modly-incomplete'), 'setup', 'utf8')

  try {
    const mod = loadModule()
    const transaction = await mod.beginExtensionRegistrationTransaction(
      root,
      'pixal3d',
      '104',
    )
    assert.equal(transaction.ok, true)
    assert.equal(transaction.validationCapability.extensionId, 'pixal3d')
    assert.equal(transaction.validationCapability.destinationName, 'pixal3d')
    assert.equal(
      transaction.validationCapability.stateName,
      '.modly-registration-pending-pixal3d-104',
    )
    assert.ok(transaction.validationCapability.token.length >= 32)
    const capabilityStat = statSync(
      join(root, '.modly-registration-pending-pixal3d-104'),
    )
    assert.equal(capabilityStat.nlink, 1)
    if (process.platform !== 'win32') {
      assert.equal(capabilityStat.mode & 0o077, 0)
    }

    let validatorCalled = false
    await mod.validateExtensionDestinationRegistration(
      destination,
      async () => {
        validatorCalled = true
        assert.equal(existsSync(join(destination, '.modly-incomplete')), false)
        assert.equal(existsSync(join(destination, '.modly-registration-pending')), false)
        assert.equal(existsSync(join(backup, '.modly-registration-pending')), false)
        assert.equal(
          existsSync(join(root, '.modly-registration-pending-pixal3d-104')),
          true,
        )
      },
      'test-update',
    )

    assert.equal(validatorCalled, true)
    assert.deepEqual(
      await mod.cleanupValidatedExtensionBackups(root, 'pixal3d'),
      { ok: true },
    )
    assert.equal(existsSync(backup), false)
    assert.equal(existsSync(join(destination, '.modly-registration-validated')), false)
    assert.equal(
      existsSync(join(root, '.modly-registration-pending-pixal3d-104')),
      false,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Repair transaction starts before setup and keeps state outside the destination', async () => {
  const root = mkdtempSync(join(tmpdir(), 'modly-repair-validation-test-'))
  const destination = join(root, 'pixal3d')
  const backup = join(root, '.modly-backup-pixal3d-105')
  mkdirSync(destination)
  mkdirSync(backup)

  try {
    const mod = loadModule()
    const order = []
    let runtimeLoaded = true
    let setupCalled = false
    let validatorCalled = false
    await mod.runExtensionRepairTransaction({
      extensionsDir: root,
      extensionId: 'pixal3d',
      destinationDir: destination,
      suffix: '105',
      quarantine: async () => {
        order.push('quarantine')
        assert.equal(
          existsSync(join(root, '.modly-registration-pending-pixal3d-105')),
          true,
        )
        runtimeLoaded = false
      },
      setup: async () => {
        order.push('setup')
        setupCalled = true
        assert.equal(runtimeLoaded, false)
        assert.equal(
          existsSync(join(root, '.modly-registration-pending-pixal3d-105')),
          true,
        )
        assert.equal(existsSync(join(destination, '.modly-registration-pending')), false)
        assert.equal(existsSync(join(backup, '.modly-registration-pending')), false)
      },
      validate: async (validationCapability) => {
        order.push('validate')
        validatorCalled = true
        assert.equal(validationCapability.extensionId, 'pixal3d')
        assert.equal(
          validationCapability.stateName,
          '.modly-registration-pending-pixal3d-105',
        )
        assert.equal(
          existsSync(join(root, '.modly-registration-pending-pixal3d-105')),
          true,
        )
      },
    })

    assert.equal(setupCalled, true)
    assert.equal(validatorCalled, true)
    assert.deepEqual(order, ['quarantine', 'setup', 'validate'])
    assert.equal(
      existsSync(join(root, '.modly-registration-pending-pixal3d-105')),
      false,
    )
    assert.equal(existsSync(backup), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Repair setup failure retains pending quarantine and never validates runtime', async () => {
  const root = mkdtempSync(join(tmpdir(), 'modly-repair-setup-failure-test-'))
  const destination = join(root, 'pixal3d')
  mkdirSync(destination)

  try {
    const mod = loadModule()
    let runtimeLoaded = true
    let validatorCalled = false

    await assert.rejects(
      mod.runExtensionRepairTransaction({
        extensionsDir: root,
        extensionId: 'pixal3d',
        destinationDir: destination,
        suffix: '109',
        quarantine: async () => {
          assert.equal(
            existsSync(join(root, '.modly-registration-pending-pixal3d-109')),
            true,
          )
          runtimeLoaded = false
        },
        setup: async () => {
          assert.equal(runtimeLoaded, false)
          assert.equal(
            existsSync(join(root, '.modly-registration-pending-pixal3d-109')),
            true,
          )
          throw new Error('setup exploded')
        },
        validate: async () => {
          validatorCalled = true
        },
      }),
      /setup exploded/,
    )

    assert.equal(validatorCalled, false)
    assert.equal(runtimeLoaded, false)
    assert.equal(
      existsSync(join(root, '.modly-registration-pending-pixal3d-109')),
      true,
    )
    assert.equal(existsSync(join(destination, '.modly-registration-pending')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Repair validation failure re-evicts partially registered runtime state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'modly-repair-validation-failure-test-'))
  const destination = join(root, 'pixal3d')
  mkdirSync(destination)

  try {
    const mod = loadModule()
    let runtimeLoaded = true
    let quarantineCount = 0

    await assert.rejects(
      mod.runExtensionRepairTransaction({
        extensionsDir: root,
        extensionId: 'pixal3d',
        destinationDir: destination,
        suffix: '113',
        quarantine: async () => {
          quarantineCount += 1
          runtimeLoaded = false
        },
        setup: async () => {
          assert.equal(runtimeLoaded, false)
        },
        validate: async () => {
          runtimeLoaded = true
          throw new Error('one node failed registration')
        },
      }),
      /one node failed registration/,
    )

    assert.equal(quarantineCount, 2)
    assert.equal(runtimeLoaded, false)
    assert.equal(
      existsSync(join(root, '.modly-registration-pending-pixal3d-113')),
      true,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fresh-install crash keeps a complete destination externally quarantined', async () => {
  const root = mkdtempSync(join(tmpdir(), 'modly-fresh-crash-test-'))
  const destination = join(root, 'pixal3d')
  mkdirSync(destination)
  writeFileSync(join(destination, 'version.txt'), 'unvalidated', 'utf8')

  try {
    const mod = loadModule()
    const transaction = await mod.beginExtensionRegistrationTransaction(
      root,
      'pixal3d',
      '106',
    )
    assert.equal(transaction.ok, true)

    await mod.reconcileInterruptedExtensionInstalls(root)

    assert.equal(readFileSync(join(destination, 'version.txt'), 'utf8'), 'unvalidated')
    assert.equal(
      existsSync(join(root, '.modly-registration-pending-pixal3d-106')),
      true,
    )
    assert.equal(existsSync(join(destination, '.modly-registration-pending')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('new registration capability replaces older pending attempts without a quarantine gap', async () => {
  const root = mkdtempSync(join(tmpdir(), 'modly-capability-rotation-test-'))
  const destination = join(root, 'pixal3d')
  mkdirSync(destination)

  try {
    const mod = loadModule()
    const first = await mod.beginExtensionRegistrationTransaction(
      root,
      'pixal3d',
      '111',
    )
    const second = await mod.beginExtensionRegistrationTransaction(
      root,
      'pixal3d',
      '112',
    )

    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    assert.notEqual(
      first.validationCapability.token,
      second.validationCapability.token,
    )
    assert.equal(
      existsSync(join(root, '.modly-registration-pending-pixal3d-111')),
      false,
    )
    assert.equal(
      existsSync(join(root, '.modly-registration-pending-pixal3d-112')),
      true,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('registration capability creation never overwrites a pre-existing sidecar', async () => {
  const root = mkdtempSync(join(tmpdir(), 'modly-capability-exclusive-test-'))
  const statePath = join(root, '.modly-registration-pending-pixal3d-114')
  writeFileSync(statePath, 'pre-existing', 'utf8')
  if (process.platform !== 'win32') chmodSync(statePath, 0o644)

  try {
    const mod = loadModule()
    const result = await mod.beginExtensionRegistrationTransaction(
      root,
      'pixal3d',
      '114',
    )

    assert.equal(result.ok, false)
    assert.equal(readFileSync(statePath, 'utf8'), 'pre-existing')
    if (process.platform !== 'win32') {
      assert.equal(statSync(statePath).mode & 0o777, 0o644)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('registration capability creation rejects a hard-linked target', async () => {
  const root = mkdtempSync(join(tmpdir(), 'modly-capability-hardlink-test-'))
  const original = join(root, 'original')
  const statePath = join(root, '.modly-registration-pending-pixal3d-115')
  writeFileSync(original, 'pre-existing', 'utf8')
  linkSync(original, statePath)

  try {
    const mod = loadModule()
    const result = await mod.beginExtensionRegistrationTransaction(
      root,
      'pixal3d',
      '115',
    )

    assert.equal(result.ok, false)
    assert.equal(readFileSync(original, 'utf8'), 'pre-existing')
    assert.equal(statSync(original).nlink, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('no-backup Repair failure preserves external quarantine state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'modly-repair-failure-test-'))
  const destination = join(root, 'pixal3d')
  mkdirSync(destination)

  try {
    const mod = loadModule()
    assert.deepEqual(
      await mod.quarantineExtensionRegistrationFailure(root, 'pixal3d'),
      { ok: true },
    )

    const pendingNames = readdirSync(root).filter((name) =>
      name.startsWith('.modly-registration-pending-pixal3d-'),
    )
    assert.equal(pendingNames.length, 1)
    assert.equal(existsSync(join(destination, '.modly-registration-pending')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('failed local registration validation persists quarantine for restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'modly-local-validation-test-'))
  const destination = join(root, 'pixal3d')
  mkdirSync(destination)

  try {
    const mod = loadModule()
    let receivedCapability = null
    let runtimeLoaded = true
    let quarantineCount = 0

    await assert.rejects(
      mod.runExtensionRegistrationValidationTransaction({
        extensionsDir: root,
        extensionId: 'pixal3d',
        suffix: '110',
        quarantine: async () => {
          quarantineCount += 1
          assert.equal(
            existsSync(join(root, '.modly-registration-pending-pixal3d-110')),
            true,
          )
          runtimeLoaded = false
        },
        activate: async () => {
          assert.equal(runtimeLoaded, false)
          assert.equal(
            existsSync(join(root, '.modly-registration-pending-pixal3d-110')),
            true,
          )
        },
        validate: async (validationCapability) => {
          assert.equal(runtimeLoaded, false)
          receivedCapability = validationCapability
          runtimeLoaded = true
          throw new Error('venv not found')
        },
      }),
      /venv not found/,
    )

    assert.equal(receivedCapability.extensionId, 'pixal3d')
    assert.equal(runtimeLoaded, false)
    assert.equal(quarantineCount, 2)
    assert.equal(
      receivedCapability.stateName,
      '.modly-registration-pending-pixal3d-110',
    )
    assert.equal(
      existsSync(join(root, '.modly-registration-pending-pixal3d-110')),
      true,
    )

    await mod.reconcileInterruptedExtensionInstalls(root)
    assert.equal(existsSync(destination), true)
    assert.equal(
      existsSync(join(root, '.modly-registration-pending-pixal3d-110')),
      true,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('local link transaction creates quarantine before any destination mutation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'modly-local-ordering-test-'))

  try {
    const mod = loadModule()
    const order = []
    let validatorCalled = false

    await assert.rejects(
      mod.runExtensionRegistrationValidationTransaction({
        extensionsDir: root,
        extensionId: 'pixal3d',
        suffix: '116',
        quarantine: async () => {
          order.push('quarantine')
        },
        activate: async () => {
          assert.equal(
            existsSync(join(root, '.modly-registration-pending-pixal3d-116')),
            true,
          )
          order.push('mutate-link')
          throw new Error('simulated crash during link replacement')
        },
        validate: async () => {
          validatorCalled = true
        },
      }),
      /simulated crash during link replacement/,
    )

    assert.deepEqual(order, ['quarantine', 'mutate-link', 'quarantine'])
    assert.equal(validatorCalled, false)
    assert.equal(
      existsSync(join(root, '.modly-registration-pending-pixal3d-116')),
      true,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('uninstall removes backups before the destination so restart cannot resurrect it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'modly-uninstall-recovery-test-'))
  const destination = join(root, 'pixal3d')
  const backup = join(root, '.modly-backup-pixal3d-102')
  mkdirSync(destination)
  mkdirSync(backup)
  writeFileSync(join(destination, 'version.txt'), 'current', 'utf8')
  writeFileSync(join(backup, 'version.txt'), 'previous', 'utf8')
  writeFileSync(join(root, '.modly-registration-pending-pixal3d-102'), 'pending', 'utf8')

  try {
    const mod = loadModule()
    const result = await mod.removeExtensionWithBackups(root, 'pixal3d')

    assert.deepEqual(result, { ok: true })
    assert.equal(existsSync(destination), false)
    assert.equal(existsSync(backup), false)
    assert.equal(
      existsSync(join(root, '.modly-registration-pending-pixal3d-102')),
      false,
    )

    await mod.reconcileInterruptedExtensionInstalls(root)
    assert.equal(existsSync(destination), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('startup completes validated backup cleanup without replacing the destination', async () => {
  const root = mkdtempSync(join(tmpdir(), 'modly-validated-cleanup-test-'))
  const destination = join(root, 'pixal3d')
  const backup = join(root, '.modly-backup-pixal3d-103')
  mkdirSync(destination)
  mkdirSync(backup)
  writeFileSync(join(destination, 'version.txt'), 'new-working', 'utf8')
  writeFileSync(join(backup, 'version.txt'), 'old-working', 'utf8')
  writeFileSync(join(root, '.modly-registration-pending-pixal3d-103'), 'pending', 'utf8')
  writeFileSync(join(root, '.modly-registration-validated-pixal3d-104'), 'validated', 'utf8')

  try {
    const mod = loadModule()
    await mod.reconcileInterruptedExtensionInstalls(root)

    assert.equal(readFileSync(join(destination, 'version.txt'), 'utf8'), 'new-working')
    assert.equal(existsSync(backup), false)
    assert.equal(existsSync(join(destination, '.modly-registration-validated')), false)
    assert.equal(
      readdirSync(root).some((name) => name.startsWith('.modly-registration-')),
      false,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('destination validated marker cannot authorize deletion of an uncommitted backup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'modly-forged-validated-test-'))
  const destination = join(root, 'pixal3d')
  const backup = join(root, '.modly-backup-pixal3d-107')
  mkdirSync(destination)
  mkdirSync(backup)
  writeFileSync(join(destination, 'version.txt'), 'unvalidated', 'utf8')
  writeFileSync(join(destination, '.modly-registration-validated'), 'packaged', 'utf8')
  writeFileSync(join(backup, 'version.txt'), 'old-working', 'utf8')

  try {
    const mod = loadModule()
    await mod.reconcileInterruptedExtensionInstalls(root)

    assert.equal(readFileSync(join(destination, 'version.txt'), 'utf8'), 'unvalidated')
    assert.equal(readFileSync(join(backup, 'version.txt'), 'utf8'), 'old-working')
    assert.equal(existsSync(join(destination, '.modly-registration-validated')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('registration transaction state never writes through a symlinked backup', {
  skip: symlinksAvailable
    ? false
    : 'symlink creation needs elevation or Developer Mode on this platform',
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'modly-symlink-state-test-'))
  const source = mkdtempSync(join(tmpdir(), 'modly-linked-source-'))
  const destination = join(root, 'pixal3d')
  const backup = join(root, '.modly-backup-pixal3d-108')
  mkdirSync(destination)
  symlinkSync(source, backup, 'dir')

  try {
    const mod = loadModule()
    const transaction = await mod.beginExtensionRegistrationTransaction(
      root,
      'pixal3d',
      '108',
    )
    assert.equal(transaction.ok, true)

    assert.equal(existsSync(join(source, '.modly-registration-pending')), false)
    assert.equal(
      existsSync(join(root, '.modly-registration-pending-pixal3d-108')),
      true,
    )

    assert.deepEqual(
      await mod.cleanupValidatedExtensionBackups(root, 'pixal3d'),
      { ok: true },
    )
    assert.equal(existsSync(source), true)
    assert.equal(existsSync(join(source, '.modly-registration-pending')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(source, { recursive: true, force: true })
  }
})

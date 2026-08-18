import { safeStorage } from 'electron'
import { logger } from './logger'

// Secrets that safeStorage couldn't encrypt (no OS keychain available, e.g. some
// Linux setups without a keyring) are stored with this prefix so decryptSecret
// can tell them apart from a real ciphertext and hand them back unchanged.
const PLAINTEXT_PREFIX = 'plain:'

let warnedOnce = false

// Electron 33 (pinned in package.json) only ships the synchronous safeStorage
// API — encryptStringAsync/decryptStringAsync/isAsyncEncryptionAvailable were
// added in a later Electron release. The sync calls are cheap (no disk I/O,
// just OS keychain/DPAPI crypto), so wrapping them in an async function here
// is only to keep the IPC handler signature uniform, not for a real await.

export function encryptSecretSync(plainText: string): string {
  if (!plainText) return plainText

  if (!safeStorage.isEncryptionAvailable()) {
    if (!warnedOnce) {
      warnedOnce = true
      logger.warn('[secure-store] OS-level encryption unavailable — storing secrets in plain text')
    }
    return PLAINTEXT_PREFIX + plainText
  }

  return safeStorage.encryptString(plainText).toString('hex')
}

/**
 * True when `stored` has the shape encryptSecretSync produces (an even-length
 * hex blob). Used to tell "this was never encrypted" apart from "this IS one of
 * our blobs but decryption just failed" — the two must not be confused: DPAPI
 * keys are per-OS-user, so a restored backup or a different Windows account
 * makes decryption fail on a perfectly valid ciphertext. Treating that as
 * plaintext would hand the ciphertext out as a credential and then re-encrypt
 * it, destroying the secret for good.
 */
function looksEncrypted(stored: string): boolean {
  return stored.length >= 32 && stored.length % 2 === 0 && /^[0-9a-f]+$/i.test(stored)
}

/**
 * Returns the plaintext, or `null` when `stored` is one of our blobs that could
 * not be decrypted. A value that was never encrypted comes back unchanged, so
 * callers can migrate it.
 */
export function decryptSecretSync(stored: string): string | null {
  if (!stored) return stored
  if (stored.startsWith(PLAINTEXT_PREFIX)) return stored.slice(PLAINTEXT_PREFIX.length)

  if (!looksEncrypted(stored)) return stored   // legacy plaintext, saved before encryption existed

  try {
    return safeStorage.decryptString(Buffer.from(stored, 'hex'))
  } catch (err) {
    logger.error(
      '[secure-store] a stored secret could not be decrypted — it was encrypted by a ' +
      `different OS user or machine. It must be re-entered. (${err})`,
    )
    return null
  }
}

// Async wrappers kept for the IPC handlers, whose signatures are all async.
export async function encryptSecret(plainText: string): Promise<string> {
  return encryptSecretSync(plainText)
}

/** `null` on an undecryptable blob — never the ciphertext, which callers would
 *  otherwise use as a credential and re-encrypt. */
export async function decryptSecret(stored: string): Promise<string | null> {
  return decryptSecretSync(stored)
}

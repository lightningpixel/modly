import { getSettings, setSettings } from './settings-store'
import { encryptSecretSync, decryptSecretSync } from './secure-store'
import { logger } from './logger'

/**
 * Hugging Face token, encrypted at rest in settings.json the same way the
 * provider API keys are (see secure-store.ts). It used to sit there in plain
 * text while every other secret in the app was encrypted.
 *
 * The plaintext lives only in this module's cache: `getHfToken()` is sync
 * because the callers that need it are sync (child-process env building), while
 * encrypt/decrypt are async.
 */
let cached = ''

export function getHfToken(): string {
  return cached
}

/**
 * Decrypt the stored token into the cache, re-encrypting a legacy plaintext one.
 * Synchronous on purpose: the FastAPI bridge reads the token while building its
 * child-process env at startup, so an async init could lose a race with it.
 */
export function initHfToken(userData: string): string {
  const stored = getSettings(userData).hfToken ?? ''
  if (!stored) {
    cached = ''
    return cached
  }

  const decrypted = decryptSecretSync(stored)
  if (decrypted === null) {
    // One of our blobs, but not decryptable here (different OS user/machine).
    // Leave settings.json alone — rewriting would turn an unreadable-but-intact
    // blob into a permanently lost one — and expose no token rather than
    // handing the ciphertext out as a credential.
    cached = ''
    logger.error('[hf-token] the stored Hugging Face token could not be decrypted — re-enter it in Settings → Integrations')
    return cached
  }

  cached = decrypted
  // An unchanged value means it was never encrypted (saved before encryption
  // existed) — upgrade it in place.
  if (cached === stored) {
    try {
      setSettings(userData, { hfToken: encryptSecretSync(cached) })
      logger.info('[hf-token] migrated a plaintext token to encrypted storage')
    } catch (err) {
      logger.error(`[hf-token] could not migrate the stored token: ${err}`)
    }
  }
  return cached
}

/** Persist the token encrypted and refresh the cache. */
export function setHfToken(userData: string, token: string): void {
  cached = token
  setSettings(userData, { hfToken: token ? encryptSecretSync(token) : '' })
}

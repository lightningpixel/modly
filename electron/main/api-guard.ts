// Lets the backend tell the Modly window apart from web pages.
//
// The backend refuses requests from web pages (see api/services/api_guard.py)
// and lets every other caller in. A packaged build loads its pages from files,
// whose requests carry `Origin: null`, which any site can send too from a
// sandboxed iframe. So the window's requests to the API get X-Modly-App with a
// secret made at each launch, which only the backend receives (by env).
//
// The secret lives in this module only. It must never be put on process.env:
// child processes (Python setup, extension runners) inherit a copy of it.

import { randomBytes } from 'crypto'

export const APP_HEADER = 'X-Modly-App'

let secret: string | null = null

/** This launch's secret, made on first use: 32 random bytes as hex. */
export function getAppSecret(): string {
  secret ??= randomBytes(32).toString('hex')
  return secret
}

/**
 * The renderer's own web origin, for the backend's MODLY_APP_ORIGINS: the Vite
 * dev server in dev (its port may move off 5173), none in production (files).
 */
export function appOrigins(rendererUrl?: string): string[] {
  if (!rendererUrl) return []
  try {
    const { origin } = new URL(rendererUrl)
    return origin && origin !== 'null' ? [origin] : []
  } catch {
    return []
  }
}

/**
 * Whether the app window may navigate to `url`: only its own pages (the Vite
 * dev server in dev, file:// in production). Any other page would get the
 * secret from the request hook, so it opens in the system browser instead.
 */
export function isAppNavigation(url: string, rendererUrl?: string): boolean {
  try {
    const target = new URL(url)
    if (target.protocol === 'file:') return !rendererUrl
    if (!rendererUrl) return false
    return target.origin === new URL(rendererUrl).origin
  } catch {
    return false
  }
}

const API_HOSTS = new Set(['127.0.0.1', 'localhost'])

/** Whether `url` targets the backend listening on `port` (and so gets the secret). */
export function isApiRequest(url: string, port: number): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' && API_HOSTS.has(u.hostname) && u.port === String(port)
  } catch {
    return false
  }
}

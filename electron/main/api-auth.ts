// Locks the local FastAPI backend to the Modly app.
//
// The backend listens on 127.0.0.1, which every web page in the user's browser
// can reach too. A secret made fresh at each launch proves a request comes from
// Modly: the backend gets it through its environment, the app sends it in a
// header, and tools outside the app (MCP server, modly-cli) read it from
// <userData>/api-token next to the api-port file.
//
// The token lives in this module only. It must never be put on process.env:
// child processes (Python setup, extension runners) inherit a copy of it.

import { randomBytes } from 'crypto'
import { chmodSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import axios from 'axios'

export const API_TOKEN_HEADER = 'X-Modly-Token'
export const TOKEN_FILE = 'api-token'

/** 32 random bytes as 64 hex characters. */
export function generateApiToken(): string {
  return randomBytes(32).toString('hex')
}

let token: string | null = null

/** This launch's token, made on first use. */
export function getApiToken(): string {
  token ??= generateApiToken()
  return token
}

export function apiAuthHeaders(): Record<string, string> {
  return { [API_TOKEN_HEADER]: getApiToken() }
}

/**
 * Axios for main-process calls to the backend: adds the token header. Use plain
 * axios for anything else (GitHub, Hugging Face) so the token never leaves.
 */
export const apiClient = axios.create()
apiClient.interceptors.request.use((config) => {
  config.headers.set(API_TOKEN_HEADER, getApiToken())
  return config
})

/**
 * Origins the backend accepts in CORS. Production pages are loaded with
 * loadFile, and Chromium sends either "file://" or "null" as their origin; in
 * dev the renderer is served by Vite, whose port may move off 5173.
 */
export function allowedOrigins(rendererUrl?: string): string[] {
  const origins: string[] = []
  if (rendererUrl) {
    try {
      const { origin } = new URL(rendererUrl)
      if (origin && origin !== 'null') origins.push(origin)
    } catch { /* not a URL: nothing to allow */ }
  }
  origins.push('file://', 'null')
  return origins
}

/**
 * Whether the app window may navigate to `url`: only its own pages (the Vite
 * dev server in dev, file:// in production). Any other page would receive the
 * API token from the request hook, so it opens in the system browser instead.
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

/** Whether `url` targets the backend listening on `port` (and so gets the token). */
export function isApiRequest(url: string, port: number): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' && API_HOSTS.has(u.hostname) && u.port === String(port)
  } catch {
    return false
  }
}

/**
 * Writes <dir>/api-token, readable by the user only where the OS supports it.
 * Removed first so a leftover file with wider permissions is not reused.
 */
export function writeTokenFile(dir: string, value: string): void {
  const file = join(dir, TOKEN_FILE)
  try {
    rmSync(file, { force: true })
    writeFileSync(file, value, { mode: 0o600 })
    chmodSync(file, 0o600)
  } catch { /* best effort, like the port file */ }
}

export function removeTokenFile(dir: string): void {
  try { rmSync(join(dir, TOKEN_FILE), { force: true }) } catch { /* best effort */ }
}

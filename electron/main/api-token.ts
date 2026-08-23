/**
 * Shared secret for the local API.
 *
 * The FastAPI backend listens on loopback with no authentication and answers
 * with `Access-Control-Allow-Origin: *`. Loopback is not a boundary against a
 * browser: any page the user has open can POST to 127.0.0.1:8765 and drive the
 * app — read the agent's memory, run workflows, or repoint the workspace with
 * `POST /settings/paths` and read files through it.
 *
 * So every request has to carry a secret the page cannot obtain. It is a random
 * token generated per launch:
 *   - the renderer gets it injected into its requests by the main process
 *     (see attachApiToken), so no call site has to know about it;
 *   - other local processes of the same user — the MCP server, the CLI, an
 *     extension calling back into /llm/chat — read it from MODLY_API_TOKEN or
 *     from the token file.
 *
 * It is deliberately not a defence against local code: anything running as the
 * user can read the file. The attacker being locked out here is the web page.
 */
import { randomBytes } from 'crypto'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export const API_TOKEN_HEADER = 'x-modly-token'

let token: string | null = null

export function getApiToken(): string {
  if (token === null) token = randomBytes(32).toString('hex')
  return token
}

export function apiTokenFilePath(): string {
  return join(homedir(), '.modly', 'api-token')
}

/**
 * Publish the token for the other local processes that talk to the API.
 * Best-effort: a home directory that cannot be written must not stop the app
 * from starting — the renderer works off the in-memory token either way.
 */
export function writeApiTokenFile(): void {
  try {
    const path = apiTokenFilePath()
    mkdirSync(join(homedir(), '.modly'), { recursive: true })
    writeFileSync(path, getApiToken(), { encoding: 'utf-8', mode: 0o600 })
    // mode on writeFileSync only applies when the file is created; a token file
    // left over from a previous launch keeps its old permissions otherwise.
    try { chmodSync(path, 0o600) } catch { /* no-op on Windows */ }
  } catch { /* token stays in-process only */ }
}

export function removeApiTokenFile(): void {
  try { rmSync(apiTokenFilePath(), { force: true }) } catch { /* nothing to clean up */ }
}

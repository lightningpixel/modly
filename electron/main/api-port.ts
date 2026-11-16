// Picks the port the FastAPI backend listens on, and finds who holds a port.
//
// The backend prefers 8765. If that port belongs to an old Modly backend (an
// orphan from a crash), it is stopped and reused; if another program holds it
// (Docker, another app), the backend moves to the next free port.

import { execFileSync } from 'child_process'
import { get as httpGet } from 'http'
import { connect, createServer } from 'net'
import { rmSync, writeFileSync } from 'fs'
import { join } from 'path'

export const DEFAULT_API_PORT = 8765
const FALLBACK_PORTS = 20 // 8766 … 8785, then any port the OS gives
export const PORT_FILE = 'api-port'

/** Ports to try, in order: the preferred one, the default, then the next ones. */
export function candidatePorts(preferred: number, count = FALLBACK_PORTS): number[] {
  const ports = [preferred, DEFAULT_API_PORT]
  for (let i = 1; i <= count; i++) ports.push(DEFAULT_API_PORT + i)
  return [...new Set(ports)]
}

/**
 * True when nothing answers on host:port and we can bind it. Both checks are
 * needed: on Windows a bind on 127.0.0.1 can succeed while Docker holds
 * 0.0.0.0 on the same port, and uvicorn would then lose to it.
 */
export async function isPortFree(host: string, port: number): Promise<boolean> {
  if (await answers(host, port)) return false
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolve(true)))
  })
}

function answers(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const done = (ok: boolean) => { socket.destroy(); resolve(ok) }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/** A port the OS reports free right now. */
export function osAssignedPort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen({ host, port: 0 }, () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

/** Whether the server on host:port is a Modly backend (this or an older version). */
export function isModlyBackend(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    // http.get rather than fetch: on timeout the socket is destroyed, not left
    // open on a program that never answers.
    const req = httpGet({ host, port, path: '/health', agent: false, timeout: timeoutMs }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { if (body.length < 4096) body += chunk })
      res.on('end', () => {
        try { resolve(res.statusCode === 200 && looksLikeModlyHealth(JSON.parse(body))) } catch { resolve(false) }
      })
      res.on('error', () => resolve(false))
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(false))
  })
}

// Current backends say {"status": "ok", "service": "modly"}; older ones only
// {"status": "ok"}, so that exact body is accepted too.
export function looksLikeModlyHealth(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false
  const b = body as Record<string, unknown>
  if (b.status !== 'ok') return false
  if (b.service === 'modly') return true
  return Object.keys(b).length === 1
}

/** PID of the process listening on `port`, or null. */
export function findListenerPid(port: number): string | null {
  try {
    if (process.platform === 'win32') {
      return parseNetstatListener(execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' }), port)
    }
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], { encoding: 'utf8' })
    return out.match(/^p(\d+)/m)?.[1] ?? null
  } catch {
    return null
  }
}

/** Names the process listening on `port`, e.g. "wslrelay.exe (PID 4321)". */
export function findPortHolder(port: number): string | null {
  const pid = findListenerPid(port)
  if (!pid) return null
  try {
    const name = process.platform === 'win32'
      ? execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).match(/^"([^"]+)"/)?.[1]
      : execFileSync('ps', ['-p', pid, '-o', 'comm='], { encoding: 'utf8' }).trim()
    return name ? `${name} (PID ${pid})` : `PID ${pid}`
  } catch {
    return `PID ${pid}`
  }
}

/** Kills the process tree listening on `port`. Returns false if none was found. */
export function killListener(port: number): boolean {
  const pid = findListenerPid(port)
  if (!pid) return false
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', pid, '/T', '/F'])
    else process.kill(Number(pid), 'SIGKILL')
  } catch {
    // Already gone, or not ours to kill: the caller re-checks the port.
  }
  return true
}

/**
 * PID of the socket listening on `port` in `netstat -ano` output. The state
 * column is translated by Windows, so a listener is recognised by its empty
 * remote address (0.0.0.0:0 / [::]:0) instead.
 */
export function parseNetstatListener(netstat: string, port: number): string | null {
  for (const line of netstat.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 5 || !/^TCP/i.test(cols[0])) continue
    if (!cols[1].endsWith(`:${port}`) || !/:0$/.test(cols[2])) continue
    const pid = cols[cols.length - 1]
    if (/^\d+$/.test(pid) && pid !== '0') return pid
  }
  return null
}

export interface PickPortDeps {
  isFree: (port: number) => Promise<boolean>
  isModly: (port: number) => Promise<boolean>
  kill: (port: number) => void
  osPort: () => Promise<number>
  log: (msg: string) => void
  wait?: (ms: number) => Promise<void>
}

/**
 * The port the backend should use. Only the preferred port is reclaimed from
 * an old Modly backend; anything else holding a port is left alone.
 */
export async function pickPort(preferred: number, deps: PickPortDeps): Promise<number> {
  const wait = deps.wait ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)))
  for (const port of candidatePorts(preferred)) {
    if (await deps.isFree(port)) return port
    if (port === preferred && await deps.isModly(port)) {
      deps.log(`Port ${port} is held by an old Modly backend, stopping it`)
      deps.kill(port)
      for (let i = 0; i < 10; i++) {
        await wait(300)
        if (await deps.isFree(port)) return port
      }
    }
    deps.log(`Port ${port} is not available, trying another one`)
  }
  return deps.osPort()
}

/**
 * Tells tools outside the app (MCP server, modly-cli) which port the backend
 * uses: <userData>/api-port holds the number while it runs.
 */
export function writePortFile(userData: string, port: number): void {
  try { writeFileSync(join(userData, PORT_FILE), String(port)) } catch { /* best effort */ }
}

export function removePortFile(userData: string): void {
  try { rmSync(join(userData, PORT_FILE), { force: true }) } catch { /* best effort */ }
}

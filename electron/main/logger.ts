import { app } from 'electron'
import { appendFileSync, mkdirSync, existsSync, readdirSync, statSync, renameSync, rmSync } from 'fs'
import { join } from 'path'

const MAX_SESSIONS = 10
const LOG_FILES = ['modly.log', 'errors.log', 'runtime.log']

function getLogsDir(): string {
  const logsDir = join(app.getPath('userData'), 'logs')
  mkdirSync(logsDir, { recursive: true })
  return logsDir
}

function writeTo(filename: string, logLine: string): void {
  try {
    appendFileSync(join(getLogsDir(), filename), logLine, 'utf-8')
  } catch {}
}

function line(level: string, message: string): string {
  return `[${new Date().toISOString()}] [${level}] ${message}\n`
}

export function archiveCurrentSession(): void {
  const logsDir = getLogsDir()
  const hasLogs = LOG_FILES.some(f => existsSync(join(logsDir, f)))
  if (!hasLogs) return

  const timestamp = new Date().toISOString().replace(/:/g, '-').slice(0, 19)
  const sessionsDir = join(logsDir, 'sessions')
  const sessionDir = join(sessionsDir, timestamp)
  mkdirSync(sessionDir, { recursive: true })

  for (const file of LOG_FILES) {
    const src = join(logsDir, file)
    if (existsSync(src)) {
      try { renameSync(src, join(sessionDir, file)) } catch {}
    }
  }

  // Keep only last MAX_SESSIONS
  try {
    const sessions = readdirSync(sessionsDir)
      .filter(f => statSync(join(sessionsDir, f)).isDirectory())
      .sort()
      .reverse()
    for (const old of sessions.slice(MAX_SESSIONS)) {
      rmSync(join(sessionsDir, old), { recursive: true, force: true })
    }
  } catch {}
}

// Console writes throw EPIPE when the parent process' stdout/stderr pipe is
// gone (e.g. launching terminal closed). Never let logging crash the app.
function safeConsole(fn: (msg: string) => void, msg: string): void {
  try { fn(msg) } catch {}
}

export const logger = {
  info:   (msg: string) => { safeConsole(console.log, msg);   writeTo('modly.log', line('INFO',   msg)) },
  warn:   (msg: string) => { safeConsole(console.warn, msg);  writeTo('modly.log', line('WARN',   msg)) },
  error:  (msg: string) => { safeConsole(console.error, msg); writeTo('modly.log', line('ERROR',  msg)); writeTo('errors.log', line('ERROR', msg)) },
  python: (msg: string) => {
    writeTo('runtime.log', line('RUNTIME', msg))
    if (/error|exception|traceback|critical/i.test(msg)) {
      writeTo('errors.log', line('RUNTIME', msg))
    }
  },
}

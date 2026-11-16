// Turns a FastAPI process that died during startup into a message the user can
// act on. python-bridge.ts gathers the stderr and exit code.

const TAIL_MAX_CHARS = 16_000
const SHOWN_LINES = 15

// uvicorn prints "[Errno N] error while attempting to bind on address …" with
// the rest in the OS language, so match on the number.
// 10048 / 98 / 48: the port is in use (Windows / Linux / macOS).
// 10013: Windows forbids the port, usually a range reserved by Hyper-V / WinNAT.
const PORT_IN_USE = /\[Errno (10048|98|48)\]|address already in use/i
const PORT_FORBIDDEN = /\[Errno 10013\]/

export type PortProblem = 'in-use' | 'forbidden' | null

export interface StartupFailure {
  port: number
  exitCode: number | null
  spawnError?: string | null
  stderr: string
  /** e.g. "com.docker.backend.exe (PID 1234)", when it could be found. */
  portHolder?: string | null
}

/** Keeps the end of a growing output buffer. */
export function appendTail(tail: string, chunk: string, max = TAIL_MAX_CHARS): string {
  const next = tail + chunk
  return next.length > max ? next.slice(next.length - max) : next
}

export function detectPortProblem(stderr: string): PortProblem {
  if (PORT_FORBIDDEN.test(stderr)) return 'forbidden'
  if (PORT_IN_USE.test(stderr)) return 'in-use'
  return null
}

/** The last lines of stderr that are not uvicorn INFO chatter. */
export function relevantLines(stderr: string, count = SHOWN_LINES): string[] {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '' && !/^INFO:/.test(l))
  return lines.slice(-count)
}

export function describeStartupFailure(f: StartupFailure): string {
  if (f.spawnError) {
    return `Could not launch the Python backend: ${f.spawnError}\n\n` +
      'If an antivirus blocked it, add the app folder to its exclusions and retry.'
  }

  const problem = detectPortProblem(f.stderr)
  if (problem === 'in-use') {
    const holder = f.portHolder ? ` by ${f.portHolder}` : ' by another program'
    return `Port ${f.port} is already in use${holder}.\n\n` +
      `Modly's backend needs port ${f.port}. Stop that program (or remove its ` +
      `port ${f.port} mapping, e.g. in Docker), then retry.`
  }
  if (problem === 'forbidden') {
    return `Windows does not allow Modly to use port ${f.port}.\n\n` +
      'It is probably inside a port range reserved by Hyper-V / WSL / Docker. ' +
      'Check with:  netsh interface ipv4 show excludedportrange protocol=tcp\n' +
      'Restarting the "winnat" service (net stop winnat, then net start winnat, ' +
      'as administrator) usually frees it.'
  }

  const code = f.exitCode === null ? '' : ` (exit code ${f.exitCode})`
  const lines = relevantLines(f.stderr)
  if (lines.length === 0) return `The Python backend stopped during startup${code}.`
  return `The Python backend stopped during startup${code}:\n\n${lines.join('\n')}`
}


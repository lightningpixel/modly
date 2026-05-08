import { BrowserWindow, app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { spawn, execSync } from 'child_process'
import { createHash } from 'crypto'
import { getSettings } from './settings-store'

const SETUP_VERSION = 3

interface SetupJson {
  version: number
  requirementsHash?: string
}

function getRequirementsPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'api', 'requirements.txt')
    : join(app.getAppPath(), 'api', 'requirements.txt')
}

function hashRequirements(): string {
  try {
    const content = readFileSync(getRequirementsPath(), 'utf-8')
    return createHash('sha256').update(content).digest('hex')
  } catch {
    return ''
  }
}

// ─── Environment ─────────────────────────────────────────────────────────────

/**
 * Clean environment for spawning Python/pip.
 * Strips vars that could redirect imports or installs to the user's system Python.
 */
export function cleanPythonEnv(): NodeJS.ProcessEnv {
  const {
    PYTHONHOME, PYTHONPATH, PYTHONSTARTUP, PYTHONUSERBASE,
    PIP_USER, PIP_TARGET, PIP_PREFIX, PIP_REQUIRE_VIRTUALENV,
    VIRTUAL_ENV, CONDA_PREFIX,
    ...rest
  } = process.env
  void PYTHONHOME; void PYTHONPATH; void PYTHONSTARTUP; void PYTHONUSERBASE
  void PIP_USER; void PIP_TARGET; void PIP_PREFIX; void PIP_REQUIRE_VIRTUALENV
  void VIRTUAL_ENV; void CONDA_PREFIX
  return rest
}

// ─── Path helpers ─────────────────────────────────────────────────────────────

export function getEmbeddedPythonDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'python-embed')
  return join(app.getAppPath(), 'resources', 'python-embed')
}

export function getEmbeddedPythonExe(): string {
  const dir = getEmbeddedPythonDir()
  return process.platform === 'win32' ? join(dir, 'python.exe') : join(dir, 'bin', 'python3')
}

/** Venv lives inside dependenciesDir on Windows (user-configurable drive), userData on Linux. */
export function getVenvDir(userData: string): string {
  if (process.platform === 'win32') {
    return join(getSettings(userData).dependenciesDir, 'venv')
  }
  return join(userData, 'venv')
}

export function getVenvPythonExe(userData: string): string {
  const venvDir = getVenvDir(userData)
  return process.platform === 'win32'
    ? join(venvDir, 'Scripts', 'python.exe')
    : join(venvDir, 'bin', 'python')
}

// ─── Setup state ──────────────────────────────────────────────────────────────

export function checkSetupNeeded(userData: string): boolean {
  const jsonPath = join(userData, 'python_setup.json')
  if (!existsSync(jsonPath)) return true
  try {
    const data = JSON.parse(readFileSync(jsonPath, 'utf-8')) as SetupJson
    if (data.version < SETUP_VERSION) return true
    if (data.requirementsHash !== hashRequirements()) return true
  } catch {
    return true
  }
  if (!existsSync(getVenvPythonExe(userData))) return true
  return false
}

/**
 * Write a sitecustomize.py into the venv that silently skips malformed certs
 * in the Windows certificate store (ssl.SSLError: [ASN1] nested asn1 error).
 * Python imports sitecustomize automatically on every startup.
 * No-op on non-Windows or if the patch already exists.
 */
/**
 * Returns the path to certifi's cacert.pem inside the venv, or undefined if not found.
 * Used to set SSL_CERT_FILE / REQUESTS_CA_BUNDLE for python-embed subprocesses,
 * which ship without a CA bundle on Windows.
 */
export function getCertifiBundle(userData: string): string | undefined {
  const venvDir = getVenvDir(userData)
  // Windows venv layout: Lib/site-packages/certifi/cacert.pem
  const winPath = join(venvDir, 'Lib', 'site-packages', 'certifi', 'cacert.pem')
  if (existsSync(winPath)) return winPath
  // Linux/macOS venv layout: lib/pythonX.Y/site-packages/certifi/cacert.pem
  const libDir = join(venvDir, 'lib')
  if (existsSync(libDir)) {
    try {
      const { readdirSync } = require('fs') as typeof import('fs')
      for (const entry of readdirSync(libDir)) {
        const candidate = join(libDir, entry, 'site-packages', 'certifi', 'cacert.pem')
        if (existsSync(candidate)) return candidate
      }
    } catch { /* ignore */ }
  }
  return undefined
}

export function ensureSslPatch(userData: string): void {
  if (process.platform !== 'win32') return
  const venvDir  = getVenvDir(userData)
  const sitePkg  = join(venvDir, 'Lib', 'site-packages')
  const target   = join(sitePkg, 'sitecustomize.py')
  if (!existsSync(sitePkg)) return
  if (existsSync(target))   return
  writeFileSync(target, [
    'try:',
    '    import ssl as _ssl',
    '    _orig = _ssl.SSLContext._load_windows_store_certs',
    '    def _safe(self, storename, purpose):',
    '        try:',
    '            _orig(self, storename, purpose)',
    '        except _ssl.SSLError:',
    '            pass',
    '    _ssl.SSLContext._load_windows_store_certs = _safe',
    'except Exception:',
    '    pass',
    '',
  ].join('\n'), 'utf-8')
}

export function markSetupDone(userData: string): void {
  writeFileSync(
    join(userData, 'python_setup.json'),
    JSON.stringify({ version: SETUP_VERSION, requirementsHash: hashRequirements() }),
    'utf-8'
  )
}

// ─── Setup steps ─────────────────────────────────────────────────────────────

function createVenv(pythonExe: string, venvDir: string, win: BrowserWindow): Promise<void> {
  return new Promise((resolve, reject) => {
    win.webContents.send('setup:progress', { step: 'venv', percent: 5 })
    console.log('[PythonSetup] Creating venv at', venvDir)
    const proc = spawn(pythonExe, ['-m', 'venv', venvDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: cleanPythonEnv(),
    })
    let stderrOut = ''
    proc.stdout?.on('data', (d: Buffer) => console.log('[venv]', d.toString().trim()))
    proc.stderr?.on('data', (d: Buffer) => {
      const text = d.toString().trim()
      if (text) { console.error('[venv]', text); stderrOut += text + '\n' }
    })
    proc.on('close', (code) => {
      if (code === 0) {
        win.webContents.send('setup:progress', { step: 'venv', percent: 20 })
        resolve()
      } else {
        let msg = `python -m venv exited with code ${code}`
        if (stderrOut) msg += `\n\n${stderrOut.trim()}`
        if (process.platform === 'win32') {
          msg +=
            '\n\nYour antivirus may be blocking the Python runtime.' +
            `\nTry adding an exclusion for:\n  ${pythonExe}` +
            '\nOr temporarily pause real-time protection, then click Retry.'
        }
        reject(new Error(msg))
      }
    })
  })
}

function installRequirements(
  pythonExe: string,
  requirementsPath: string,
  win: BrowserWindow
): Promise<void> {
  const TOTAL_PACKAGES = 20
  return new Promise((resolve, reject) => {
    console.log('[PythonSetup] Installing requirements with', pythonExe)
    const proc = spawn(
      pythonExe,
      ['-m', 'pip', 'install', '-r', requirementsPath, '--no-warn-script-location', '--progress-bar', 'off'],
      { stdio: ['ignore', 'pipe', 'pipe'], env: cleanPythonEnv() }
    )
    let packagesInstalled = 0
    const onLine = (line: string) => {
      console.log('[pip]', line)
      let currentPackage: string | undefined
      const collectMatch = line.match(/^Collecting (.+?)(?:\s|$)/)
      if (collectMatch) { packagesInstalled++; currentPackage = collectMatch[1] }
      const downloadMatch = line.match(/^Downloading (.+?)(?:\s|$)/)
      if (downloadMatch) currentPackage = `Downloading ${downloadMatch[1]}…`
      const percent = Math.round(20 + (packagesInstalled / TOTAL_PACKAGES) * 79)
      win.webContents.send('setup:progress', {
        step: 'packages',
        percent: Math.min(percent, 99),
        currentPackage,
      })
    }
    let buffer = ''
    proc.stdout?.on('data', (d: Buffer) => {
      buffer += d.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      lines.forEach((l) => onLine(l.trim()))
    })
    proc.stderr?.on('data', (d: Buffer) => {
      const text = d.toString().trim()
      if (text) console.error('[pip]', text)
    })
    proc.on('close', (code) => {
      if (code === 0) {
        win.webContents.send('setup:progress', { step: 'packages', percent: 100 })
        resolve()
      } else {
        reject(new Error(`pip install exited with code ${code}`))
      }
    })
  })
}

// ─── Unix dev helper ─────────────────────────────────────────────────────────

function findSystemPython(): string {
  const candidates = ['python3.12', 'python3.11', 'python3.10', 'python3', 'python']
  for (const cmd of candidates) {
    try {
      const out = execSync(`${cmd} --version`, { encoding: 'utf8', timeout: 3000 }).trim()
      if (out.startsWith('Python 3.')) {
        console.log(`[PythonSetup] Found system Python: ${cmd} → ${out}`)
        return cmd
      }
    } catch { /* not found */ }
  }
  throw new Error(
    'Python 3 not found on your system.\n' +
    'Please install Python 3.10+ and try again.\n' +
    'Ubuntu/Debian : sudo apt install python3 python3-venv\n' +
    'macOS         : brew install python@3.11'
  )
}

// ─── Public orchestrator ──────────────────────────────────────────────────────

export async function runFullSetup(win: BrowserWindow, userData: string): Promise<void> {
  try {
    const requirementsPath = getRequirementsPath()
    const venvDir = getVenvDir(userData)

    if (process.platform === 'win32' || app.isPackaged) {
      // Packaged (all platforms) + Windows dev: use bundled python-build-standalone.
      // python-build-standalone is a full Python install → venv module works natively,
      // DLLs come from the installer so SAC doesn't block them.
      const pythonExe = getEmbeddedPythonExe()
      if (!existsSync(pythonExe)) {
        throw new Error(
          'Bundled Python runtime not found.\n' +
          'Please reinstall the application.\n' +
          `(expected: ${pythonExe})`
        )
      }
      await createVenv(pythonExe, venvDir, win)
      const venvPython = getVenvPythonExe(userData)
      await installRequirements(venvPython, requirementsPath, win)
    } else {
      // Linux / macOS dev: use system Python
      win.webContents.send('setup:progress', { step: 'venv', percent: 5 })
      const python3 = findSystemPython()
      await createVenv(python3, venvDir, win)
      const venvPython = getVenvPythonExe(userData)
      await installRequirements(venvPython, requirementsPath, win)
    }

    win.webContents.send('setup:complete')
    console.log('[PythonSetup] Setup complete')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[PythonSetup] Error:', message)
    win.webContents.send('setup:error', { message })
    throw err
  }
}

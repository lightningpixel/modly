import { BrowserWindow, app } from 'electron'
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { spawn, execSync } from 'child_process'
import { createHash } from 'crypto'

const SETUP_VERSION = 2
const TOTAL_PACKAGES = 20

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

// ─── Public helpers ──────────────────────────────────────────────────────────

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
  // On Unix packaged: also verify the venv was created
  if (process.platform !== 'win32' && app.isPackaged) {
    if (!existsSync(join(userData, 'venv', 'bin', 'python'))) return true
  }
  return false
}

export function markSetupDone(userData: string): void {
  const jsonPath = join(userData, 'python_setup.json')
  writeFileSync(
    jsonPath,
    JSON.stringify({ version: SETUP_VERSION, requirementsHash: hashRequirements() }),
    'utf-8'
  )
}

/** Path to the venv Python executable created during setup (packaged Unix). */
export function getVenvPythonExe(userData: string): string {
  return join(userData, 'venv', 'bin', 'python')
}

// ─── Embedded Python helpers (all platforms) ─────────────────────────────────

export function getEmbeddedPythonDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'python-embed')
  return join(app.getAppPath(), 'resources', 'python-embed')
}

export function getEmbeddedPythonExe(): string {
  const dir = getEmbeddedPythonDir()
  if (process.platform === 'win32') return join(dir, 'python.exe')
  return join(dir, 'bin', 'python3')
}

function enableSitePackages(pythonDir: string, win: BrowserWindow): void {
  win.webContents.send('setup:progress', { step: 'enabling-site', percent: 5 })
  const files = readdirSync(pythonDir) as string[]
  const pthFile = files.find((f) => f.match(/^python\d+\._pth$/))
  if (!pthFile) {
    console.warn('[PythonSetup] No ._pth file found in', pythonDir)
    return
  }
  const pthPath = join(pythonDir, pthFile)
  let content = readFileSync(pthPath, 'utf-8')
  content = content.replace(/^#import site/m, 'import site')
  if (!content.includes('Lib\\site-packages')) {
    content = content.trimEnd() + '\nLib\\site-packages\n'
  }
  writeFileSync(pthPath, content, 'utf-8')
  console.log('[PythonSetup] Enabled site-packages in', pthFile)
}

function installPip(pythonExe: string, resourcesPath: string, win: BrowserWindow): Promise<void> {
  return new Promise((resolve, reject) => {
    win.webContents.send('setup:progress', { step: 'pip', percent: 10 })
    const getPipPath = join(resourcesPath, 'get-pip.py')
    console.log('[PythonSetup] Installing pip from', getPipPath)
    const proc = spawn(pythonExe, [getPipPath, '--no-warn-script-location'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    proc.stdout?.on('data', (d: Buffer) => console.log('[pip install]', d.toString().trim()))
    proc.stderr?.on('data', (d: Buffer) => console.error('[pip install]', d.toString().trim()))
    proc.on('close', (code) => {
      win.webContents.send('setup:progress', { step: 'pip', percent: 20 })
      if (code === 0) resolve()
      else reject(new Error(`get-pip.py exited with code ${code}`))
    })
  })
}

// ─── Shared helper ───────────────────────────────────────────────────────────

function installRequirements(
  pythonExe: string,
  requirementsPath: string,
  win: BrowserWindow
): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log('[PythonSetup] Installing requirements from', requirementsPath)
    const proc = spawn(
      pythonExe,
      ['-m', 'pip', 'install', '-r', requirementsPath, '--no-warn-script-location', '--progress-bar', 'off'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
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

// ─── Unix helpers (venv) ─────────────────────────────────────────────────────

function findSystemPython(): string {
  const candidates = ['python3.12', 'python3.11', 'python3.10', 'python3', 'python']
  for (const cmd of candidates) {
    try {
      const out = execSync(`${cmd} --version`, { encoding: 'utf8', timeout: 3000 }).trim()
      if (out.startsWith('Python 3.')) {
        console.log(`[PythonSetup] Found system Python: ${cmd} → ${out}`)
        return cmd
      }
    } catch { /* not found, try next */ }
  }
  throw new Error(
    'Python 3 not found on your system.\n' +
    'Please install Python 3.10+ and try again.\n' +
    'Ubuntu/Debian : sudo apt install python3 python3-venv\n' +
    'macOS         : brew install python@3.11'
  )
}

function createVenv(python3: string, venvDir: string, win: BrowserWindow): Promise<void> {
  return new Promise((resolve, reject) => {
    win.webContents.send('setup:progress', { step: 'venv', percent: 10 })
    console.log('[PythonSetup] Creating venv at', venvDir)
    const proc = spawn(python3, ['-m', 'venv', venvDir], { stdio: ['ignore', 'pipe', 'pipe'] })
    proc.stdout?.on('data', (d: Buffer) => console.log('[venv]', d.toString().trim()))
    proc.stderr?.on('data', (d: Buffer) => console.error('[venv]', d.toString().trim()))
    proc.on('close', (code) => {
      if (code === 0) {
        win.webContents.send('setup:progress', { step: 'venv', percent: 20 })
        resolve()
      } else {
        reject(new Error(`python3 -m venv exited with code ${code}`))
      }
    })
  })
}

// ─── Public orchestrator ─────────────────────────────────────────────────────

export async function runFullSetup(win: BrowserWindow, userData: string): Promise<void> {
  try {
    const requirementsPath = getRequirementsPath()

    if (process.platform === 'win32') {
      // Windows: use embedded Python bundled with the app
      const pythonDir = getEmbeddedPythonDir()
      const pythonExe = getEmbeddedPythonExe()
      const resourcesPath = app.isPackaged
        ? process.resourcesPath
        : join(app.getAppPath(), 'resources')

      enableSitePackages(pythonDir, win)
      await installPip(pythonExe, resourcesPath, win)
      await installRequirements(pythonExe, requirementsPath, win)
    } else if (app.isPackaged) {
      // Linux / macOS packaged: use bundled Python to create a venv in userData
      // (resources dir may be read-only inside .app bundle)
      win.webContents.send('setup:progress', { step: 'venv', percent: 5 })
      const python3 = getEmbeddedPythonExe()
      const venvDir = join(userData, 'venv')
      await createVenv(python3, venvDir, win)
      const venvPython = join(venvDir, 'bin', 'python')
      await installRequirements(venvPython, requirementsPath, win)
    } else {
      // Linux / macOS dev: create a venv using the system Python
      win.webContents.send('setup:progress', { step: 'python', percent: 5 })
      const python3 = findSystemPython()
      const venvDir = join(userData, 'venv')
      await createVenv(python3, venvDir, win)
      const venvPython = join(venvDir, 'bin', 'python')
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

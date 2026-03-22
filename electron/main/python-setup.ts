import { BrowserWindow, app } from 'electron'
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { spawn, spawnSync, execSync } from 'child_process'
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
  // python-build-standalone uses symlinks which may not survive packaging;
  // try the versioned binary first, then fallback to python3/python
  const candidates = ['bin/python3.11', 'bin/python3', 'bin/python']
  for (const candidate of candidates) {
    const p = join(dir, candidate)
    if (existsSync(p)) return p
  }
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

// ─── GPU detection ──────────────────────────────────────────────────────────

type GpuVendor = 'nvidia' | 'amd' | 'none'

function detectGpu(): GpuVendor {
  // NVIDIA: check for nvidia-smi
  try {
    execSync('nvidia-smi', { encoding: 'utf8', timeout: 5000, stdio: 'pipe' })
    console.log('[PythonSetup] Detected NVIDIA GPU')
    return 'nvidia'
  } catch { /* not nvidia */ }

  // AMD ROCm: check for rocminfo or /opt/rocm
  try {
    execSync('rocminfo', { encoding: 'utf8', timeout: 5000, stdio: 'pipe' })
    console.log('[PythonSetup] Detected AMD GPU (ROCm)')
    return 'amd'
  } catch { /* not amd */ }

  // Windows: check for AMD via WMIC/PowerShell
  if (process.platform === 'win32') {
    try {
      const out = execSync(
        'wmic path win32_VideoController get name',
        { encoding: 'utf8', timeout: 5000, stdio: 'pipe' }
      )
      if (/radeon|amd/i.test(out)) {
        console.log('[PythonSetup] Detected AMD GPU (Windows)')
        return 'amd'
      }
      if (/nvidia|geforce|rtx|gtx|quadro/i.test(out)) {
        console.log('[PythonSetup] Detected NVIDIA GPU (Windows)')
        return 'nvidia'
      }
    } catch { /* ignore */ }
  }

  console.log('[PythonSetup] No GPU detected, using CPU-only PyTorch')
  return 'none'
}

function getPytorchIndexUrl(vendor: GpuVendor): string {
  switch (vendor) {
    case 'nvidia': return 'https://download.pytorch.org/whl/cu128'
    case 'amd':    return 'https://download.pytorch.org/whl/rocm6.4'
    case 'none':   return 'https://download.pytorch.org/whl/cpu'
  }
}

// ─── Shared helper ───────────────────────────────────────────────────────────

function installRequirements(
  pythonExe: string,
  requirementsPath: string,
  win: BrowserWindow
): Promise<void> {
  return new Promise((resolve, reject) => {
    const gpu = detectGpu()
    const indexUrl = getPytorchIndexUrl(gpu)
    console.log(`[PythonSetup] GPU vendor: ${gpu}, PyTorch index: ${indexUrl}`)
    console.log('[PythonSetup] Installing requirements from', requirementsPath)
    const proc = spawn(
      pythonExe,
      ['-m', 'pip', 'install', '-r', requirementsPath, '--index-url', indexUrl, '--no-warn-script-location', '--progress-bar', 'off'],
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

function probePython(cmd: string): { ok: boolean; version?: string; reason?: string } {
  try {
    const versionProbe = spawnSync(
      cmd,
      ['-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}")'],
      { encoding: 'utf8', timeout: 3000 }
    )
    if (versionProbe.status !== 0) {
      const err = (versionProbe.stderr || versionProbe.stdout || '').trim() || 'failed to run'
      return { ok: false, reason: err }
    }

    const version = (versionProbe.stdout || '').trim()
    const [majorRaw, minorRaw] = version.split('.')
    const major = Number(majorRaw)
    const minor = Number(minorRaw)
    if (major !== 3 || Number.isNaN(minor) || minor < 10 || minor > 13) {
      return { ok: false, reason: `unsupported Python ${version} (need 3.10-3.13)` }
    }

    const venvProbe = spawnSync(cmd, ['-m', 'venv', '--help'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (venvProbe.status !== 0) {
      const err = (venvProbe.stderr || venvProbe.stdout || '').trim() || 'venv module is unavailable'
      return { ok: false, reason: err }
    }

    return { ok: true, version }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

function findSystemPython(): string {
  const candidates = ['python3.12', 'python3.11', 'python3.10', 'python3', 'python']
  for (const cmd of candidates) {
    const probe = probePython(cmd)
    if (!probe.ok) {
      console.log(`[PythonSetup] Skipping ${cmd}: ${probe.reason}`)
      continue
    }
    console.log(`[PythonSetup] Found system Python: ${cmd} -> Python ${probe.version}`)
    return cmd
  }

  throw new Error(
    'No supported Python interpreter with venv support was found.\n' +
    'Install Python 3.10-3.13 and ensure the venv module is available.\n' +
    'Ubuntu/Debian : sudo apt install python3.12 python3.12-venv\n' +
    'Arch Linux    : sudo pacman -S python312\n' +
    'Windows       : install Python 3.12 from python.org (enable Add to PATH)\n' +
    'macOS         : brew install python@3.12'
  )
}

function createVenv(
  python3: string,
  venvDir: string,
  win: BrowserWindow,
  opts?: { clear?: boolean; copies?: boolean }
): Promise<void> {
  return new Promise((resolve, reject) => {
    win.webContents.send('setup:progress', { step: 'venv', percent: 10 })
    console.log('[PythonSetup] Creating venv at', venvDir)
    const args = ['-m', 'venv']
    if (opts?.clear) args.push('--clear')
    if (opts?.copies) args.push('--copies')
    args.push(venvDir)
    const proc = spawn(python3, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    proc.stdout?.on('data', (d: Buffer) => console.log('[venv]', d.toString().trim()))
    proc.stderr?.on('data', (d: Buffer) => {
      const text = d.toString().trim()
      if (text) {
        stderr += `${text}\n`
        console.error('[venv]', text)
      }
    })
    proc.on('close', (code) => {
      if (code === 0) {
        win.webContents.send('setup:progress', { step: 'venv', percent: 20 })
        resolve()
      } else {
        const details = stderr.trim()
        let hint = ''
        if (/No module named venv|ensurepip is not available/i.test(details)) {
          hint =
            '\nHint: your Python is missing venv/ensurepip support. ' +
            'Install the OS venv package or use Python 3.12 from python.org.'
        }
        reject(new Error(`${python3} -m venv exited with code ${code}${details ? `\n${details}` : ''}${hint}`))
      }
    })
  })
}

// ─── Public orchestrator ─────────────────────────────────────────────────────

export async function runFullSetup(win: BrowserWindow, userData: string): Promise<void> {
  try {
    const requirementsPath = getRequirementsPath()
    let pythonExe: string

    if (process.platform === 'win32' && app.isPackaged) {
      // Windows packaged: use embedded Python bundled with the app
      const pythonDir = getEmbeddedPythonDir()
      pythonExe = getEmbeddedPythonExe()
      const resourcesPath = process.resourcesPath

      enableSitePackages(pythonDir, win)
      await installPip(pythonExe, resourcesPath, win)
      await installRequirements(pythonExe, requirementsPath, win)
    } else if (process.platform === 'win32' && !app.isPackaged) {
      // Windows dev: create a venv using the system Python
      win.webContents.send('setup:progress', { step: 'python', percent: 5 })
      const python3 = findSystemPython()
      const venvDir = join(userData, '.venv')
      await createVenv(python3, venvDir, win)
      pythonExe = join(venvDir, 'Scripts', 'python.exe')
      await installRequirements(pythonExe, requirementsPath, win)
    } else if (app.isPackaged) {
      // Linux / macOS packaged: use bundled Python to create a venv in userData
      // (resources dir may be read-only inside .app bundle)
      win.webContents.send('setup:progress', { step: 'venv', percent: 5 })
      const python3 = getEmbeddedPythonExe()
      const venvDir = join(userData, 'venv')
      // AppImage and similar bundles can make absolute interpreter symlinks unstable
      // across launches; use real copies and clear stale/broken envs.
      await createVenv(python3, venvDir, win, { clear: true, copies: true })
      pythonExe = join(venvDir, 'bin', 'python')
      await installRequirements(pythonExe, requirementsPath, win)
    } else {
      // Linux / macOS dev: create a venv using the system Python
      win.webContents.send('setup:progress', { step: 'python', percent: 5 })
      const python3 = findSystemPython()
      const venvDir = join(userData, '.venv')
      await createVenv(python3, venvDir, win)
      pythonExe = join(venvDir, 'bin', 'python')
      await installRequirements(pythonExe, requirementsPath, win)
    }

    // Compile C++ extensions (texture_baker and uv_unwrapper)
    const apiDir = app.isPackaged
      ? join(process.resourcesPath, 'api')
      : join(app.getAppPath(), 'api')
    await buildCppExtensions(pythonExe, apiDir, win)

    win.webContents.send('setup:complete')
    console.log('[PythonSetup] Setup complete')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[PythonSetup] Error:', message)
    win.webContents.send('setup:error', { message })
    throw err
  }
}

// ─── C++ extension compilation ──────────────────────────────────────────────

function buildCppExtension(
  pythonExe: string,
  extensionDir: string,
  name: string,
  win: BrowserWindow
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!existsSync(join(extensionDir, 'setup.py'))) {
      console.log(`[PythonSetup] Skipping ${name}: no setup.py found`)
      resolve()
      return
    }
    console.log(`[PythonSetup] Compiling C++ extension: ${name}`)
    win.webContents.send('setup:progress', {
      step: 'extensions',
      currentPackage: `Compiling ${name}…`,
    })
    const proc = spawn(
      pythonExe,
      ['setup.py', 'build_ext', '--inplace'],
      { cwd: extensionDir, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    proc.stdout?.on('data', (d: Buffer) => console.log(`[${name}]`, d.toString().trim()))
    proc.stderr?.on('data', (d: Buffer) => {
      const text = d.toString().trim()
      if (text) console.warn(`[${name}]`, text)
    })
    proc.on('close', (code) => {
      if (code === 0) {
        console.log(`[PythonSetup] ${name} compiled successfully`)
        resolve()
      } else {
        // Non-fatal: texture features will be disabled but the app still works
        console.warn(`[PythonSetup] ${name} compilation failed (code ${code}). Texture features may be unavailable.`)
        resolve()
      }
    })
  })
}

async function buildCppExtensions(pythonExe: string, apiDir: string, win: BrowserWindow): Promise<void> {
  win.webContents.send('setup:progress', { step: 'extensions', percent: 95 })
  await buildCppExtension(pythonExe, join(apiDir, 'texture_baker'), 'texture_baker', win)
  await buildCppExtension(pythonExe, join(apiDir, 'uv_unwrapper'), 'uv_unwrapper', win)
}

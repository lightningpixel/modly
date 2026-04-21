import { ChildProcess, spawn } from 'child_process'
import { join } from 'path'
import { app, BrowserWindow } from 'electron'
import { existsSync, mkdirSync } from 'fs'
import axios from 'axios'
import { getSettings } from './settings-store'
import { logger } from './logger'
import { cleanPythonEnv, getVenvPythonExe } from './python-setup'

const API_PORT = 8765
const API_HOST = '127.0.0.1'
export const API_BASE_URL = `http://${API_HOST}:${API_PORT}`

export class PythonBridge {
  private process: ChildProcess | null = null
  private ready = false
  private startPromise: Promise<void> | null = null
  private getWindow: (() => BrowserWindow | null) | null = null
  private intentionalStop = false

  setWindowGetter(fn: () => BrowserWindow | null): void {
    this.getWindow = fn
  }

  async start(): Promise<void> {
    if (this.ready) return
    if (this.startPromise) return this.startPromise
    this.startPromise = this._start()
    try {
      await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  private async _start(): Promise<void> {
    if (this.process) {
      await this.waitUntilReady()
      return
    }

    const pythonExecutable = this.resolvePythonExecutable()
    const apiDir = this.resolveApiDir()

    console.log('[PythonBridge] Starting FastAPI at', apiDir)
    console.log('[PythonBridge] Python executable:', pythonExecutable)

    await this.killProcessOnPort()

    this.process = spawn(pythonExecutable, ['-m', 'uvicorn', 'main:app', '--host', API_HOST, '--port', String(API_PORT)], {
      cwd: apiDir,
      env: {
        ...cleanPythonEnv(),
        PYTHONUNBUFFERED:          '1',
        // No PYTHONPATH needed — the venv's Python has its own isolated site-packages
        MODELS_DIR:                this.resolveModelsDir(),
        WORKSPACE_DIR:             this.resolveWorkspaceDir(),
        EXTENSIONS_DIR:            this.resolveExtensionsDir(),
        SELECTED_MODEL_ID:         process.env['SELECTED_MODEL_ID'] ?? '',
        HUGGING_FACE_HUB_TOKEN:    this.resolveHfToken(),
        HF_TOKEN:                  this.resolveHfToken(),
      }
    })

    this.process.stdout?.on('data', (data) => {
      const msg = data.toString().trim()
      console.log('[FastAPI]', msg)
      logger.python(msg)
      this.emitTqdmLog(msg)
    })

    this.process.stderr?.on('data', (data) => {
      const msg = data.toString().trim()
      console.error('[FastAPI]', msg)
      logger.python(`[stderr] ${msg}`)
      this.emitTqdmLog(msg)
    })

    this.process.on('exit', (code) => {
      const wasReady = this.ready
      console.log('[PythonBridge] Process exited with code', code)
      this.ready = false
      this.process = null
      if (wasReady && !this.intentionalStop) {
        this.getWindow()?.webContents.send('python:crashed', { code })
      }
    })

    await this.waitUntilReady()
  }

  async stop(): Promise<void> {
    if (!this.process) return
    const proc = this.process
    this.process = null
    this.ready = false
    if (process.platform === 'win32') {
      const { execSync } = require('child_process')
      try { execSync(`taskkill /PID ${proc.pid} /T /F`) } catch {}
    } else {
      proc.kill('SIGTERM')
    }
    console.log('[PythonBridge] Stopped')
  }

  async restart(): Promise<void> {
    console.log('[PythonBridge] Restarting to free memory…')
    this.intentionalStop = true
    await this.stop()
    this.intentionalStop = false
    await this.start()
  }

  private emitTqdmLog(raw: string): void {
    if (/INFO/.test(raw)) return
    if (!raw.trim()) return
    this.getWindow()?.webContents.send('python:log', raw.trim())
  }

  isReady(): boolean { return this.ready }
  getPort(): number { return API_PORT }

  private async killProcessOnPort(): Promise<void> {
    const { execSync } = require('child_process')

    if (process.platform !== 'win32') {
      try { execSync(`lsof -ti tcp:${API_PORT} | xargs kill -9 2>/dev/null || true`, { shell: true }) } catch {}
      return
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      let output = ''
      try {
        output = execSync(`netstat -ano | findstr ":${API_PORT} "`, { encoding: 'utf8', shell: true }) as string
      } catch { break }

      const pids = new Set<string>()
      for (const line of output.split('\n')) {
        const match = line.trim().match(/\s+(\d+)$/)
        if (match && match[1] !== '0') pids.add(match[1])
      }
      if (pids.size === 0) break

      for (const pid of pids) {
        try { execSync(`taskkill /PID ${pid} /T /F`, { shell: true }) } catch {}
      }
      await new Promise((r) => setTimeout(r, 300))
    }
  }

  private async waitUntilReady(maxRetries = 180, delayMs = 500): Promise<void> {
    for (let i = 0; i < maxRetries; i++) {
      if (!this.process) throw new Error('FastAPI process exited unexpectedly during startup')
      try {
        await axios.get(`${API_BASE_URL}/health`, { timeout: 2000 })
        this.ready = true
        console.log('[PythonBridge] FastAPI is ready')
        return
      } catch {
        await new Promise((r) => setTimeout(r, delayMs))
      }
    }
    throw new Error('FastAPI did not start in time')
  }

  private resolvePythonExecutable(): string {
    const userData = app.getPath('userData')
    const apiDir = this.resolveApiDir()

    // Primary: venv created during setup (bundled Python → isolated venv)
    const venvPython = getVenvPythonExe(userData)
    if (existsSync(venvPython)) return venvPython

    // Dev fallback: local .venv in the api directory
    const devCandidates = [
      join(apiDir, '.venv', 'Scripts', 'python.exe'),
      join(apiDir, '.venv', 'bin', 'python'),
    ]
    for (const c of devCandidates) {
      if (existsSync(c)) return c
    }

    // Never fall back to bare 'python' on Windows — it would be the user's system Python
    if (process.platform === 'win32') {
      throw new Error('Python venv not found. Please restart the application to re-run setup.')
    }
    return 'python3'
  }

  private resolveApiDir(): string {
    if (app.isPackaged) return join(process.resourcesPath, 'api')
    return join(app.getAppPath(), 'api')
  }

  private resolveModelsDir(): string {
    const s = getSettings(app.getPath('userData'))
    mkdirSync(s.modelsDir, { recursive: true })
    return s.modelsDir
  }

  private resolveWorkspaceDir(): string {
    const s = getSettings(app.getPath('userData'))
    mkdirSync(s.workspaceDir, { recursive: true })
    return s.workspaceDir
  }

  private resolveExtensionsDir(): string {
    const s = getSettings(app.getPath('userData'))
    mkdirSync(s.extensionsDir, { recursive: true })
    return s.extensionsDir
  }

  private resolveHfToken(): string {
    return getSettings(app.getPath('userData')).hfToken ?? ''
  }
}

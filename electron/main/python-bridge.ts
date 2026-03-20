import { ChildProcess, spawn } from 'child_process'
import { join } from 'path'
import { app, BrowserWindow } from 'electron'
import { existsSync, mkdirSync } from 'fs'
import axios from 'axios'
import { getSettings } from './settings-store'
import { logger } from './logger'

const API_PORT = 8765
const API_HOST = '127.0.0.1'
export const API_BASE_URL = `http://${API_HOST}:${API_PORT}`

export class PythonBridge {
  private process: ChildProcess | null = null
  private ready = false
  private startPromise: Promise<void> | null = null
  private getWindow: (() => BrowserWindow | null) | null = null

  setWindowGetter(fn: () => BrowserWindow | null): void {
    this.getWindow = fn
  }

  async start(): Promise<void> {
    // Already fully ready
    if (this.ready) return

    // Startup already in progress — wait for the same promise instead of spawning again
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
      // Process spawned but not ready yet (e.g. second concurrent call) — just wait
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
        ...process.env,
        PYTHONUNBUFFERED:  '1',
        PYTHONPATH:        this.resolveDependenciesDir(),
        MODELS_DIR:        this.resolveModelsDir(),
        WORKSPACE_DIR:     this.resolveWorkspaceDir(),
        EXTENSIONS_DIR:    this.resolveExtensionsDir(),
        SELECTED_MODEL_ID: process.env['SELECTED_MODEL_ID'] ?? '',
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
      if (wasReady) {
        // Server crashed while running — notify the renderer so it stops making API calls
        this.getWindow()?.webContents.send('python:crashed', { code })
      }
    })

    await this.waitUntilReady()
  }  // ← end of _start()

  async stop(): Promise<void> {
    if (!this.process) return
    const proc = this.process
    this.process = null
    this.ready = false
    // On Windows, taskkill /T kills the process AND all its children
    if (process.platform === 'win32') {
      const { execSync } = require('child_process')
      try { execSync(`taskkill /PID ${proc.pid} /T /F`) } catch {}
    } else {
      proc.kill('SIGTERM')
    }
    console.log('[PythonBridge] Stopped')
  }

  private emitTqdmLog(raw: string): void {
    // Skip uvicorn HTTP access logs and Python INFO logger lines
    if (/INFO/.test(raw)) return
    // Skip empty lines
    if (!raw.trim()) return
    this.getWindow()?.webContents.send('python:log', raw.trim())
  }

  isReady(): boolean {
    return this.ready
  }

  getPort(): number {
    return API_PORT
  }

  private async killProcessOnPort(): Promise<void> {
    const { execSync } = require('child_process')

    if (process.platform !== 'win32') {
      try { execSync(`lsof -ti tcp:${API_PORT} | xargs kill -9 2>/dev/null || true`, { shell: true }) } catch {}
      return
    }

    // Retry loop — after a kill the port may take a few ms to be released
    for (let attempt = 0; attempt < 3; attempt++) {
      let output = ''
      try {
        // ":8765 " with trailing space avoids matching :87650, :87651, etc.
        output = execSync(
          `netstat -ano | findstr ":${API_PORT} "`,
          { encoding: 'utf8', shell: true }
        ) as string
      } catch {
        break // findstr returns exit code 1 when no match — port is free
      }

      const pids = new Set<string>()
      for (const line of output.split('\n')) {
        const match = line.trim().match(/\s+(\d+)$/)
        if (match && match[1] !== '0') pids.add(match[1])
      }

      if (pids.size === 0) break

      for (const pid of pids) {
        try {
          execSync(`taskkill /PID ${pid} /T /F`, { shell: true })
          console.log(`[PythonBridge] Killed process tree PID ${pid} on port ${API_PORT}`)
        } catch {}
      }

      await new Promise((r) => setTimeout(r, 300))
    }
  }

  private async waitUntilReady(maxRetries = 180, delayMs = 500): Promise<void> {
    for (let i = 0; i < maxRetries; i++) {
      if (!this.process) {
        throw new Error('FastAPI process exited unexpectedly during startup')
      }
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
    const apiDir = this.resolveApiDir()
    const resourcesPath = app.isPackaged
      ? process.resourcesPath
      : join(app.getAppPath(), 'resources')
    const userData = app.getPath('userData')

    const candidates = app.isPackaged
      ? [
          join(resourcesPath, 'python-embed', 'python.exe'),  // Windows embeddable
          join(userData, 'venv', 'bin', 'python'),             // Linux/macOS venv (packaged)
          'python3',
          'python',
        ]
      : [
          join(apiDir, '.venv', 'Scripts', 'python.exe'), // Windows venv (dev)
          join(apiDir, '.venv', 'bin', 'python'),          // Unix/Mac venv (dev)
          'python',
          'python3',
        ]

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate
      }
    }

    return process.platform === 'win32' ? 'python' : 'python3'
  }

  private resolveApiDir(): string {
    if (app.isPackaged) {
      return join(process.resourcesPath, 'api')
    }
    // In dev, app.getAppPath() returns the desktop/ folder
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

  private resolveDependenciesDir(): string {
    const s = getSettings(app.getPath('userData'))
    mkdirSync(s.dependenciesDir, { recursive: true })
    return s.dependenciesDir
  }

}

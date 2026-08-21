import { ipcMain, BrowserWindow, dialog, app, shell } from 'electron'
import { buildSync } from 'esbuild'
import { autoUpdater } from 'electron-updater'
import { join } from 'path'
import { rm as rmAsync, readFile, writeFile, mkdir, readdir, rename, cp, symlink, lstat } from 'fs/promises'
import { existsSync, mkdirSync, readdirSync, statSync } from 'fs'
import axios from 'axios'
import * as tar from 'tar'
import * as os from 'os'
import { promisify } from 'util'
import { PythonBridge, API_BASE_URL } from './python-bridge'
import {
  isModelDownloaded,
  listDownloadedModels,
  downloadModelFromHF,
  downloadModelSourcesFromHF,
} from './model-downloader'
import { resolveInstalledModelDownloadPlan } from './model-download-plan'
import {
  areModelSourcesDownloaded,
  modelHasLocalData,
  normalizeModelSources,
  resolveModelRoot,
} from './model-sources'
import { getSettings, setSettings } from './settings-store'
import { checkSetupNeeded, markSetupDone, runFullSetup, getVenvPythonExe, ensureSslPatch } from './python-setup'
import { logger } from './logger'
import { getProcessRunner, getPythonProcessRunner, getExtPythonExe, terminateProcessRunner, terminateAllProcessRunners } from './process-runner'
import { getBuiltinExtensionsDir } from './builtin-sync'
import { spawn, execFile } from 'child_process'
import {
  EXT_INCOMPLETE_MARKER,
  EXT_REGISTRATION_PENDING_MARKER,
  EXT_VALIDATED_MARKER,
  assertSafeExtensionId,
  buildExtensionBackupPath,
  buildExtensionStagingPath,
  isInternalExtensionDirName,
  resolveExtensionPathWithinRoot,
} from './extension-path-guard'
import {
  assertCompatibleExtensionUpdateType,
  expectedModelIds,
  markExtensionInstallationInterrupted,
  validateExtensionQuarantinePayload,
  validateExtensionReloadPayload,
  validateExistingExtensionReplacement,
  validateInstallManifest,
} from './extension-install-utils'
import {
  beginExtensionRegistrationTransaction,
  clearExtensionRegistrationTransaction,
  cleanupValidatedExtensionBackups,
  quarantineExtensionRegistrationFailure,
  parseExtensionRegistrationPendingName,
  removeExtensionWithBackups,
  renameWithRetry as renameExtensionWithRetry,
  restoreExtensionBackup,
  rmWithRetry as removeExtensionWithRetry,
  runExtensionRegistrationValidationTransaction,
  runExtensionRepairTransaction,
  type ExtensionRegistrationValidationCapability,
  validateExtensionDestinationRegistration,
} from './extension-install-recovery'
import { registerWorkspaceAssetLibraryIpcHandlers } from './artifact-registry-service'
import { updatesSupported } from './updater'

type WindowGetter = () => BrowserWindow | null
const pExecFile = promisify(execFile)

// ─── GPU detect (best-effort, no Python required) ─────────────────────────────

interface GpuInfo {
  sm: number
  cudaVersion: number
  accelerator: 'cuda' | 'mps' | 'cpu'
}

function detectGpuInfo(): Promise<GpuInfo> {
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return Promise.resolve({ sm: 0, cudaVersion: 0, accelerator: 'mps' })
  }

  return new Promise((resolve) => {
    // Query compute cap + driver version in one call
    const proc = spawn('nvidia-smi', ['--query-gpu=compute_cap,driver_version', '--format=csv,noheader'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let out = ''
    proc.stdout?.on('data', (d: Buffer) => { out += d.toString() })
    proc.on('close', (code) => {
      if (code === 0) {
        const line   = out.trim().split('\n')[0].trim()        // e.g. "8.6, 551.61"
        const parts  = line.split(',').map(s => s.trim())
        const sm     = Math.round(parseFloat(parts[0] ?? '') * 10)  // → 86
        // Derive max supported CUDA version from driver version
        // Driver ≥ 520 → CUDA 11.8, ≥ 525 → 12.0, ≥ 530 → 12.1, ≥ 535 → 12.2,
        // ≥ 545 → 12.3, ≥ 550 → 12.4, ≥ 555 → 12.5, ≥ 560 → 12.6
        const driverMajor = parseInt((parts[1] ?? '').split('.')[0] ?? '0', 10)
        let cudaVersion = 118  // safe minimum
        if      (driverMajor >= 570) cudaVersion = 128  // Blackwell (RTX 50xx, sm_120)
        else if (driverMajor >= 560) cudaVersion = 126
        else if (driverMajor >= 555) cudaVersion = 125
        else if (driverMajor >= 550) cudaVersion = 124
        else if (driverMajor >= 545) cudaVersion = 123
        else if (driverMajor >= 535) cudaVersion = 122
        else if (driverMajor >= 530) cudaVersion = 121
        else if (driverMajor >= 525) cudaVersion = 120
        else if (driverMajor >= 520) cudaVersion = 118
        resolve({ sm: isNaN(sm) ? 86 : sm, cudaVersion, accelerator: 'cuda' })
      } else {
        resolve({ sm: 0, cudaVersion: 0, accelerator: 'cpu' })
      }
    })
    proc.on('error', () => resolve({ sm: 0, cudaVersion: 0, accelerator: 'cpu' }))
  })
}

// ─── Run an extension's setup.py directly (no FastAPI needed) ─────────────────

function runExtensionSetup(
  extDir:      string,
  gpuSm:       number,
  cudaVersion: number,
  onLog?:      (line: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const userData  = app.getPath('userData')
    ensureSslPatch(userData)
    const pythonExe = getVenvPythonExe(userData)
    const setupPy   = join(extDir, 'setup.py')

    // Shared pip wheel cache: a failed setup retried later reuses the multi-GB
    // torch wheels instead of re-downloading them (see issue #223). Extension
    // setup.py scripts that pass --no-cache-dir get it stripped by the launcher.
    const pipCacheDir = join(getSettings(userData).dependenciesDir, 'pip-cache')
    try { mkdirSync(pipCacheDir, { recursive: true }) } catch { /* pip creates it too */ }

    const accelerator = process.platform === 'darwin' && process.arch === 'arm64' ? 'mps' : gpuSm > 0 ? 'cuda' : 'cpu'
    const args = JSON.stringify({
      python_exe: pythonExe,
      ext_dir: extDir,
      gpu_sm: gpuSm,
      cuda_version: cudaVersion,
      accelerator,
      platform: process.platform,
      arch: process.arch,
    })
    const launcher = `
import runpy
import subprocess
import sys

setup_py = sys.argv[1]
setup_args = sys.argv[2:]

_original_run = subprocess.run
_original_check_call = subprocess.check_call
_original_check_output = subprocess.check_output

def _is_cuda_torch_index(value):
    return isinstance(value, str) and value.startswith("https://download.pytorch.org/whl/cu")

def _mentions_torch(command):
    if not isinstance(command, (list, tuple)):
        return False
    return any(str(part).startswith(("torch==", "torchvision==", "torchaudio==")) for part in command)

def _rewrite_command(command):
    if sys.platform != "darwin" or not _mentions_torch(command):
        return command
    if not isinstance(command, (list, tuple)):
        return command

    rewritten = []
    changed = False
    i = 0
    while i < len(command):
        part = command[i]
        text = str(part)
        if text in ("--index-url", "-i", "--extra-index-url") and i + 1 < len(command) and _is_cuda_torch_index(str(command[i + 1])):
            changed = True
            i += 2
            continue
        if text.startswith("--index-url=") or text.startswith("--extra-index-url="):
            value = text.split("=", 1)[1]
            if _is_cuda_torch_index(value):
                changed = True
                i += 1
                continue
        rewritten.append(part)
        i += 1

    if changed:
        print("[Modly setup compat] Removed CUDA-only PyTorch index on macOS; pip will use macOS wheels.", file=sys.stderr)
        return rewritten
    return command

def _is_pip_command(command):
    if not isinstance(command, (list, tuple)):
        return False
    return any("pip" in str(part).lower() for part in command[:3])

def _strip_no_cache(command):
    # Extension setup scripts often hardcode --no-cache-dir, which forces pip to
    # re-download multi-GB wheels on every retry. Modly provides a shared cache
    # via PIP_CACHE_DIR, so drop the flag and let pip use it.
    if not _is_pip_command(command):
        return command
    if not any(str(part) == "--no-cache-dir" for part in command):
        return command
    print("[Modly setup compat] Removed --no-cache-dir so pip reuses the shared wheel cache.", file=sys.stderr)
    return [part for part in command if str(part) != "--no-cache-dir"]

def _transform_command(command):
    return _strip_no_cache(_rewrite_command(command))

def _patched_run(*args, **kwargs):
    args = list(args)
    if args:
        args[0] = _transform_command(args[0])
    return _original_run(*args, **kwargs)

def _patched_check_call(*args, **kwargs):
    args = list(args)
    if args:
        args[0] = _transform_command(args[0])
    return _original_check_call(*args, **kwargs)

def _patched_check_output(*args, **kwargs):
    args = list(args)
    if args:
        args[0] = _transform_command(args[0])
    return _original_check_output(*args, **kwargs)

subprocess.run = _patched_run
subprocess.check_call = _patched_check_call
subprocess.check_output = _patched_check_output

sys.argv = [setup_py] + setup_args
runpy.run_path(setup_py, run_name="__main__")
`
    const proc = spawn(pythonExe, ['-c', launcher, setupPy, args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env:   { ...process.env, PIP_CACHE_DIR: pipCacheDir },
    })

    const handleLine = (line: string) => { if (line) onLog?.(line) }

    let stderr = ''
    proc.stdout?.on('data', (d: Buffer) => d.toString().split('\n').forEach(handleLine))
    proc.stderr?.on('data', (d: Buffer) => {
      const s = d.toString()
      stderr += s
      s.split('\n').forEach(handleLine)
    })

    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`setup.py exited with code ${code}\n${stderr.slice(-2000)}`))
    })
    proc.on('error', reject)
  })
}

// Extension ids with an install currently in flight. Their folder carries the
// incomplete marker during setup — extensions:list must not report it as
// corrupted while the install is legitimately running.
const activeExtensionInstalls = new Set<string>()
const rmWithRetry = (path: string, label: string) =>
  removeExtensionWithRetry(path, label, logger)
const renameWithRetry = (from: string, to: string, label: string) =>
  renameExtensionWithRetry(from, to, label, logger)

export function setupIpcHandlers(pythonBridge: PythonBridge, getWindow: WindowGetter): void {
  type ActiveDownload = {
    progress: { percent: number; file?: string; fileIndex?: number; totalFiles?: number }
    done: Promise<void>
    finish: () => void
  }
  const activeDownloads = new Map<string, ActiveDownload>()
  // Logging from renderer
  ipcMain.on('log:error', (_event, message: string) => logger.error(`[Renderer] ${message}`))
  ipcMain.handle('log:getPath', () => join(app.getPath('userData'), 'logs', 'modly.log'))
  ipcMain.handle('log:readAll', async (_event, session?: string) => {
    const logsDir = join(app.getPath('userData'), 'logs')
    const dir = session ? join(logsDir, 'sessions', session) : logsDir
    const files = ['modly.log', 'errors.log', 'runtime.log']
    const result: Record<string, string> = {}
    for (const file of files) {
      try {
        const filePath = join(dir, file)
        result[file] = existsSync(filePath) ? await readFile(filePath, 'utf-8') : ''
      } catch {
        result[file] = ''
      }
    }
    return result
  })
  ipcMain.handle('log:listSessions', () => {
    const sessionsDir = join(app.getPath('userData'), 'logs', 'sessions')
    if (!existsSync(sessionsDir)) return []
    try {
      return readdirSync(sessionsDir)
        .filter(f => statSync(join(sessionsDir, f)).isDirectory())
        .sort()
        .reverse()
    } catch {
      return []
    }
  })

  // Window controls (frameless window)
  ipcMain.on('window:minimize', () => getWindow()?.minimize())
  ipcMain.on('window:maximize', () => {
    const win = getWindow()
    if (!win) return
    win.isMaximized() ? win.restore() : win.maximize()
  })
  ipcMain.on('window:close', () => getWindow()?.close())
  ipcMain.handle('window:isMaximized', () => getWindow()?.isMaximized() ?? false)

  // Setup handlers — skipped in dev (uses .venv instead of python-embed)
  ipcMain.handle('setup:check', async () => {
    const userData = app.getPath('userData')
    const defaultDataDir = join(app.getPath('documents'), 'Modly')
    return {
      needed: checkSetupNeeded(userData),
      defaultDataDir,
      platform: process.platform,
      arch: process.arch,
    }
  })

  ipcMain.handle('setup:saveDataDir', async (_event, { baseDir }: { baseDir: string }) => {
    const userData = app.getPath('userData')
    setSettings(userData, {
      modelsDir:        join(baseDir, 'models'),
      workspaceDir:     join(baseDir, 'workspace'),
      workflowsDir:     join(baseDir, 'workflows'),
      extensionsDir:    join(baseDir, 'extensions'),
      dependenciesDir:  join(baseDir, 'dependencies'),
    })
  })

  ipcMain.handle('setup:run', async () => {
    const userData = app.getPath('userData')
    const win = getWindow()
    if (!win) return { success: false, error: 'No window available' }
    try {
      await runFullSetup(win, userData)
      markSetupDone(userData)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // Python bridge
  ipcMain.handle('python:start', async () => {
    try {
      await pythonBridge.start()
      return { success: true, port: pythonBridge.getPort() }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('python:status', () => ({
    ready: pythonBridge.isReady(),
    apiUrl: API_BASE_URL
  }))

  // File system
  ipcMain.handle('fs:selectImage', async () => {
    const win = getWindow()
    if (!win) return null

    const result = await dialog.showOpenDialog(win, {
      title: 'Select an image',
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
      properties: ['openFile']
    })

    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('fs:selectMeshFile', async () => {
    const win = getWindow()
    if (!win) return null

    const result = await dialog.showOpenDialog(win, {
      title: 'Select a 3D mesh file',
      filters: [{ name: '3D Mesh', extensions: ['glb', 'obj', 'stl', 'ply', 'splat'] }],
      properties: ['openFile']
    })

    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('fs:saveModel', async (_, defaultName: string) => {
    const win = getWindow()
    if (!win) return null

    const result = await dialog.showSaveDialog(win, {
      title: 'Save 3D Model',
      defaultPath: defaultName,
      filters: [
        { name: 'OBJ', extensions: ['obj'] },
        { name: 'GLB', extensions: ['glb'] },
        { name: 'STL', extensions: ['stl'] }
      ]
    })

    return result.canceled ? null : result.filePath
  })

  ipcMain.handle('fs:savePath', async (_, args: { filters: { name: string; extensions: string[] }[]; defaultPath?: string }) => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showSaveDialog(win, {
      title:       'Choose output path',
      filters:     args.filters,
      defaultPath: args.defaultPath,
    })
    return result.canceled ? null : result.filePath
  })

  ipcMain.handle('model:unloadAll', async (): Promise<{ success: boolean; error?: string }> => {
    try {
      await axios.post(`${API_BASE_URL}/model/unload-all`, {}, { timeout: 10_000 })
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('model:delete', async (_, modelId: string): Promise<{ success: boolean; error?: string }> => {
    if (activeDownloads.has(modelId)) {
      return { success: false, error: 'Cannot remove model weights while their download is active' }
    }
    let modelDir: string
    try {
      await resolveInstalledModelDownloadPlan({
        modelId,
        userExtensionsDir: getSettings(app.getPath('userData')).extensionsDir,
        builtinExtensionsDir: getBuiltinExtensionsDir(),
        blockedExtensionIds: activeExtensionInstalls,
      })
      modelDir = resolveModelRoot(getSettings(app.getPath('userData')).modelsDir, modelId)
    } catch (err) {
      return { success: false, error: String(err) }
    }

    // Unload the model and wait for confirmation so file handles are released
    try {
      await axios.post(`${API_BASE_URL}/model/unload/${encodeURIComponent(modelId)}`, {}, { timeout: 10_000 })
      // Give the OS a moment to release file locks (Windows holds handles briefly after close)
      await new Promise(resolve => setTimeout(resolve, 1_500))
    } catch {
      // Unload failed (model may not be loaded) — still attempt deletion
    }

    // Retry removal — Windows may return EBUSY/EPERM if handles linger
    const removed = await rmWithRetry(modelDir, 'model-delete')
    if (removed.ok) return { success: true }
    return {
      success: false,
      error: removed.locked
        ? 'Model files are still locked after several attempts. Close any programs using the model and try again.'
        : String(removed.error),
    }
  })

  ipcMain.handle('model:showInFolder', (_, modelId: string) => {
    const modelDir = join(getSettings(app.getPath('userData')).modelsDir, modelId)
    if (existsSync(modelDir)) {
      shell.openPath(modelDir)
    }
  })

  // Read local file → base64 (bypasses file:// restrictions in the renderer)
  ipcMain.handle('fs:readFileBase64', async (_, filePath: string) => {
    if (typeof filePath !== 'string' || filePath.trim().length === 0) {
      throw new Error('fs:readFileBase64 requires a non-empty file path')
    }
    const buffer = await readFile(filePath)
    return buffer.toString('base64')
  })

  ipcMain.handle('fs:readScreenshotDataUrl', async (_, filename: string) => {
    const filePath = app.isPackaged
      ? join(process.resourcesPath, 'screenshots', filename)
      : join(app.getAppPath(), 'src/assets', filename)
    const buffer = await readFile(filePath)
    return `data:image/png;base64,${buffer.toString('base64')}`
  })

  // Model management
  ipcMain.handle('model:listDownloaded', () => {
    const modelsDir = getSettings(app.getPath('userData')).modelsDir
    return listDownloadedModels(modelsDir)
  })

  ipcMain.handle('model:isDownloaded', async (_, modelId: string): Promise<boolean> => {
    const modelsDir = getSettings(app.getPath('userData')).modelsDir
    try {
      const plan = await resolveInstalledModelDownloadPlan({
        modelId,
        userExtensionsDir: getSettings(app.getPath('userData')).extensionsDir,
        builtinExtensionsDir: getBuiltinExtensionsDir(),
        blockedExtensionIds: activeExtensionInstalls,
      })
      return plan.kind === 'multi-source'
        ? areModelSourcesDownloaded(modelsDir, modelId, plan.sources)
        : isModelDownloaded(modelsDir, modelId, plan.downloadCheck)
    } catch {
      return false
    }
  })

  ipcMain.handle('model:hasLocalData', async (_, modelId: string): Promise<boolean> => {
    try {
      await resolveInstalledModelDownloadPlan({
        modelId,
        userExtensionsDir: getSettings(app.getPath('userData')).extensionsDir,
        builtinExtensionsDir: getBuiltinExtensionsDir(),
        blockedExtensionIds: activeExtensionInstalls,
      })
      return modelHasLocalData(getSettings(app.getPath('userData')).modelsDir, modelId)
    } catch {
      return false
    }
  })

  ipcMain.handle('model:activeDownloads', () =>
    [...activeDownloads.entries()].map(([modelId, active]) => ({ modelId, ...active.progress }))
  )

  ipcMain.handle('model:download', async (
    event,
    modelId: string,
  ) => {
    if (activeDownloads.has(modelId)) {
      return { success: false, error: 'Download already in progress' }
    }
    let finish!: () => void
    const done = new Promise<void>((resolveDone) => { finish = resolveDone })
    const active: ActiveDownload = { progress: { percent: 0 }, done, finish }
    activeDownloads.set(modelId, active)
    try {
      const plan = await resolveInstalledModelDownloadPlan({
        modelId,
        userExtensionsDir: getSettings(app.getPath('userData')).extensionsDir,
        builtinExtensionsDir: getBuiltinExtensionsDir(),
        blockedExtensionIds: activeExtensionInstalls,
      })
      const onProgress = (progress: typeof active.progress) => {
        active.progress = progress
        event.sender.send('model:downloadProgress', { modelId, ...progress })
      }
      if (plan.kind === 'multi-source') {
        await downloadModelSourcesFromHF(modelId, plan.sources, onProgress)
      } else {
        await downloadModelFromHF(
          plan.repoId,
          modelId,
          onProgress,
          plan.skipPrefixes,
          plan.includePrefixes,
        )
      }
      return { success: true }
    } catch (err: any) {
      const message = err?.message ?? String(err)
      if (message.includes('paused')) {
        event.sender.send('model:downloadProgress', { modelId, percent: 0, status: 'paused', paused: true })
        return { success: false, paused: true }
      }
      if (message.includes('cancelled')) {
        event.sender.send('model:downloadProgress', { modelId, percent: 0, status: 'cancelled', cancelled: true })
        return { success: false, cancelled: true }
      }
      return { success: false, error: String(err) }
    } finally {
      if (activeDownloads.get(modelId) === active) activeDownloads.delete(modelId)
      active.finish()
    }
  })

  ipcMain.handle('model:pauseDownload', async (_, modelId: string): Promise<{ success: boolean; error?: string }> => {
    try {
      await axios.post(`${API_BASE_URL}/model/hf-download/pause`, null, {
        params: { model_id: modelId },
        timeout: 5000,
      })
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('model:cancelDownload', async (_, modelId: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const active = activeDownloads.get(modelId)
      await axios.post(`${API_BASE_URL}/model/hf-download/cancel`, null, {
        params: { model_id: modelId },
        timeout: 5000,
      })
      if (active) {
        await Promise.race([
          active.done,
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('Timed out waiting for the download to stop')), 30_000)
          }),
        ])
      }
      const modelDir = resolveModelRoot(getSettings(app.getPath('userData')).modelsDir, modelId)
      await rmAsync(modelDir, { recursive: true, force: true })
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // Export mesh to GLB / STL / OBJ
  ipcMain.handle('model:export', async (_, { outputUrl, format }: { outputUrl: string; format: string }) => {
    const win = getWindow()
    if (!win) return { success: false, error: 'No window' }

    const meshPath = outputUrl.replace(/^\/workspace\//, '')
    const baseName = meshPath.split('/').pop()?.replace(/\.\w+$/, '') ?? 'model'

    const result = await dialog.showSaveDialog(win, {
      title: 'Export 3D Model',
      defaultPath: `${baseName}.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    })
    if (result.canceled || !result.filePath) return { success: false }

    try {
      const response = await axios.get(
        `${API_BASE_URL}/export/${format}?path=${encodeURIComponent(meshPath)}`,
        { responseType: 'arraybuffer' }
      )
      await writeFile(result.filePath, Buffer.from(response.data as ArrayBuffer))
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // Shell
  ipcMain.handle('shell:openExternal', (_, url: string) => shell.openExternal(url))

  // App info
  // System memory (used/available/total bytes).
  // On macOS, matches Activity Monitor's "Memory Used":
  //     used = wired + active + compressed.
  ipcMain.handle('system:memory', async () => {
    const total = os.totalmem()

    if (process.platform === 'darwin') {
      try {
        const { stdout } = await pExecFile('vm_stat', [])
        const pageSizeMatch = stdout.match(/page size of (\d+) bytes/)
        const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1]!, 10) : 16384

        const pagesFor = (label: string): number => {
          const m = stdout.match(new RegExp(`${label}:\\s+(\\d+)`))
          return m ? parseInt(m[1]!, 10) : 0
        }

        const active = pagesFor('Pages active')
        const wired = pagesFor('Pages wired down')
        const compressed = pagesFor('Pages occupied by compressor')

        const used = (active + wired + compressed) * pageSize
        const available = Math.max(0, total - used)
        return { total, used, available }
      } catch {
        // Fall back to total - free outside Activity Monitor semantics.
      }
    }

    const free = os.freemem()
    return { total, used: total - free, available: free }
  })

  ipcMain.handle('app:info', () => ({
    version:   app.getVersion(),
    userData:  app.getPath('userData'),
    modelsDir: getSettings(app.getPath('userData')).modelsDir,
    apiUrl:    API_BASE_URL,
    platform:  process.platform,
    arch:      process.arch,
  }))

  // Settings — seed HF token into main-process env at startup
  {
    const initialToken = getSettings(app.getPath('userData')).hfToken ?? ''
    if (initialToken) {
      process.env['HUGGING_FACE_HUB_TOKEN'] = initialToken
      process.env['HF_TOKEN']               = initialToken
    }
  }

  ipcMain.handle('settings:get', () => {
    return getSettings(app.getPath('userData'))
  })

  ipcMain.handle('settings:set', async (_event, patch: { modelsDir?: string; workspaceDir?: string; extensionsDir?: string; hfToken?: string }) => {
    const updated = setSettings(app.getPath('userData'), patch)
    // Keep main-process env in sync so child processes spawned after token change inherit it
    if (patch.hfToken !== undefined) {
      process.env['HUGGING_FACE_HUB_TOKEN'] = patch.hfToken
      process.env['HF_TOKEN']               = patch.hfToken
      // Also push the token into the live FastAPI process env so extension
      // subprocesses spawned by ExtensionProcess._build_env() pick it up
      // without requiring a full app restart.
      try {
        await axios.post(`${API_BASE_URL}/settings/hf-token`, { token: patch.hfToken }, { timeout: 3000 })
      } catch { /* FastAPI may not be running yet — ignore */ }
    }
    return updated
  })

  // Directory picker
  ipcMain.handle('fs:selectDirectory', async (_event, defaultPath?: string) => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      ...(defaultPath && { defaultPath }),
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // Cache clear — deletes and recreates the gen-cache folder
  // NOTE: userData/cache (lowercase) = Chromium disk cache on Windows (case-insensitive)
  //       → use a dedicated subfolder to avoid collision
  ipcMain.handle('cache:clear', async () => {
    const cacheDir = join(app.getPath('userData'), 'gen-cache')
    try {
      if (existsSync(cacheDir)) {
        await rmAsync(cacheDir, { recursive: true, force: true })
      }
      await mkdir(cacheDir, { recursive: true })
      return { success: true }
    } catch (err) {
      console.error('[cache:clear] error:', err)
      return { success: false, error: String(err) }
    }
  })

  // Workspace filesystem-based persistence
  const workspacePath = (...parts: string[]) =>
    join(getSettings(app.getPath('userData')).workspaceDir, ...parts)

  registerWorkspaceAssetLibraryIpcHandlers({
    ipcMain,
    getWorkspaceDir: () => getSettings(app.getPath('userData')).workspaceDir,
  })

  ipcMain.handle('workspace:listCollections', async () => {
    const base = workspacePath()
    await mkdir(base, { recursive: true })
    const entries = await readdir(base, { withFileTypes: true })
    return entries.filter(e => e.isDirectory()).map(e => e.name)
  })

  ipcMain.handle('workspace:createCollection', async (_, name: string) => {
    await mkdir(workspacePath(name), { recursive: true })
  })

  ipcMain.handle('workspace:renameCollection', async (_, { oldName, newName }: { oldName: string; newName: string }) => {
    await rename(workspacePath(oldName), workspacePath(newName))
  })

  ipcMain.handle('workspace:deleteCollection', async (_, name: string) => {
    await rmAsync(workspacePath(name), { recursive: true, force: true })
  })

  ipcMain.handle('workspace:listJobs', async (_, collection: string) => {
    try {
      const files = await readdir(workspacePath(collection))
      const metas = files.filter(f => f.endsWith('.meta.json'))
      return Promise.all(metas.map(async f => {
        const raw = await readFile(workspacePath(collection, f), 'utf-8')
        return JSON.parse(raw)
      }))
    } catch { return [] }
  })

  ipcMain.handle('workspace:saveJobMeta', async (_, { collection, filename, meta }: { collection: string; filename: string; meta: unknown }) => {
    const metaFile = filename.replace(/\.glb$/, '.meta.json')
    await writeFile(workspacePath(collection, metaFile), JSON.stringify(meta, null, 2), 'utf-8')
  })

  ipcMain.handle('workspace:deleteJob', async (_, { collection, filename }: { collection: string; filename: string }) => {
    await rmAsync(workspacePath(collection, filename), { force: true })
    await rmAsync(workspacePath(collection, filename.replace(/\.glb$/, '.meta.json')), { force: true })
  })

  // Directory utilities for settings
  ipcMain.handle('fs:listDir', async (_, dirPath: string) => {
    try {
      const entries = await readdir(dirPath, { withFileTypes: true })
      return entries.filter(e => e.isDirectory()).map(e => e.name)
    } catch {
      return []
    }
  })

  // List files (not directories) in a folder, optionally filtered by extension.
  // `extensions` are lowercase without the dot (e.g. ['txt', 'png']).
  ipcMain.handle('fs:listFiles', async (_, dirPath: string, extensions?: string[]) => {
    try {
      const wanted = extensions?.map(e => e.toLowerCase().replace(/^\./, ''))
      const entries = await readdir(dirPath, { withFileTypes: true })
      return entries
        .filter(e => e.isFile())
        .map(e => e.name)
        .filter(name => {
          if (!wanted || wanted.length === 0) return true
          const ext = name.split('.').pop()?.toLowerCase() ?? ''
          return wanted.includes(ext)
        })
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    } catch {
      return []
    }
  })

  // Text-file picker for the standalone Load Prompt node.
  ipcMain.handle('fs:selectTextFile', async () => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: 'Select a prompt text file',
      filters: [{ name: 'Text', extensions: ['txt', 'md', 'prompt'] }],
      properties: ['openFile'],
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('fs:moveDirectory', async (_, { src, dest }: { src: string; dest: string }) => {
    try {
      await mkdir(dest, { recursive: true })
      await cp(src, dest, { recursive: true })
      await rmAsync(src, { recursive: true, force: true })
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('fs:deleteDirectory', async (_, dirPath: string) => {
    const userData = app.getPath('userData')
    const settings = getSettings(userData)
    const allowedRoots = [
      settings.modelsDir,
      settings.workspaceDir,
      settings.extensionsDir,
      join(userData, 'gen-cache'),
    ]
    const resolved = join(dirPath)
    const isAllowed = allowedRoots.some((root) => resolved.startsWith(root))
    if (!isAllowed) {
      return { success: false, error: 'Path is outside allowed directories' }
    }
    try {
      await rmAsync(resolved, { recursive: true, force: true })
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // Remote registry — list of trusted GitHub repo URLs
  const REGISTRY_URL = 'https://raw.githubusercontent.com/lightningpixel/modly-official-extension/main/registry.json'
  const REGISTRY_TTL = 5 * 60 * 1000 // 5 minutes

  let registryCache: { repos: Set<string>; fetchedAt: number } | null = null

  async function fetchTrustedRepos(): Promise<Set<string>> {
    const now = Date.now()
    if (registryCache && now - registryCache.fetchedAt < REGISTRY_TTL) {
      return registryCache.repos
    }
    try {
      const { net } = require('electron')
      const res = await net.fetch(REGISTRY_URL)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as { trusted_repos?: string[] }
      const repos = new Set(
        (data.trusted_repos ?? []).map((r: string) => r.toLowerCase().replace(/\/$/, ''))
      )
      registryCache = { repos, fetchedAt: now }
      return repos
    } catch {
      // Offline or fetch failed — keep previous cache, or empty
      return registryCache?.repos ?? new Set()
    }
  }

  function isTrustedSource(source: string | undefined, trustedRepos: Set<string>): boolean {
    if (!source) return false
    return trustedRepos.has(source.toLowerCase().replace(/\/$/, ''))
  }

  type ParsedManifest = {
    id?: string; name?: string; displayName?: string; version?: string
    description?: string; author?: string | { name?: string }
    source?: string; generator_class?: string
    // extension type
    type?:  'model' | 'process'
    entry?: string
    model_sources?: unknown
    // Optional top-level fallbacks — applied to each node if not set on the node
    params_schema?:  unknown[]
    param_defaults?: Record<string, unknown>
    nodes?: {
      id:                string
      name?:             string
      input?:            'mesh' | 'image' | 'text' | 'audio'
      inputs?:           ('mesh' | 'image' | 'text' | 'audio')[]
      input_labels?:     string[]
      output?:           'mesh' | 'image' | 'text' | 'audio'
      params_schema?:    unknown[]
      param_defaults?:   Record<string, unknown>
      hf_repo?:          string
      download_check?:   string
      hf_skip_prefixes?: string[]
      hf_include_prefixes?: string[]
      model_sources?: unknown
    }[]
  }

  function parseExtensionManifest(parsed: ParsedManifest, fallbackId: string, trustedRepos: Set<string>, builtin = false) {
    const common = {
      id:          parsed.id          ?? fallbackId,
      name:        parsed.displayName ?? parsed.name ?? fallbackId,
      version:     parsed.version,
      description: parsed.description,
      author:      typeof parsed.author === 'string' ? parsed.author : parsed.author?.name,
      trusted:     builtin || isTrustedSource(parsed.source, trustedRepos),
      source:      parsed.source,
      builtin,
    }

    if (parsed.model_sources !== undefined) {
      throw new Error('manifest.json: model_sources must be declared on a model node')
    }
    const nodes = (parsed.nodes ?? []).map(n => {
      if (parsed.type === 'process' && n.model_sources !== undefined) {
        throw new Error('manifest.json: model_sources is supported only for model nodes')
      }
      const modelSources = normalizeModelSources(n)
      return {
        id:             n.id,
        name:           n.name ?? n.id,
        input:          n.input  ?? 'image' as const,
        inputs:         n.inputs,
        inputLabels:    n.input_labels,
        output:         n.output ?? 'mesh'  as const,
        paramsSchema:   n.params_schema ?? parsed.params_schema ?? [],
        paramDefaults:  { ...(parsed.param_defaults ?? {}), ...(n.param_defaults ?? {}) },
        hfRepo:         n.hf_repo,
        downloadCheck:  n.download_check,
        hfSkipPrefixes: n.hf_skip_prefixes,
        hfIncludePrefixes: n.hf_include_prefixes,
        hasModelSources: modelSources !== undefined,
      }
    })

    if (parsed.type === 'process') {
      return { ...common, type: 'process' as const, entry: parsed.entry ?? 'processor.js', nodes }
    }

    return { ...common, type: 'model' as const, nodes }
  }

  async function reloadAndValidateModelExtension(
    manifest: ParsedManifest,
    extensionId: string,
    validationCapability?: ExtensionRegistrationValidationCapability,
  ): Promise<void> {
    const expectedIds = expectedModelIds({ ...manifest, id: extensionId })
    if (expectedIds.length === 0) return

    let payload: unknown
    try {
      const response = await axios.post(
        `${API_BASE_URL}/extensions/reload`,
        validationCapability ? { validationCapability } : {},
        { timeout: 10_000 },
      )
      payload = response.data
    } catch (err) {
      throw new Error(
        `Could not validate runtime registration for extension "${extensionId}": ${String(err)}`,
      )
    }
    validateExtensionReloadPayload(payload, extensionId, expectedIds)
  }

  async function quarantineModelExtensionRuntime(
    manifest: ParsedManifest,
    extensionId: string,
  ): Promise<void> {
    const forbiddenIds = expectedModelIds({ ...manifest, id: extensionId })
    if (forbiddenIds.length === 0) return

    let payload: unknown
    try {
      const response = await axios.post(
        `${API_BASE_URL}/extensions/reload`,
        {},
        { timeout: 10_000 },
      )
      payload = response.data
    } catch (err) {
      throw new Error(
        `Could not quarantine runtime registration for extension "${extensionId}": `
        + `${String(err)}`,
      )
    }
    validateExtensionQuarantinePayload(payload, extensionId, forbiddenIds)
  }

  async function rollbackFailedExtensionUpdate(
    extensionsDir: string,
    destinationDir: string,
    backupDir: string,
    extensionId: string,
    originalFailure: unknown,
  ): Promise<never> {
    const restored = await restoreExtensionBackup(destinationDir, backupDir, logger)
    if (!restored.ok) {
      throw new Error(
        `Extension update failed, and Modly could not restore the previous version `
        + `during ${restored.stage}: ${String(restored.error)}. `
        + `Restart Modly to retry recovery. Original failure: ${String(originalFailure)}`,
      )
    }

    const stateCleared = await clearExtensionRegistrationTransaction(
      extensionsDir,
      extensionId,
      logger,
    )
    if (!stateCleared.ok) {
      throw new Error(
        `Extension update failed and the previous version was restored, but Modly `
        + `could not clear recovery state during ${stateCleared.stage}: `
        + `${String(stateCleared.error)}. Original failure: ${String(originalFailure)}`,
      )
    }

    try {
      const previousManifest = JSON.parse(
        await readFile(join(destinationDir, 'manifest.json'), 'utf-8'),
      ) as ParsedManifest
      if (previousManifest.type !== 'process') {
        await reloadAndValidateModelExtension(previousManifest, extensionId)
      }
    } catch (reloadError) {
      throw new Error(
        `Extension update failed and the previous version was restored on disk, `
        + `but Modly could not reload it: ${String(reloadError)}. `
        + `Original failure: ${String(originalFailure)}`,
      )
    }

    throw new Error(
      `Extension update failed before runtime registration could be committed, `
      + `so the previous version was restored. `
      + `${String(originalFailure)}`,
    )
  }

  async function cleanupValidatedBackupsOrThrow(
    extensionsDir: string,
    extensionId: string,
  ): Promise<void> {
    const cleaned = await cleanupValidatedExtensionBackups(extensionsDir, extensionId, logger)
    if (!cleaned.ok) {
      throw new Error(
        `Runtime registration succeeded, but Modly could not finish removing the previous `
        + `extension backup during ${cleaned.stage}: ${String(cleaned.error)}. `
        + `Restart Modly to retry the validated cleanup.`,
      )
    }
  }

  // Extensions — reads user extensions directory + built-in extensions directory
  ipcMain.handle('extensions:list', async () => {
    const userData      = app.getPath('userData')
    const extensionsDir = getSettings(userData).extensionsDir
    const builtinDir    = getBuiltinExtensionsDir()

    const trustedRepos = await fetchTrustedRepos()

    async function readExtensionsFromDir(dir: string, isBuiltin: boolean) {
      if (!existsSync(dir)) return []
      try {
        const entries = await readdir(dir, { withFileTypes: true })
        const pendingRegistrationIds = new Set(
          isBuiltin
            ? []
            : entries
              .map((entry) => parseExtensionRegistrationPendingName(entry.name)?.extensionId)
              .filter((extensionId): extensionId is string => Boolean(extensionId)),
        )
        // On Windows, junction points are reported by Node.js as isSymbolicLink()=true,
        // isDirectory()=false. Use statSync (which follows links) as the authoritative check.
        const dirs = entries.filter(e => {
          // Staging/backup dirs are never extensions (ids can't start with '.')
          if (isInternalExtensionDirName(e.name)) return false
          if (e.isDirectory()) return true
          if (e.isSymbolicLink()) {
            try { return statSync(join(dir, e.name)).isDirectory() } catch { return false }
          }
          return false
        })
        const results = await Promise.all(dirs.map(async (entry) => {
          const entryPath = join(dir, entry.name)
          const skeleton  = { type: 'model' as const, id: entry.name, name: entry.name, trusted: isBuiltin, builtin: isBuiltin, nodes: [], corrupted: true }

          // A setup/registration marker still present means this folder is not
          // safe to expose. Hide it only while the current install owns it;
          // after a failed startup recovery, surface it as Repairable instead.
          const installInterrupted = (
            existsSync(join(entryPath, EXT_INCOMPLETE_MARKER))
            || existsSync(join(entryPath, EXT_REGISTRATION_PENDING_MARKER))
            || pendingRegistrationIds.has(entry.name)
          )
          if (installInterrupted && activeExtensionInstalls.has(entry.name)) return null

          // Detect local extensions: check for .modly-local sentinel
          let localSourcePath: string | undefined
          if (!isBuiltin) {
            const sentinelPath = join(entryPath, '.modly-local')
            if (existsSync(sentinelPath)) {
              try {
                localSourcePath = (await readFile(sentinelPath, 'utf-8')).trim()
              } catch { /* ignore */ }
            }
          }

          // 'missing' = no manifest at all (gutted folder); 'invalid' = a manifest
          // exists but doesn't parse (fixable by hand, don't push deletion only)
          let manifestError: 'missing' | 'invalid' = 'missing'
          for (const manifestFile of ['manifest.json', 'package.json']) {
            const p = join(entryPath, manifestFile)
            if (existsSync(p)) {
              try {
                const raw    = await readFile(p, 'utf-8')
                const parsed = JSON.parse(raw) as ParsedManifest
                // Inject local:// source so the UI shows the Local badge
                if (localSourcePath) parsed.source = `local://${localSourcePath}`
                const extension = parseExtensionManifest(
                  parsed,
                  entry.name,
                  trustedRepos,
                  isBuiltin,
                )
                return markExtensionInstallationInterrupted(extension, installInterrupted)
              } catch { manifestError = 'invalid' }
            }
          }
          return installInterrupted
            ? markExtensionInstallationInterrupted(skeleton, true)
            : { ...skeleton, manifestError }
        }))
        return results.filter((e): e is Exclude<typeof e, null> => e !== null)
      } catch {
        return []
      }
    }

    const [userExts, builtinExts] = await Promise.all([
      readExtensionsFromDir(extensionsDir, false),
      readExtensionsFromDir(builtinDir,    true),
    ])

    // Built-ins come first, then user extensions
    return [...builtinExts, ...userExts]
  })

  // Install an extension from a GitHub repo URL
  ipcMain.handle('extensions:installFromGitHub', async (event, githubUrl: string) => {
    const win    = getWindow()
    const emit   = (data: object) => win?.webContents.send('extensions:installProgress', data)
    const tmpDir = app.getPath('temp')

    let tarPath    = ''
    let extractDir = ''
    let trackedExtensionId = ''

    try {
      // 1. Parse and validate GitHub URL
      const parsed  = new URL(githubUrl.trim())
      if (parsed.hostname !== 'github.com') throw new Error('Invalid URL: must be a GitHub repository (github.com)')
      const parts = parsed.pathname.split('/').filter(Boolean)
      if (parts.length < 2) throw new Error('Invalid URL: expected format https://github.com/owner/repo')
      const [owner, repo] = parts

      emit({ step: 'downloading', percent: 0 })

      // 2. Download tarball via GitHub API
      const tarballUrl = `https://api.github.com/repos/${owner}/${repo}/tarball/HEAD`
      tarPath    = join(tmpDir, `modly-ext-${Date.now()}.tar.gz`)
      extractDir = join(tmpDir, `modly-ext-extract-${Date.now()}`)

      const response = await axios.get(tarballUrl, {
        responseType: 'arraybuffer',
        headers: {
          'Accept':     'application/vnd.github.v3+json',
          'User-Agent': 'Modly-App',
        },
        onDownloadProgress: (evt) => {
          const pct = evt.total ? Math.round((evt.loaded / evt.total) * 80) : 40
          emit({ step: 'downloading', percent: pct })
        },
      })

      await writeFile(tarPath, Buffer.from(response.data as ArrayBuffer))

      // 3. Extract tarball (GitHub wraps contents in a top-level {owner}-{repo}-{sha}/ folder)
      emit({ step: 'extracting' })
      await mkdir(extractDir, { recursive: true })
      await tar.x({ file: tarPath, cwd: extractDir, strip: 1 })

      // 4. Validate manifest.json
      emit({ step: 'validating' })
      const manifestPath = join(extractDir, 'manifest.json')

      if (!existsSync(manifestPath)) throw new Error('manifest.json missing from repository')

      const manifestRaw = await readFile(manifestPath, 'utf-8')
      const manifest    = JSON.parse(manifestRaw) as ParsedManifest

      const { id: rawManifestId, isProcess, entryFile, isPythonProcess, hasNodes } = validateInstallManifest(
        manifest,
        {
          hasEntryFile: (candidate) => existsSync(join(extractDir, candidate)),
          hasGeneratorFile: () => existsSync(join(extractDir, 'generator.py')),
        },
        'repository',
      )
      if (!hasNodes) throw new Error('manifest.json: required field "nodes" missing or empty')
      const extensionId = assertSafeExtensionId(rawManifestId)
      manifest.id = extensionId
      trackedExtensionId = extensionId
      activeExtensionInstalls.add(extensionId)

      // Override source field with the actual GitHub URL so trust is based on origin
      manifest.source = `https://github.com/${owner}/${repo}`
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')

      // 5. Stage into a fresh, unique dir next to the final location (so a new
      //    attempt can never merge into leftovers of a previous one), mark it
      //    incomplete, and swap it in with atomic renames BEFORE the long setup
      //    phase. setup.py then runs in the final path — venvs record absolute
      //    paths, so the folder must not move after setup. If anything dies
      //    mid-way, the marker + backup let the startup reconciler put the
      //    previous version back.
      const extensionsDir = getSettings(app.getPath('userData')).extensionsDir
      await mkdir(extensionsDir, { recursive: true })
      const installSuffix = String(Date.now())
      const destDir    = resolveExtensionPathWithinRoot(extensionsDir, extensionId)
      const stagingDir = buildExtensionStagingPath(extensionsDir, extensionId, installSuffix)

      if (existsSync(destDir)) {
        const currentManifestPath = join(destDir, 'manifest.json')
        let currentManifestJson: string
        try {
          currentManifestJson = await readFile(currentManifestPath, 'utf-8')
        } catch (error) {
          throw new Error(
            `Cannot safely replace extension "${extensionId}" because its existing `
            + `manifest.json is missing or unreadable. Uninstall it first. ${String(error)}`,
          )
        }
        validateExistingExtensionReplacement(
          currentManifestJson,
          manifest,
          {
            hasEntryFile: (candidate) => existsSync(join(destDir, candidate)),
            hasGeneratorFile: () => existsSync(join(destDir, 'generator.py')),
          },
          'existing extension folder',
        )
      }

      try {
        await cp(extractDir, stagingDir, { recursive: true })
        // Reserved recovery files are host-owned transaction state, never
        // repository content. Strip packaged/stale copies before activation.
        await rmAsync(
          join(stagingDir, EXT_REGISTRATION_PENDING_MARKER),
          { recursive: true, force: true },
        )
        await rmAsync(
          join(stagingDir, EXT_VALIDATED_MARKER),
          { recursive: true, force: true },
        )
        await writeFile(join(stagingDir, EXT_INCOMPLETE_MARKER), new Date().toISOString(), 'utf-8')

        // Compile TypeScript entry to JS at install time (once, no runtime overhead)
        if (isProcess && entryFile.endsWith('.ts')) {
          emit({ step: 'setting_up', message: 'Compiling TypeScript entry…' })
          const compiledEntry = entryFile.replace(/\.ts$/, '.js')
          buildSync({
            entryPoints: [join(stagingDir, entryFile)],
            outfile:     join(stagingDir, compiledEntry),
            bundle:      true,
            platform:    'node',
            format:      'cjs',
            external:    ['electron'],
          })
          manifest.entry = compiledEntry
          await writeFile(join(stagingDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8')
        }
      } catch (stageErr) {
        await rmWithRetry(stagingDir, 'ext-install')
        throw stageErr
      }

      // 6. Swap into place (backup the previous version first)
      terminateProcessRunner(extensionId)
      const backupDir = existsSync(destDir)
        ? buildExtensionBackupPath(extensionsDir, extensionId, installSuffix)
        : null
      if (backupDir) {
        const parked = await renameWithRetry(destDir, backupDir, 'ext-install')
        if (!parked.ok) {
          await rmWithRetry(stagingDir, 'ext-install')
          throw new Error('The current extension folder is locked (antivirus or a running process) — close what might be using it and try again.')
        }
      }
      const activated = await renameWithRetry(stagingDir, destDir, 'ext-install')
      if (!activated.ok) {
        await rmWithRetry(stagingDir, 'ext-install')
        if (backupDir) await renameWithRetry(backupDir, destDir, 'ext-install')
        throw new Error('Could not move the staged extension into place — the folder is locked. Try again.')
      }

      // Persist transaction state beside extension folders, never inside a
      // destination or backup that may be a symlink to developer source.
      const pending = await beginExtensionRegistrationTransaction(
        extensionsDir,
        extensionId,
        installSuffix,
        logger,
      )
      if (!pending.ok) {
        if (backupDir) {
          await rollbackFailedExtensionUpdate(
            extensionsDir,
            destDir,
            backupDir,
            extensionId,
            `Could not mark the update as pending: ${String(pending.error)}`,
          )
        } else {
          await rmWithRetry(destDir, 'ext-install')
        }
        throw new Error(`Could not mark extension registration as pending: ${String(pending.error)}`)
      }

      // 7. Setup runs in the final folder; a failure restores the previous version
      try {
        if (isPythonProcess) {
          // 7a. Python process extension: run setup.py if present (same as model extensions)
          if (existsSync(join(destDir, 'setup.py'))) {
            emit({ step: 'setting_up', message: 'Setting up Python environment…' })
            const { sm: gpuSm, cudaVersion } = await detectGpuInfo()
            await runExtensionSetup(destDir, gpuSm, cudaVersion, (line) => {
              logger.info(`[ext-setup] ${line}`)
              emit({ step: 'setting_up', message: line })
            })
          }
        } else if (isProcess) {
          // 7b. JS process extension: npm install if package.json present
          if (existsSync(join(destDir, 'package.json'))) {
            emit({ step: 'setting_up', message: 'Installing dependencies…' })
            await new Promise<void>((resolve, reject) => {
              const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
              const child = spawn(npm, ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts=false'], {
                cwd:   destDir,
                stdio: 'pipe',
              })
              let buf = ''
              const onData = (chunk: Buffer) => {
                buf += chunk.toString()
                const lines = buf.split('\n')
                buf = lines.pop() ?? ''
                for (const raw of lines) {
                  const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim()
                  if (line) emit({ step: 'setting_up', message: line })
                }
              }
              child.stdout?.on('data', onData)
              child.stderr?.on('data', onData)
              child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`npm install failed (exit ${code})`)))
              child.on('error', reject)
            })
          }
        } else {
          // 7c. Model extension: run setup.py directly (no FastAPI required)
          if (existsSync(join(destDir, 'setup.py'))) {
            emit({ step: 'setting_up', message: 'Setting up Python environment…' })
            const { sm: gpuSm, cudaVersion } = await detectGpuInfo()
            await runExtensionSetup(destDir, gpuSm, cudaVersion, (line) => {
              logger.info(`[ext-setup] ${line}`)
              emit({ step: 'setting_up', message: line })
            })
          }
        }
      } catch (setupErr) {
        // Discard the half-set-up folder and put the previous version back. If
        // the folder is locked, the marker keeps it flagged corrupted and the
        // startup reconciler restores the backup on next launch.
        if (backupDir) {
          const restored = await restoreExtensionBackup(destDir, backupDir, logger)
          if (!restored.ok) {
            throw new Error(
              `Extension setup failed, and Modly could not restore the previous version `
              + `during ${restored.stage}: ${String(restored.error)}. `
              + `Restart Modly to retry recovery. Original failure: ${String(setupErr)}`,
            )
          }
          const cleared = await clearExtensionRegistrationTransaction(
            extensionsDir,
            extensionId,
            logger,
          )
          if (!cleared.ok) {
            throw new Error(
              `Extension setup failed and the previous version was restored, but Modly `
              + `could not clear recovery state during ${cleared.stage}: ${String(cleared.error)}.`,
            )
          }
        } else {
          const removed = await rmWithRetry(destDir, 'ext-install')
          if (removed.ok) {
            const cleared = await clearExtensionRegistrationTransaction(
              extensionsDir,
              extensionId,
              logger,
            )
            if (!cleared.ok) {
              throw new Error(
                `Extension setup failed and its incomplete folder was removed, but Modly `
                + `could not clear recovery state during ${cleared.stage}: ${String(cleared.error)}.`,
              )
            }
          }
        }
        throw setupErr
      }

      // 8. Setup succeeded. Root-level transaction state remains pending while
      //    the new destination is explicitly validated. A crash or failure in
      //    this window restores a backup or quarantines a fresh destination.
      try {
        await validateExtensionDestinationRegistration(
          destDir,
          async () => {
            if (!isProcess) {
              await reloadAndValidateModelExtension(
                manifest,
                extensionId,
                pending.validationCapability,
              )
            }
          },
          'ext-install',
          logger,
        )
      } catch (registrationError) {
        if (backupDir) {
          await rollbackFailedExtensionUpdate(
            extensionsDir,
            destDir,
            backupDir,
            extensionId,
            registrationError,
          )
        } else {
          const quarantined = await quarantineExtensionRegistrationFailure(
            extensionsDir,
            extensionId,
            logger,
          )
          if (!quarantined.ok) {
            throw new Error(
              `Runtime registration failed, and Modly could not quarantine the extension `
              + `during ${quarantined.stage}: ${String(quarantined.error)}. `
              + `Restart Modly to retry recovery. Original failure: ${String(registrationError)}`,
            )
          }
          if (!isProcess) {
            try {
              await quarantineModelExtensionRuntime(manifest, extensionId)
            } catch (runtimeQuarantineError) {
              throw new Error(
                `Runtime registration failed and filesystem quarantine was preserved, `
                + `but Modly could not evict partially registered model state: `
                + `${String(runtimeQuarantineError)}. `
                + `Original failure: ${String(registrationError)}`,
              )
            }
          }
        }
        throw registrationError
      }

      // Runtime validation passed. Mark cleanup as validated before deleting
      // rollback copies so startup can safely retry an interrupted deletion.
      await cleanupValidatedBackupsOrThrow(extensionsDir, extensionId)

      emit({ step: 'done', extensionId })

      const trustedRepos = await fetchTrustedRepos()
      const ext = parseExtensionManifest(manifest, extensionId, trustedRepos)
      return { success: true, extensionId, extension: ext }

    } catch (err) {
      emit({ step: 'error', message: String(err) })
      return { success: false, error: String(err) }
    } finally {
      if (trackedExtensionId) activeExtensionInstalls.delete(trackedExtensionId)
      // Cleanup temp files
      if (tarPath    && existsSync(tarPath))    rmAsync(tarPath,    { force: true }).catch(() => {})
      if (extractDir && existsSync(extractDir)) rmAsync(extractDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  // Uninstall an extension — built-ins cannot be uninstalled
  ipcMain.handle('extensions:uninstall', async (_, extensionId: string) => {
    try {
      if ([...activeDownloads.keys()].some((modelId) => modelId.split('/', 1)[0] === extensionId)) {
        return { success: false, error: 'Cannot uninstall an extension while its model download is active' }
      }
      // Corrupted folders can carry arbitrary names (manual copies, failed
      // unzips), so only enforce root confinement for the deletion path. The
      // strict id pattern still guards the built-in check — a non-conforming
      // name can never be a built-in.
      const extensionsDir = getSettings(app.getPath('userData')).extensionsDir

      try {
        const safeExtensionId = assertSafeExtensionId(extensionId)
        if (existsSync(resolveExtensionPathWithinRoot(getBuiltinExtensionsDir(), safeExtensionId))) {
          return { success: false, error: `"${safeExtensionId}" is a built-in extension and cannot be uninstalled.` }
        }
      } catch { /* non-conforming folder name → not a built-in */ }

      // Terminate process runner if it's a process extension
      terminateProcessRunner(extensionId)

      const removed = await removeExtensionWithBackups(
        extensionsDir,
        String(extensionId),
        logger,
      )
      if (!removed.ok) {
        return {
          success: false,
          error: removed.locked
            ? `Could not delete the extension ${removed.stage === 'backup' ? 'backup' : 'folder'} `
              + '— a file inside it is locked (antivirus or a running process). '
              + 'Close what might be using it and try again.'
            : `Could not uninstall the extension during ${removed.stage}: ${String(removed.error)}`,
        }
      }
      // Hot-reload Python so it stops using the deleted model extension
      try {
        await axios.post(`${API_BASE_URL}/extensions/reload`, {}, { timeout: 10_000 })
      } catch { /* ignore if Python is not running */ }
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // Re-run setup.py for a model extension (creates the venv if missing)
  ipcMain.handle('extensions:repair', async (_, extensionId: string) => {
    try {
      const safeExtensionId = assertSafeExtensionId(extensionId)
      const extensionsDir = getSettings(app.getPath('userData')).extensionsDir
      const extDir = resolveExtensionPathWithinRoot(extensionsDir, safeExtensionId)
      if (!existsSync(join(extDir, 'setup.py'))) {
        return { success: false, error: 'setup.py is missing from the extension folder — the install looks incomplete. Uninstall the extension and install it again.' }
      }
      const manifestRaw = await readFile(join(extDir, 'manifest.json'), 'utf-8')
      const manifest = JSON.parse(manifestRaw) as ParsedManifest
      const { isProcess } = validateInstallManifest(
        manifest,
        {
          hasEntryFile: (candidate) => existsSync(join(extDir, candidate)),
          hasGeneratorFile: () => existsSync(join(extDir, 'generator.py')),
        },
        'extension folder',
      )
      const { sm: gpuSm, cudaVersion } = await detectGpuInfo()
      await runExtensionRepairTransaction(
        {
          extensionsDir,
          extensionId: safeExtensionId,
          destinationDir: extDir,
          suffix: String(Date.now()),
          quarantine: async () => {
            terminateProcessRunner(safeExtensionId)
            if (!isProcess) {
              await quarantineModelExtensionRuntime(manifest, safeExtensionId)
            }
          },
          setup: () => runExtensionSetup(
            extDir,
            gpuSm,
            cudaVersion,
            (line) => logger.info(`[ext-repair] ${line}`),
          ),
          validate: async (validationCapability) => {
            if (!isProcess) {
              await reloadAndValidateModelExtension(
                manifest,
                safeExtensionId,
                validationCapability,
              )
            }
          },
        },
        logger,
      )
      return { success: true }
    } catch (err: any) {
      return { success: false, error: `Repair failed: ${err?.message ?? err}` }
    }
  })

  // Install a local extension by creating a symlink/junction to a local folder
  ipcMain.handle('extensions:installFromLocal', async () => {
    const win  = getWindow()
    const emit = (data: object) => win?.webContents.send('extensions:installProgress', data)

    // 1. Open folder picker
    const pickResult = await dialog.showOpenDialog(win!, {
      title:      'Select local extension folder',
      properties: ['openDirectory'],
    })
    if (pickResult.canceled || pickResult.filePaths.length === 0) {
      return { success: false, cancelled: true }
    }
    const localPath = pickResult.filePaths[0]

    try {
      emit({ step: 'validating' })

      // 2. Read and validate manifest.json
      const manifestPath = join(localPath, 'manifest.json')
      if (!existsSync(manifestPath)) {
        throw new Error('manifest.json not found in the selected folder')
      }
      const manifestRaw = await readFile(manifestPath, 'utf-8')
      const manifest    = JSON.parse(manifestRaw) as ParsedManifest

      const { id: rawManifestId, isProcess } = validateInstallManifest(
        manifest,
        {
          hasEntryFile:     (candidate) => existsSync(join(localPath, candidate)),
          hasGeneratorFile: ()          => existsSync(join(localPath, 'generator.py')),
        },
        'local folder',
      )
      const extensionId = assertSafeExtensionId(rawManifestId)

      // 3. Create symlink / junction in extensionsDir
      const userData      = app.getPath('userData')
      const extensionsDir = getSettings(userData).extensionsDir
      await mkdir(extensionsDir, { recursive: true })

      const linkPath = resolveExtensionPathWithinRoot(extensionsDir, extensionId)
      const installSuffix = String(Date.now())
      let backupDir: string | null = null

      // Inspect an existing local link without mutating it. The host-side
      // pending transaction is created before the link is ever parked or
      // replaced, so a crash cannot expose the new target as validated.
      if (existsSync(linkPath)) {
        const currentManifestPath = join(linkPath, 'manifest.json')
        if (!existsSync(currentManifestPath)) {
          throw new Error(
            `Cannot safely replace local extension "${extensionId}" because its existing `
            + 'manifest.json is missing. Uninstall it first.',
          )
        }
        const currentManifest = JSON.parse(
          await readFile(currentManifestPath, 'utf-8'),
        ) as ParsedManifest
        assertCompatibleExtensionUpdateType(currentManifest, manifest)

        const linkStat = await lstat(linkPath)
        if (!linkStat.isSymbolicLink() && !(process.platform === 'win32' && linkStat.isDirectory())) {
          throw new Error(
            `A non-symlink folder named "${extensionId}" already exists in `
            + 'extensionsDir. Remove it first.',
          )
        }
        backupDir = buildExtensionBackupPath(extensionsDir, extensionId, installSuffix)
      }

      const trustedRepos = await fetchTrustedRepos()
      // Build manifest with localPath marker so the UI can identify local extensions
      const annotatedManifest = { ...manifest, source: `local://${localPath}` }
      const ext = parseExtensionManifest(annotatedManifest, extensionId, trustedRepos)

      try {
        await runExtensionRegistrationValidationTransaction(
          {
            extensionsDir,
            extensionId,
            suffix: installSuffix,
            quarantine: async () => {
              terminateProcessRunner(extensionId)
              if (!isProcess) {
                await quarantineModelExtensionRuntime(manifest, extensionId)
              }
            },
            activate: async () => {
              emit({ step: 'setting_up', message: 'Linking local folder…' })
              if (backupDir) {
                const parked = await renameWithRetry(linkPath, backupDir, 'ext-local')
                if (!parked.ok) {
                  throw new Error(
                    `Could not preserve the previous local extension: `
                    + `${String(parked.error)}`,
                  )
                }
              }

              if (process.platform === 'win32') {
                // Windows: junction (no elevation needed, works for directories)
                await symlink(localPath, linkPath, 'junction')
              } else {
                // macOS / Linux: standard symlink
                await symlink(localPath, linkPath)
              }

              // The sentinel lives in the linked source folder. Runtime
              // registration is still pending externally until validation.
              await writeFile(join(linkPath, '.modly-local'), localPath, 'utf-8')
            },
            validate: async (validationCapability) => {
              if (!isProcess) {
                await reloadAndValidateModelExtension(
                  manifest,
                  extensionId,
                  validationCapability,
                )
              }
            },
          },
          logger,
        )
      } catch (err) {
        if (backupDir && existsSync(backupDir)) {
          await rollbackFailedExtensionUpdate(
            extensionsDir,
            linkPath,
            backupDir,
            extensionId,
            err,
          )
        }

        // Local links intentionally do not run setup. A fresh model that
        // cannot register remains linked, externally quarantined, and visible
        // only as a Repairable entry.
        if (!isProcess && existsSync(linkPath)) {
          const error = (
            `The local extension was linked, but it is not runtime-ready. `
            + `Click 'Repair' on its extension card, then retry. ${String(err)}`
          )
          emit({ step: 'error', extensionId, message: error })
          return {
            success: false,
            needsRepair: true,
            error,
            extensionId,
            extension: markExtensionInstallationInterrupted(ext, true),
            localPath,
          }
        }
        throw err
      }

      emit({ step: 'done', extensionId })
      return { success: true, extensionId, extension: ext, localPath }

    } catch (err) {
      emit({ step: 'error', message: String(err) })
      return { success: false, error: String(err) }
    }
  })

  // Trigger Python extension reload (without touching the filesystem)
  ipcMain.handle('extensions:reload', async () => {
    terminateAllProcessRunners()
    try {
      const res = await axios.post(`${API_BASE_URL}/extensions/reload`, {}, { timeout: 10_000 })
      return { success: true, errors: (res.data as { errors?: Record<string, string> }).errors ?? {} }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // Run a process extension in an isolated worker thread
  ipcMain.handle('extensions:runProcess', async (_, extensionId: string, input: { filePath?: string; text?: string; texts?: (string | undefined)[]; nodeId?: string }, params: Record<string, unknown>) => {
    const userData        = app.getPath('userData')
    const { extensionsDir, workspaceDir } = getSettings(userData)

    // Resolve extension directory: check built-ins first, then user extensions
    const builtinExtDir = join(getBuiltinExtensionsDir(), extensionId)
    const userExtDir    = join(extensionsDir, extensionId)
    const extDir        = existsSync(builtinExtDir) ? builtinExtDir : userExtDir

    if (!existsSync(extDir)) return { success: false, error: `Extension "${extensionId}" not found` }

    try {
      const manifestRaw = await readFile(join(extDir, 'manifest.json'), 'utf-8')
      const manifest    = JSON.parse(manifestRaw) as ParsedManifest
      if (manifest.type !== 'process') return { success: false, error: `Extension "${extensionId}" is not a process extension` }

      const entry           = manifest.entry ?? 'processor.js'
      const isPythonEntry   = entry.endsWith('.py')
      const userData        = app.getPath('userData')

      let runner
      if (isPythonEntry) {
        const pythonExe = getExtPythonExe(extDir) ?? getVenvPythonExe(userData)
        runner = getPythonProcessRunner(extensionId, pythonExe, extDir, entry, workspaceDir, app.getPath('temp'))
      } else {
        runner = getProcessRunner(extensionId, extDir, entry, workspaceDir, app.getPath('temp'))
      }

      const result = await runner.run(input, params)
      return { success: true, result }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // Terminate all process runners on app quit
  app.on('before-quit', () => terminateAllProcessRunners())

  // Auto-updater
  ipcMain.handle('updater:check', async () => {
    if (!app.isPackaged || !updatesSupported) return { success: false }
    try {
      await autoUpdater.checkForUpdates()
      return { success: true }
    } catch (err) {
      logger.error(`[updater:check] ${err}`)
      return { success: false }
    }
  })

  ipcMain.handle('updater:quitAndInstall', () => {
    if (!updatesSupported) return
    app.removeAllListeners('window-all-closed')
    BrowserWindow.getAllWindows().forEach(w => w.destroy())
    autoUpdater.quitAndInstall(true, true)
  })

  // Update FastAPI paths at runtime (without restarting)
  ipcMain.handle('api:updatePaths', async (_event, patch: { modelsDir?: string; workspaceDir?: string; extensionsDir?: string }) => {
    try {
      await axios.post(`${API_BASE_URL}/settings/paths`, {
        models_dir:     patch.modelsDir,
        workspace_dir:  patch.workspaceDir,
        extensions_dir: patch.extensionsDir,
      })
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ── Workflows ────────────────────────────────────────────────────────────

  function workflowsDir(): string {
    const dir = getSettings(app.getPath('userData')).workflowsDir
    if (!existsSync(dir)) require('fs').mkdirSync(dir, { recursive: true })
    return dir
  }

  ipcMain.handle('workflows:list', async () => {
    const dir = workflowsDir()
    const files = readdirSync(dir).filter(f => f.endsWith('.json'))
    const workflows = []
    for (const file of files) {
      try {
        const raw = await readFile(join(dir, file), 'utf-8')
        workflows.push(JSON.parse(raw))
      } catch { /* skip corrupted files */ }
    }
    return workflows.sort((a: { updatedAt?: string }, b: { updatedAt?: string }) =>
      (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
    )
  })

  ipcMain.handle('workflows:save', async (_, workflow: { id: string; [key: string]: unknown }) => {
    try {
      const path = join(workflowsDir(), `${workflow.id}.json`)
      await writeFile(path, JSON.stringify(workflow, null, 2), 'utf-8')
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('workflows:delete', async (_, id: string) => {
    try {
      await rmAsync(join(workflowsDir(), `${id}.json`), { force: true })
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('workflows:import', async () => {
    const win = getWindow()
    const result = await dialog.showOpenDialog(win!, {
      title: 'Import Workflow',
      filters: [{ name: 'Workflow', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (result.canceled || result.filePaths.length === 0) return { success: false }
    try {
      const raw = await readFile(result.filePaths[0], 'utf-8')
      const workflow = JSON.parse(raw)
      if (!workflow.id || !workflow.nodes) return { success: false, error: 'Invalid workflow file' }
      await writeFile(join(workflowsDir(), `${workflow.id}.json`), JSON.stringify(workflow, null, 2), 'utf-8')
      return { success: true, workflow }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('workflows:export', async (_, workflow: { id: string; name?: string; [key: string]: unknown }) => {
    const win = getWindow()
    const result = await dialog.showSaveDialog(win!, {
      title: 'Export Workflow',
      defaultPath: `${workflow.name ?? workflow.id}.json`,
      filters: [{ name: 'Workflow', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return { success: false }
    try {
      await writeFile(result.filePath, JSON.stringify(workflow, null, 2), 'utf-8')
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })
}

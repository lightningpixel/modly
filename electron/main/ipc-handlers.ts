import { ipcMain, BrowserWindow, dialog, app } from 'electron'
import { join } from 'path'
import { rm as rmAsync, readFile, writeFile, mkdir, readdir, rename, cp } from 'fs/promises'
import { existsSync } from 'fs'
import axios from 'axios'
import tar from 'tar'
import { PythonBridge, API_BASE_URL } from './python-bridge'
import {
  isModelDownloaded,
  listDownloadedModels,
  downloadModelFromHF,
} from './model-downloader'
import { getSettings, setSettings } from './settings-store'
import { checkSetupNeeded, markSetupDone, runFullSetup } from './python-setup'
import { logger } from './logger'

type WindowGetter = () => BrowserWindow | null

export function setupIpcHandlers(pythonBridge: PythonBridge, getWindow: WindowGetter): void {
  // Logging from renderer
  ipcMain.on('log:error', (_event, message: string) => logger.error(`[Renderer] ${message}`))
  ipcMain.handle('log:getPath', () => join(app.getPath('userData'), 'logs', 'modly.log'))

  // Window controls (frameless window)
  ipcMain.on('window:minimize', () => getWindow()?.minimize())
  ipcMain.on('window:maximize', () => {
    const win = getWindow()
    if (!win) return
    win.isMaximized() ? win.restore() : win.maximize()
  })
  ipcMain.on('window:close', () => getWindow()?.close())

  // Setup handlers — skipped in dev (uses .venv instead of python-embed)
  ipcMain.handle('setup:check', async () => {
    const defaultDataDir = join(app.getPath('documents'), 'LocalMeshy')
    if (!app.isPackaged) return { needed: false, defaultDataDir }
    const userData = app.getPath('userData')
    return { needed: checkSetupNeeded(userData), defaultDataDir }
  })

  ipcMain.handle('setup:saveDataDir', async (_event, { baseDir }: { baseDir: string }) => {
    const userData = app.getPath('userData')
    setSettings(userData, {
      modelsDir:        join(baseDir, 'models'),
      workspaceDir:     join(baseDir, 'workspace'),
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

  ipcMain.handle('model:delete', async (_, modelId: string): Promise<{ success: boolean; error?: string }> => {
    const modelDir = join(getSettings(app.getPath('userData')).modelsDir, modelId)
    try {
      await axios.post(`${API_BASE_URL}/model/unload/${encodeURIComponent(modelId)}`, {}, { timeout: 5000 })
    } catch {
      // unload is best-effort — proceed with deletion anyway
    }
    try {
      await rmAsync(modelDir, { recursive: true, force: true })
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // Read local file → base64 (bypasses file:// restrictions in the renderer)
  ipcMain.handle('fs:readFileBase64', async (_, filePath: string) => {
    const buffer = await readFile(filePath)
    return buffer.toString('base64')
  })

  // Model management
  ipcMain.handle('model:listDownloaded', () => {
    const modelsDir = getSettings(app.getPath('userData')).modelsDir
    return listDownloadedModels(modelsDir)
  })

  ipcMain.handle('model:isDownloaded', (_, modelId: string): boolean => {
    const modelsDir = getSettings(app.getPath('userData')).modelsDir
    return isModelDownloaded(modelsDir, modelId)
  })

  ipcMain.handle('model:download', async (event, { repoId, modelId }: { repoId: string; modelId: string }) => {
    try {
      await downloadModelFromHF(repoId, modelId, (pct) => {
        event.sender.send('model:downloadProgress', { modelId, percent: pct })
      })
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

  // App info
  ipcMain.handle('app:info', () => ({
    version:   app.getVersion(),
    userData:  app.getPath('userData'),
    modelsDir: getSettings(app.getPath('userData')).modelsDir,
    apiUrl:    API_BASE_URL
  }))

  // Settings
  ipcMain.handle('settings:get', () => {
    return getSettings(app.getPath('userData'))
  })

  ipcMain.handle('settings:set', (_event, patch: { modelsDir?: string; workspaceDir?: string; extensionsDir?: string }) => {
    return setSettings(app.getPath('userData'), patch)
  })

  // Directory picker
  ipcMain.handle('fs:selectDirectory', async () => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
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
  const REGISTRY_URL = 'https://raw.githubusercontent.com/liightnig125/modly-official-extension/main/registry.json'
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
    hf_repo?: string; source?: string; generator_class?: string
    model?:  { repoId?: string; modelId?: string }
    models?: { id?: string; name?: string; hf_repo?: string; description?: string }[]
  }

  function parseExtensionManifest(parsed: ParsedManifest, fallbackId: string, trustedRepos: Set<string>) {
    let models: { id: string; name: string; repoId: string; description?: string }[] = []
    if (parsed.models?.length) {
      models = parsed.models
        .filter(v => v.hf_repo && v.id)
        .map(v => ({ id: v.id!, name: v.name ?? v.id!, repoId: v.hf_repo!, description: v.description }))
    } else {
      const repoId  = parsed.model?.repoId ?? parsed.hf_repo
      const modelId = parsed.model?.modelId ?? parsed.id ?? fallbackId
      if (repoId) models = [{ id: modelId, name: modelId, repoId }]
    }
    return {
      id:          parsed.id          ?? fallbackId,
      name:        parsed.displayName ?? parsed.name ?? fallbackId,
      version:     parsed.version,
      description: parsed.description,
      author:      typeof parsed.author === 'string' ? parsed.author : parsed.author?.name,
      models,
      trusted:     isTrustedSource(parsed.source, trustedRepos),
      source:      parsed.source,
    }
  }

  // Extensions — reads configured extensions directory
  ipcMain.handle('extensions:list', async () => {
    const extensionsDir = getSettings(app.getPath('userData')).extensionsDir
    try {
      if (!existsSync(extensionsDir)) return []
      const [entries, trustedRepos] = await Promise.all([
        readdir(extensionsDir, { withFileTypes: true }),
        fetchTrustedRepos(),
      ])
      const dirs = entries.filter(e => e.isDirectory())
      return Promise.all(dirs.map(async (entry) => {
        const base = { id: entry.name, name: entry.name, trusted: false, models: [] }
        for (const manifestFile of ['manifest.json', 'package.json']) {
          const p = join(extensionsDir, entry.name, manifestFile)
          if (existsSync(p)) {
            try {
              const raw    = await readFile(p, 'utf-8')
              const parsed = JSON.parse(raw) as ParsedManifest
              return parseExtensionManifest(parsed, entry.name, trustedRepos)
            } catch { /* ignore parse errors, fall through */ }
          }
        }
        return base
      }))
    } catch {
      return []
    }
  })

  // Install an extension from a GitHub repo URL
  ipcMain.handle('extensions:installFromGitHub', async (event, githubUrl: string) => {
    const win    = getWindow()
    const emit   = (data: object) => win?.webContents.send('extensions:installProgress', data)
    const tmpDir = app.getPath('temp')

    let tarPath    = ''
    let extractDir = ''

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
      const manifestPath   = join(extractDir, 'manifest.json')
      const generatorPath  = join(extractDir, 'generator.py')

      if (!existsSync(manifestPath))  throw new Error('manifest.json missing from repository')
      if (!existsSync(generatorPath)) throw new Error('generator.py missing from repository')

      const manifestRaw = await readFile(manifestPath, 'utf-8')
      const manifest    = JSON.parse(manifestRaw) as ParsedManifest

      if (!manifest.id)              throw new Error('manifest.json: required field "id" missing')
      if (!manifest.generator_class) throw new Error('manifest.json: required field "generator_class" missing')

      // Override source field with the actual GitHub URL so trust is based on origin
      manifest.source = `https://github.com/${owner}/${repo}`
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')

      // 5. Copy to extensions directory (overwrite if already present)
      const extensionsDir = getSettings(app.getPath('userData')).extensionsDir
      await mkdir(extensionsDir, { recursive: true })
      const destDir = join(extensionsDir, manifest.id)

      if (existsSync(destDir)) {
        await rmAsync(destDir, { recursive: true, force: true })
      }
      await cp(extractDir, destDir, { recursive: true })

      // 6. Hot-reload Python registry
      try {
        await axios.post(`${API_BASE_URL}/extensions/reload`, {}, { timeout: 10_000 })
      } catch { /* Python might not be running yet */ }

      emit({ step: 'done', extensionId: manifest.id })

      const trustedRepos = await fetchTrustedRepos()
      const ext = parseExtensionManifest(manifest, manifest.id, trustedRepos)
      return { success: true, extensionId: manifest.id, extension: ext }

    } catch (err) {
      emit({ step: 'error', message: String(err) })
      return { success: false, error: String(err) }
    } finally {
      // Cleanup temp files
      if (tarPath    && existsSync(tarPath))    rmAsync(tarPath,    { force: true }).catch(() => {})
      if (extractDir && existsSync(extractDir)) rmAsync(extractDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  // Uninstall an extension — deletes its directory and reloads Python
  ipcMain.handle('extensions:uninstall', async (_, extensionId: string) => {
    const extensionsDir = getSettings(app.getPath('userData')).extensionsDir
    const extPath       = join(extensionsDir, extensionId)
    try {
      await rmAsync(extPath, { recursive: true, force: true })
      // Hot-reload Python so it stops using the deleted extension
      try {
        await axios.post(`${API_BASE_URL}/extensions/reload`, {}, { timeout: 10_000 })
      } catch { /* ignore if Python is not running */ }
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // Trigger Python extension reload (without touching the filesystem)
  ipcMain.handle('extensions:reload', async () => {
    try {
      const res = await axios.post(`${API_BASE_URL}/extensions/reload`, {}, { timeout: 10_000 })
      return { success: true, errors: (res.data as { errors?: Record<string, string> }).errors ?? {} }
    } catch (err) {
      return { success: false, error: String(err) }
    }
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
}

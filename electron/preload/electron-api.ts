import type {
  AssetLibraryListResult,
  AssetLibraryOpenRequest,
  AssetLibraryOpenResult,
  AssetLibraryReadRequest,
  AssetLibraryReadResult,
  AssetLibraryThumbnailRequest,
  AssetLibraryThumbnailResult,
} from '../../src/shared/types/assetLibrary'
import type { TextureWatchChoice, TextureWatchUpdate } from '../../src/shared/types/liveTexture'

export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  send(channel: string, ...args: unknown[]): void
  on(channel: string, listener: (...args: unknown[]) => void): void
  removeAllListeners(channel: string): void
}

export interface WebFrameLike {
  setZoomFactor(factor: number): void
}

export function createElectronApi(ipcRenderer: IpcRendererLike, webFrame: WebFrameLike) {
  return {
    // Window controls
    window: {
      minimize:     () => ipcRenderer.send('window:minimize'),
      maximize:     () => ipcRenderer.send('window:maximize'),
      close:        () => ipcRenderer.send('window:close'),
      isMaximized:  () => ipcRenderer.invoke('window:isMaximized') as Promise<boolean>,
      onMaximizeChange: (cb: (isMaximized: boolean) => void) => {
        ipcRenderer.on('window:maximizeChanged', (_event, isMaximized) => cb(isMaximized as boolean))
      },
      offMaximizeChange: () => ipcRenderer.removeAllListeners('window:maximizeChanged'),
    },

    // Renderer UI (zoom whole page — scales every px/rem consistently)
    ui: {
      setZoomFactor: (factor: number) => webFrame.setZoomFactor(factor),
      // Chromium eats Ctrl/Cmd +/- before the page sees them, so the main
      // process catches the chord and forwards only the direction. The size
      // itself is the renderer's, so there is exactly one copy of it.
      onZoomStep: (cb: (step: number) => void) => {
        ipcRenderer.on('ui:zoomStep', (_event, step) => cb(step as number))
      },
      offZoomStep: () => ipcRenderer.removeAllListeners('ui:zoomStep'),
    },

    // Shell utilities
    shell: { openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url) },

    // System info
    system: {
      memory: (): Promise<{ total: number; used: number; available: number }> =>
        ipcRenderer.invoke('system:memory') as Promise<{ total: number; used: number; available: number }>,
    },

    // Python / FastAPI bridge
    python: {
      start:     (): Promise<{ success: boolean; port?: number; error?: string }> =>
        ipcRenderer.invoke('python:start') as Promise<{ success: boolean; port?: number; error?: string }>,
      status:    (): Promise<{ ready: boolean; apiUrl: string }> =>
        ipcRenderer.invoke('python:status') as Promise<{ ready: boolean; apiUrl: string }>,
      onCrashed: (cb: (data: { code: number | null }) => void) => {
        ipcRenderer.on('python:crashed', (_event, data) => cb(data as { code: number | null }))
      },
      offCrashed: () => ipcRenderer.removeAllListeners('python:crashed'),
      onLog:  (cb: (line: string) => void) => {
        ipcRenderer.on('python:log', (_event, line) => cb(line as string))
      },
      offLog: () => ipcRenderer.removeAllListeners('python:log'),
    },

    // File system dialogs + local file reading
    fs: {
      selectImage:       (): Promise<string | null> =>
        ipcRenderer.invoke('fs:selectImage') as Promise<string | null>,
      selectMeshFile:    (): Promise<string | null> =>
        ipcRenderer.invoke('fs:selectMeshFile') as Promise<string | null>,
      saveModel:         (defaultName: string): Promise<string | null> =>
        ipcRenderer.invoke('fs:saveModel', defaultName) as Promise<string | null>,
      readFileBase64:    (filePath: string): Promise<string> =>
        ipcRenderer.invoke('fs:readFileBase64', filePath) as Promise<string>,
      selectDirectory:   (defaultPath?: string): Promise<string | null> =>
        ipcRenderer.invoke('fs:selectDirectory', defaultPath) as Promise<string | null>,
      savePath:          (args: { filters: { name: string; extensions: string[] }[]; defaultPath?: string }): Promise<string | null> =>
        ipcRenderer.invoke('fs:savePath', args) as Promise<string | null>,
      listDir:           (dirPath: string): Promise<string[]> =>
        ipcRenderer.invoke('fs:listDir', dirPath) as Promise<string[]>,
      listFiles:         (dirPath: string, extensions?: string[]): Promise<string[]> =>
        ipcRenderer.invoke('fs:listFiles', dirPath, extensions) as Promise<string[]>,
      selectTextFile:    (): Promise<string | null> =>
        ipcRenderer.invoke('fs:selectTextFile') as Promise<string | null>,
      moveDirectory:     (args: { src: string; dest: string }): Promise<{ success: boolean; error?: string }> =>
        ipcRenderer.invoke('fs:moveDirectory', args) as Promise<{ success: boolean; error?: string }>,
      deleteDirectory:   (dirPath: string): Promise<{ success: boolean; error?: string }> =>
        ipcRenderer.invoke('fs:deleteDirectory', dirPath) as Promise<{ success: boolean; error?: string }>,
      readScreenshotDataUrl: (filename: string): Promise<string> =>
        ipcRenderer.invoke('fs:readScreenshotDataUrl', filename) as Promise<string>,
    },

    texture: {
      chooseAndWatch: (): Promise<TextureWatchChoice> =>
        ipcRenderer.invoke('texture:chooseAndWatch') as Promise<TextureWatchChoice>,
      stopWatching: (): Promise<void> =>
        ipcRenderer.invoke('texture:stopWatching') as Promise<void>,
      onChange: (cb: (update: TextureWatchUpdate) => void) => {
        ipcRenderer.on('texture:changed', (_event, update) => cb(update as TextureWatchUpdate))
      },
      offChange: () => ipcRenderer.removeAllListeners('texture:changed'),
    },

    // Settings
    settings: {
      get: (): Promise<{ modelsDir: string; workspaceDir: string; workflowsDir: string; extensionsDir: string; hfToken?: string }> =>
        ipcRenderer.invoke('settings:get') as Promise<{ modelsDir: string; workspaceDir: string; workflowsDir: string; extensionsDir: string; hfToken?: string }>,
      set: (patch: { modelsDir?: string; workspaceDir?: string; workflowsDir?: string; extensionsDir?: string; hfToken?: string }): Promise<{ modelsDir: string; workspaceDir: string; workflowsDir: string; extensionsDir: string; hfToken?: string }> =>
        ipcRenderer.invoke('settings:set', patch) as Promise<{ modelsDir: string; workspaceDir: string; workflowsDir: string; extensionsDir: string; hfToken?: string }>,
    },

    // Cache
    cache: {
      clear: (): Promise<{ success: boolean; error?: string }> =>
        ipcRenderer.invoke('cache:clear') as Promise<{ success: boolean; error?: string }>,
    },

    // API helpers (calls FastAPI from the main process)
    api: {
      updatePaths: (patch: { modelsDir?: string; workspaceDir?: string; extensionsDir?: string }): Promise<{ success: boolean; error?: string }> =>
        ipcRenderer.invoke('api:updatePaths', patch) as Promise<{ success: boolean; error?: string }>,
    },

    // Model management
    model: {
      export:         (args: { outputUrl: string; format: string }) => ipcRenderer.invoke('model:export', args),
      listDownloaded: () => ipcRenderer.invoke('model:listDownloaded'),
      isDownloaded:   (modelId: string, downloadCheck?: string) => ipcRenderer.invoke('model:isDownloaded', modelId, downloadCheck),
      download:       (repoId: string, modelId: string, skipPrefixes?: string[], includePrefixes?: string[]) =>
        ipcRenderer.invoke('model:download', { repoId, modelId, skipPrefixes, includePrefixes }),
      pauseDownload:  (modelId: string) => ipcRenderer.invoke('model:pauseDownload', modelId),
      cancelDownload: (modelId: string) => ipcRenderer.invoke('model:cancelDownload', modelId),
      delete:         (modelId: string) => ipcRenderer.invoke('model:delete', modelId),
      unloadAll:      () => ipcRenderer.invoke('model:unloadAll'),
      showInFolder:   (modelId: string) => ipcRenderer.invoke('model:showInFolder', modelId),
      activeDownloads: (): Promise<{ modelId: string; percent: number; file?: string; fileIndex?: number; totalFiles?: number }[]> =>
        ipcRenderer.invoke('model:activeDownloads') as Promise<{ modelId: string; percent: number; file?: string; fileIndex?: number; totalFiles?: number }[]>,
      onProgress:     (cb: (data: {
        modelId: string
        percent: number
        file?: string
        fileIndex?: number
        totalFiles?: number
        status?: string
        bytesDownloaded?: number
        totalBytes?: number
        stalledSeconds?: number
        paused?: boolean
        cancelled?: boolean
      }) => void) => {
        ipcRenderer.on('model:downloadProgress', (_event, data) => cb(data as {
          modelId: string
          percent: number
          file?: string
          fileIndex?: number
          totalFiles?: number
          status?: string
          bytesDownloaded?: number
          totalBytes?: number
          stalledSeconds?: number
          paused?: boolean
          cancelled?: boolean
        }))
      },
      offProgress:    () => ipcRenderer.removeAllListeners('model:downloadProgress'),
    },

    // App metadata
    app: {
      info: (): Promise<{ version: string; userData: string; modelsDir: string; apiUrl: string; platform: string; arch: string }> =>
        ipcRenderer.invoke('app:info') as Promise<{ version: string; userData: string; modelsDir: string; apiUrl: string; platform: string; arch: string }>,
      onError:  (cb: (message: string) => void) => {
        ipcRenderer.on('app:error', (_event, message) => cb(message as string))
      },
      offError: () => ipcRenderer.removeAllListeners('app:error'),
    },

    // Logging
    log: {
      error:   (message: string) => ipcRenderer.send('log:error', message),
      getPath: (): Promise<string> => ipcRenderer.invoke('log:getPath') as Promise<string>,
      readAll: (session?: string): Promise<Record<string, string>> => ipcRenderer.invoke('log:readAll', session) as Promise<Record<string, string>>,
      listSessions: (): Promise<string[]> => ipcRenderer.invoke('log:listSessions') as Promise<string[]>,
    },

    // Workspace filesystem-based persistence
    workspace: {
      listCollections: (): Promise<string[]> =>
        ipcRenderer.invoke('workspace:listCollections') as Promise<string[]>,
      createCollection: (name: string): Promise<void> =>
        ipcRenderer.invoke('workspace:createCollection', name) as Promise<void>,
      renameCollection: (oldName: string, newName: string): Promise<void> =>
        ipcRenderer.invoke('workspace:renameCollection', { oldName, newName }) as Promise<void>,
      deleteCollection: (name: string): Promise<void> =>
        ipcRenderer.invoke('workspace:deleteCollection', name) as Promise<void>,
      listJobs: (collection: string): Promise<unknown[]> =>
        ipcRenderer.invoke('workspace:listJobs', collection) as Promise<unknown[]>,
      saveJobMeta: (collection: string, filename: string, meta: unknown): Promise<void> =>
        ipcRenderer.invoke('workspace:saveJobMeta', { collection, filename, meta }) as Promise<void>,
      deleteJob: (collection: string, filename: string): Promise<void> =>
        ipcRenderer.invoke('workspace:deleteJob', { collection, filename }) as Promise<void>,
      library: {
        list: (): Promise<AssetLibraryListResult> => ipcRenderer.invoke('workspace:library:list') as Promise<AssetLibraryListResult>,
        read: (request: AssetLibraryReadRequest): Promise<AssetLibraryReadResult> => ipcRenderer.invoke('workspace:library:read', request) as Promise<AssetLibraryReadResult>,
        open: (request: AssetLibraryOpenRequest): Promise<AssetLibraryOpenResult> => ipcRenderer.invoke('workspace:library:open', request) as Promise<AssetLibraryOpenResult>,
        thumbnail: (request: AssetLibraryThumbnailRequest): Promise<AssetLibraryThumbnailResult> => ipcRenderer.invoke('workspace:library:thumbnail', request) as Promise<AssetLibraryThumbnailResult>,
      },
    },

    // Extensions
    extensions: {
      list: (): Promise<unknown[]> =>
        ipcRenderer.invoke('extensions:list') as Promise<unknown[]>,

      installFromGitHub: (url: string): Promise<{
        success: boolean; error?: string; cancelled?: boolean
        extensionId?: string
        extension?: unknown
      }> => ipcRenderer.invoke('extensions:installFromGitHub', url) as Promise<{
        success: boolean; error?: string; cancelled?: boolean
        extensionId?: string
        extension?: unknown
      }>,

      installFromLocal: (): Promise<{
        success: boolean; error?: string; cancelled?: boolean
        extensionId?: string
        extension?: unknown
        localPath?: string
      }> => ipcRenderer.invoke('extensions:installFromLocal') as Promise<{
        success: boolean; error?: string; cancelled?: boolean
        extensionId?: string
        extension?: unknown
        localPath?: string
      }>,

      uninstall: (extensionId: string): Promise<{ success: boolean; error?: string }> =>
        ipcRenderer.invoke('extensions:uninstall', extensionId) as Promise<{ success: boolean; error?: string }>,

      repair: (extensionId: string): Promise<{ success: boolean; error?: string }> =>
        ipcRenderer.invoke('extensions:repair', extensionId) as Promise<{ success: boolean; error?: string }>,

      reload: (): Promise<{ success: boolean; error?: string }> =>
        ipcRenderer.invoke('extensions:reload') as Promise<{ success: boolean; error?: string }>,

      runProcess: (
        extensionId: string,
        input:       { filePath?: string; text?: string; texts?: (string | undefined)[]; nodeId?: string; sourceAssetPath?: string },
        params:      Record<string, unknown>,
      ): Promise<{ success: boolean; result?: { filePath?: string; text?: string }; error?: string }> =>
        ipcRenderer.invoke('extensions:runProcess', extensionId, input, params) as Promise<{ success: boolean; result?: { filePath?: string; text?: string }; error?: string }>,

      onInstallProgress: (cb: (data: {
        step: 'downloading' | 'extracting' | 'validating' | 'setting_up' | 'done' | 'error'
        percent?: number
        extensionId?: string
        message?: string
      }) => void) => {
        ipcRenderer.on('extensions:installProgress', (_event, data) => cb(data as {
          step: 'downloading' | 'extracting' | 'validating' | 'setting_up' | 'done' | 'error'
          percent?: number
          extensionId?: string
          message?: string
        }))
      },
      offInstallProgress: () => ipcRenderer.removeAllListeners('extensions:installProgress'),
    },

    // Workflows
    workflows: {
      list:   ():                                              Promise<unknown[]>                            => ipcRenderer.invoke('workflows:list') as Promise<unknown[]>,
      save:   (workflow: { id: string; [key: string]: unknown }): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('workflows:save', workflow) as Promise<{ success: boolean; error?: string }>,
      delete: (id: string):                                   Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('workflows:delete', id) as Promise<{ success: boolean; error?: string }>,
      import: ():                                             Promise<{ success: boolean; error?: string; workflow?: unknown }> => ipcRenderer.invoke('workflows:import') as Promise<{ success: boolean; error?: string; workflow?: unknown }>,
      export: (workflow: { id: string; name?: string; [key: string]: unknown }): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('workflows:export', workflow) as Promise<{ success: boolean; error?: string }>,
    },

    // Auto-updater
    updater: {
      check: (): Promise<{ success: boolean }> =>
        ipcRenderer.invoke('updater:check') as Promise<{ success: boolean }>,
      quitAndInstall: (): Promise<void> =>
        ipcRenderer.invoke('updater:quitAndInstall') as Promise<void>,
      onApplying: (cb: (data: { version: string }) => void) => {
        ipcRenderer.on('updater:applying', (_event, data) => cb(data as { version: string }))
      },
      offApplying: () => ipcRenderer.removeAllListeners('updater:applying'),
      onMajorMinorAvailable: (cb: (data: { version: string }) => void) => {
        ipcRenderer.on('updater:major-minor-available', (_event, data) => cb(data as { version: string }))
      },
      offMajorMinorAvailable: () => ipcRenderer.removeAllListeners('updater:major-minor-available'),
    },

    // First-run setup
    setup: {
      check:        (): Promise<{ needed: boolean; defaultDataDir: string; platform: string; arch: string }> =>
        ipcRenderer.invoke('setup:check') as Promise<{ needed: boolean; defaultDataDir: string; platform: string; arch: string }>,
      run:          (): Promise<{ success: boolean; error?: string }> =>
        ipcRenderer.invoke('setup:run') as Promise<{ success: boolean; error?: string }>,
      saveDataDir:  (baseDir: string): Promise<void> =>
        ipcRenderer.invoke('setup:saveDataDir', { baseDir }) as Promise<void>,
      onProgress:  (cb: (data: { step: string; percent: number; currentPackage?: string }) => void) => {
        ipcRenderer.on('setup:progress', (_event, data) => cb(data as { step: string; percent: number; currentPackage?: string }))
      },
      offProgress: () => ipcRenderer.removeAllListeners('setup:progress'),
      onComplete:  (cb: () => void) => {
        ipcRenderer.on('setup:complete', () => cb())
      },
      offComplete: () => ipcRenderer.removeAllListeners('setup:complete'),
      onError:     (cb: (data: { message: string }) => void) => {
        ipcRenderer.on('setup:error', (_event, data) => cb(data as { message: string }))
      },
      offError:    () => ipcRenderer.removeAllListeners('setup:error'),
    },
  }
}

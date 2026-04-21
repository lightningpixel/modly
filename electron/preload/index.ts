import { contextBridge, ipcRenderer } from 'electron'

// Expose a typed API to the renderer process via window.electron
contextBridge.exposeInMainWorld('electron', {
  // Window controls
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close:    () => ipcRenderer.send('window:close')
  },

  // Shell utilities
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  },

  // Python / FastAPI bridge
  python: {
    start:     (): Promise<{ success: boolean; port?: number; error?: string }> =>
      ipcRenderer.invoke('python:start'),
    status:    (): Promise<{ ready: boolean; apiUrl: string }> =>
      ipcRenderer.invoke('python:status'),
    onCrashed: (cb: (data: { code: number | null }) => void) => {
      ipcRenderer.on('python:crashed', (_event, data) => cb(data))
    },
    offCrashed: () => ipcRenderer.removeAllListeners('python:crashed'),
    onLog:  (cb: (line: string) => void) => {
      ipcRenderer.on('python:log', (_event, line) => cb(line))
    },
    offLog: () => ipcRenderer.removeAllListeners('python:log')
  },

  // File system dialogs + local file reading
  fs: {
    selectImage:       (): Promise<string | null> =>
      ipcRenderer.invoke('fs:selectImage'),
    selectMeshFile:    (): Promise<string | null> =>
      ipcRenderer.invoke('fs:selectMeshFile'),
    saveModel:         (defaultName: string): Promise<string | null> =>
      ipcRenderer.invoke('fs:saveModel', defaultName),
    readFileBase64:    (filePath: string): Promise<string> =>
      ipcRenderer.invoke('fs:readFileBase64', filePath),
    selectDirectory:   (): Promise<string | null> =>
      ipcRenderer.invoke('fs:selectDirectory'),
    savePath:          (args: { filters: { name: string; extensions: string[] }[]; defaultPath?: string }): Promise<string | null> =>
      ipcRenderer.invoke('fs:savePath', args),
    listDir:           (dirPath: string): Promise<string[]> =>
      ipcRenderer.invoke('fs:listDir', dirPath),
    moveDirectory:     (args: { src: string; dest: string }): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('fs:moveDirectory', args),
    deleteDirectory:   (dirPath: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('fs:deleteDirectory', dirPath),
    readScreenshotDataUrl: (filename: string): Promise<string> =>
      ipcRenderer.invoke('fs:readScreenshotDataUrl', filename),
  },

  // Settings
  settings: {
    get: (): Promise<{ modelsDir: string; workspaceDir: string; workflowsDir: string; extensionsDir: string; hfToken?: string }> =>
      ipcRenderer.invoke('settings:get'),
    set: (patch: { modelsDir?: string; workspaceDir?: string; workflowsDir?: string; extensionsDir?: string; hfToken?: string }): Promise<{ modelsDir: string; workspaceDir: string; workflowsDir: string; extensionsDir: string; hfToken?: string }> =>
      ipcRenderer.invoke('settings:set', patch),
  },

  // Cache
  cache: {
    clear: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('cache:clear'),
  },

  // API helpers (calls FastAPI from the main process)
  api: {
    updatePaths: (patch: { modelsDir?: string; workspaceDir?: string; extensionsDir?: string }): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('api:updatePaths', patch),
  },

  // Model management
  model: {
    export:         (args: { outputUrl: string; format: string }) => ipcRenderer.invoke('model:export', args),
    listDownloaded: () => ipcRenderer.invoke('model:listDownloaded'),
    isDownloaded:   (modelId: string) => ipcRenderer.invoke('model:isDownloaded', modelId),
    download:       (repoId: string, modelId: string, skipPrefixes?: string[]) => ipcRenderer.invoke('model:download', { repoId, modelId, skipPrefixes }),
    delete:         (modelId: string) => ipcRenderer.invoke('model:delete', modelId),
    unloadAll:      () => ipcRenderer.invoke('model:unloadAll'),
    showInFolder:   (modelId: string) => ipcRenderer.invoke('model:showInFolder', modelId),
    onProgress:     (cb: (data: { modelId: string; percent: number; file?: string; fileIndex?: number; totalFiles?: number; status?: string }) => void) => {
      ipcRenderer.on('model:downloadProgress', (_event, data) => cb(data))
    },
    offProgress:    () => ipcRenderer.removeAllListeners('model:downloadProgress')
  },

  // App metadata
  app: {
    info: (): Promise<{ version: string; userData: string; modelsDir: string; apiUrl: string }> =>
      ipcRenderer.invoke('app:info'),
    onError:  (cb: (message: string) => void) => {
      ipcRenderer.on('app:error', (_event, message) => cb(message))
    },
    offError: () => ipcRenderer.removeAllListeners('app:error'),
  },

  // Logging
  log: {
    error:   (message: string) => ipcRenderer.send('log:error', message),
    getPath: (): Promise<string> => ipcRenderer.invoke('log:getPath'),
    readAll: (session?: string): Promise<Record<string, string>> => ipcRenderer.invoke('log:readAll', session),
    listSessions: (): Promise<string[]> => ipcRenderer.invoke('log:listSessions'),
  },

  // Workspace filesystem-based persistence
  workspace: {
    listCollections: (): Promise<string[]> =>
      ipcRenderer.invoke('workspace:listCollections'),
    createCollection: (name: string): Promise<void> =>
      ipcRenderer.invoke('workspace:createCollection', name),
    renameCollection: (oldName: string, newName: string): Promise<void> =>
      ipcRenderer.invoke('workspace:renameCollection', { oldName, newName }),
    deleteCollection: (name: string): Promise<void> =>
      ipcRenderer.invoke('workspace:deleteCollection', name),
    listJobs: (collection: string): Promise<unknown[]> =>
      ipcRenderer.invoke('workspace:listJobs', collection),
    saveJobMeta: (collection: string, filename: string, meta: unknown): Promise<void> =>
      ipcRenderer.invoke('workspace:saveJobMeta', { collection, filename, meta }),
    deleteJob: (collection: string, filename: string): Promise<void> =>
      ipcRenderer.invoke('workspace:deleteJob', { collection, filename }),
  },

  // Extensions
  extensions: {
    list: (): Promise<unknown[]> =>
      ipcRenderer.invoke('extensions:list'),

    installFromGitHub: (url: string): Promise<{
      success: boolean; error?: string
      extensionId?: string
      extension?: unknown
    }> => ipcRenderer.invoke('extensions:installFromGitHub', url),

    uninstall: (extensionId: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('extensions:uninstall', extensionId),

    repair: (extensionId: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('extensions:repair', extensionId),

    reload: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('extensions:reload'),

    runProcess: (
      extensionId: string,
      input:       { filePath?: string; text?: string; nodeId?: string },
      params:      Record<string, unknown>,
    ): Promise<{ success: boolean; result?: { filePath?: string; text?: string }; error?: string }> =>
      ipcRenderer.invoke('extensions:runProcess', extensionId, input, params),

    onInstallProgress: (cb: (data: {
      step: 'downloading' | 'extracting' | 'validating' | 'setting_up' | 'done' | 'error'
      percent?: number
      extensionId?: string
      message?: string
    }) => void) => {
      ipcRenderer.on('extensions:installProgress', (_event, data) => cb(data))
    },
    offInstallProgress: () => ipcRenderer.removeAllListeners('extensions:installProgress'),
  },

  // Workflows
  workflows: {
    list:   ():                                              Promise<unknown[]>                            => ipcRenderer.invoke('workflows:list'),
    save:   (workflow: { id: string; [key: string]: unknown }): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('workflows:save', workflow),
    delete: (id: string):                                   Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('workflows:delete', id),
    import: ():                                             Promise<{ success: boolean; error?: string; workflow?: unknown }> => ipcRenderer.invoke('workflows:import'),
    export: (workflow: { id: string; name?: string; [key: string]: unknown }): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('workflows:export', workflow),
  },

  // Auto-updater
  updater: {
    check: (): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('updater:check'),
    quitAndInstall: (): Promise<void> =>
      ipcRenderer.invoke('updater:quitAndInstall'),
    onApplying: (cb: (data: { version: string }) => void) => {
      ipcRenderer.on('updater:applying', (_event, data) => cb(data))
    },
    offApplying: () => ipcRenderer.removeAllListeners('updater:applying'),
    onMajorMinorAvailable: (cb: (data: { version: string }) => void) => {
      ipcRenderer.on('updater:major-minor-available', (_event, data) => cb(data))
    },
    offMajorMinorAvailable: () => ipcRenderer.removeAllListeners('updater:major-minor-available'),
  },

  // First-run setup
  setup: {
    check:        (): Promise<{ needed: boolean; defaultDataDir: string }> =>
      ipcRenderer.invoke('setup:check'),
    run:          (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('setup:run'),
    saveDataDir:  (baseDir: string): Promise<void> =>
      ipcRenderer.invoke('setup:saveDataDir', { baseDir }),
    onProgress:  (cb: (data: { step: string; percent: number; currentPackage?: string }) => void) => {
      ipcRenderer.on('setup:progress', (_e, data) => cb(data))
    },
    offProgress: () => ipcRenderer.removeAllListeners('setup:progress'),
    onComplete:  (cb: () => void) => {
      ipcRenderer.on('setup:complete', () => cb())
    },
    offComplete: () => ipcRenderer.removeAllListeners('setup:complete'),
    onError:     (cb: (data: { message: string }) => void) => {
      ipcRenderer.on('setup:error', (_e, data) => cb(data))
    },
    offError:    () => ipcRenderer.removeAllListeners('setup:error'),
  }
})

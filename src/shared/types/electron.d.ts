// Type declarations for the Electron API exposed via preload
export {}

declare global {
  interface Window {
    electron: {
      window: {
        minimize: () => void
        maximize: () => void
        close:    () => void
      }
      python: {
        start:     () => Promise<{ success: boolean; port?: number; error?: string }>
        status:    () => Promise<{ ready: boolean; apiUrl: string }>
        onCrashed: (cb: (data: { code: number | null }) => void) => void
        offCrashed: () => void
        onLog:  (cb: (line: string) => void) => void
        offLog: () => void
      }
      fs: {
        selectImage:     () => Promise<string | null>
        saveModel:       (defaultName: string) => Promise<string | null>
        readFileBase64:  (filePath: string) => Promise<string>
        selectDirectory: () => Promise<string | null>
        listDir:         (dirPath: string) => Promise<string[]>
        moveDirectory:   (args: { src: string; dest: string }) => Promise<{ success: boolean; error?: string }>
        deleteDirectory: (dirPath: string) => Promise<{ success: boolean; error?: string }>
      }
      settings: {
        get: () => Promise<{ modelsDir: string; workspaceDir: string; extensionsDir: string }>
        set: (patch: { modelsDir?: string; workspaceDir?: string; extensionsDir?: string }) => Promise<{ modelsDir: string; workspaceDir: string; extensionsDir: string }>
      }
      cache: {
        clear: () => Promise<{ success: boolean; error?: string }>
      }
      api: {
        updatePaths: (patch: { modelsDir?: string; workspaceDir?: string; extensionsDir?: string }) => Promise<{ success: boolean; error?: string }>
      }
      model: {
        export:         (args: { outputUrl: string; format: string }) => Promise<{ success: boolean; error?: string }>
        listDownloaded: () => Promise<{ id: string; name: string; size_gb: number }[]>
        isDownloaded:   (modelId: string) => Promise<boolean>
        download:       (repoId: string, modelId: string) => Promise<{ success: boolean; error?: string }>
        delete:         (modelId: string) => Promise<{ success: boolean; error?: string }>
        onProgress:     (cb: (data: { modelId: string; percent: number; file?: string; fileIndex?: number; totalFiles?: number; status?: string }) => void) => void
        offProgress:    () => void
      }
      app: {
        info: () => Promise<{
          version:   string
          userData:  string
          modelsDir: string
          apiUrl:    string
        }>
        onError:  (cb: (message: string) => void) => void
        offError: () => void
      }
      log: {
        error:   (message: string) => void
        getPath: () => Promise<string>
        readAll: (session?: string) => Promise<Record<string, string>>
        listSessions: () => Promise<string[]>
      }
      workspace: {
        listCollections: () => Promise<string[]>
        createCollection: (name: string) => Promise<void>
        renameCollection: (oldName: string, newName: string) => Promise<void>
        deleteCollection: (name: string) => Promise<void>
        listJobs: (collection: string) => Promise<unknown[]>
        saveJobMeta: (collection: string, filename: string, meta: unknown) => Promise<void>
        deleteJob: (collection: string, filename: string) => Promise<void>
      }
      setup: {
        check:        () => Promise<{ needed: boolean; defaultDataDir: string }>
        run:          () => Promise<{ success: boolean; error?: string }>
        saveDataDir:  (baseDir: string) => Promise<void>
        onProgress:   (cb: (data: { step: string; percent: number; currentPackage?: string }) => void) => void
        offProgress:  () => void
        onComplete:   (cb: () => void) => void
        offComplete:  () => void
        onError:      (cb: (data: { message: string }) => void) => void
        offError:     () => void
      }
      updater: {
        check:                 () => Promise<{ success: boolean }>
        quitAndInstall:        () => Promise<void>
        onPatchReady:          (cb: (data: { version: string }) => void) => void
        offPatchReady:         () => void
        onMajorMinorAvailable: (cb: (data: { version: string }) => void) => void
        offMajorMinorAvailable: () => void
      }
      extensions: {
        list: () => Promise<Array<{
          id:           string
          name:         string
          version?:     string
          description?: string
          author?:      string
          trusted:      boolean
          models:       { id: string; name: string; repoId: string; description?: string }[]
        }>>
        installFromGitHub: (url: string) => Promise<{
          success:      boolean
          error?:       string
          extensionId?: string
          extension?: {
            id:           string
            name:         string
            version?:     string
            description?: string
            author?:      string
            trusted:      boolean
            models:       { id: string; name: string; repoId: string; description?: string }[]
          }
        }>
        uninstall: (extensionId: string) => Promise<{ success: boolean; error?: string }>
        reload:    () => Promise<{ success: boolean; error?: string; errors?: Record<string, string> }>
        onInstallProgress: (cb: (data: {
          step:          'downloading' | 'extracting' | 'validating' | 'done' | 'error'
          percent?:      number
          extensionId?:  string
          message?:      string
        }) => void) => void
        offInstallProgress: () => void
      }
    }
  }
}

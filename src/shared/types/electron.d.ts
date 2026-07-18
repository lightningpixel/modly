// Type declarations for the Electron API exposed via preload
export {}

import type {
  AssetLibraryListResult,
  AssetLibraryOpenRequest,
  AssetLibraryOpenResult,
  AssetLibraryReadRequest,
  AssetLibraryReadResult,
} from './assetLibrary'

// ─── Extension types ──────────────────────────────────────────────────────────

export interface ExtensionNode {
  id:               string
  name:             string
  input:            'image' | 'text' | 'mesh' | 'audio'
  inputs?:          ('image' | 'text' | 'mesh' | 'audio')[]   // multi-input nodes; overrides input when set
  inputLabels?:     string[]   // display labels per input slot (e.g. positive/negative)
  output:           'image' | 'text' | 'mesh' | 'audio'
  paramsSchema:     ParamSchema[]
  paramDefaults?:   Record<string, number | string>
  hfRepo?:          string
  downloadCheck?:   string
  hfSkipPrefixes?:  string[]
  hfIncludePrefixes?: string[]
}

export interface ModelExtension {
  type:         'model'
  id:           string
  name:         string
  version?:     string
  description?: string
  author?:      string
  trusted:      boolean
  builtin:      boolean
  source?:      string
  localPath?:   string
  nodes:        ExtensionNode[]
  /** Folder exists but is not a loadable extension — see manifestError */
  corrupted?:   boolean
  /** Why the folder is corrupted: manifest gone, manifest unparseable, or install never completed */
  manifestError?: 'missing' | 'invalid' | 'incomplete'
}

export interface ParamSchema {
  id:       string
  label:    string
  type:     'select' | 'int' | 'float' | 'string' | 'file-select'
  default:  number | string
  options?: { value: number | string; label: string }[]
  min?:     number
  max?:     number
  step?:    number
  tooltip?: string
  show_if?: Record<string, string | number | (string | number)[]>
  // file-select: dropdown of the files inside the folder held by another param
  dir_from?:   string     // id of the (string) param holding the folder path
  extensions?: string[]   // file extensions to list (e.g. ["json"])
}

export interface ProcessExtension {
  type:         'process'
  id:           string
  name:         string
  version?:     string
  description?: string
  author?:      string
  trusted:      boolean
  builtin:      boolean
  source?:      string
  localPath?:   string
  entry:        string
  nodes:        ExtensionNode[]
  /** Folder exists but is not a loadable extension — see manifestError */
  corrupted?:   boolean
  /** Why the folder is corrupted: manifest gone, manifest unparseable, or install never completed */
  manifestError?: 'missing' | 'invalid' | 'incomplete'
}

export type AnyExtension = ModelExtension | ProcessExtension

// ─── Process runner types ─────────────────────────────────────────────────────

export interface ProcessInput {
  filePath?: string
  text?:     string
  /** Per-slot texts for multi-text-input nodes (index = target handle slot). */
  texts?:    (string | undefined)[]
  nodeId?:   string
}

export interface ProcessResult {
  filePath?: string
  text?:     string
}

export interface WFNodeData {
  extensionId?:    string
  inputType?:      'image' | 'text'
  enabled:         boolean
  showInGenerate?: boolean
  iterations?:     number   // While container: auto-loop N times (omit/0 = manual only)
  params:          Record<string, unknown>
  // React Flow requires node data to satisfy Record<string, unknown>.
  [key: string]:   unknown
}

export interface WFNode {
  id:        string
  type:      string
  position:  { x: number; y: number }
  data:      WFNodeData
  // Sub-flow / group support (While container)
  parentId?: string
  extent?:   'parent'
  width?:    number
  height?:   number
  style?:    Record<string, unknown>
}

export interface WFEdge {
  id:            string
  source:        string
  target:        string
  sourceHandle?: string | null
  targetHandle?: string | null
}

export interface Workflow {
  id:          string
  name:        string
  description: string
  /** Display folder in the workflow browser (no folder = root) */
  folder?:     string
  /** Pinned in the workflow browser's Bookmarks section */
  bookmarked?: boolean
  nodes:       WFNode[]
  edges:       WFEdge[]
  createdAt:   string
  updatedAt:   string
}

declare global {
  interface Window {
    electron: {
      shell: {
        openExternal: (url: string) => Promise<void>
      }
      system: {
        memory: () => Promise<{ total: number; used: number; available: number }>
      }
      window: {
        minimize:          () => void
        maximize:          () => void
        close:             () => void
        isMaximized:       () => Promise<boolean>
        onMaximizeChange:  (cb: (isMaximized: boolean) => void) => void
        offMaximizeChange: () => void
      }
      ui: {
        setZoomFactor: (factor: number) => void
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
        selectMeshFile:  () => Promise<string | null>
        saveModel:       (defaultName: string) => Promise<string | null>
        readFileBase64:  (filePath: string) => Promise<string>
        selectDirectory: (defaultPath?: string) => Promise<string | null>
        savePath:        (args: { filters: { name: string; extensions: string[] }[]; defaultPath?: string }) => Promise<string | null>
        listDir:         (dirPath: string) => Promise<string[]>
        listFiles:       (dirPath: string, extensions?: string[]) => Promise<string[]>
        selectTextFile:  () => Promise<string | null>
        moveDirectory:   (args: { src: string; dest: string }) => Promise<{ success: boolean; error?: string }>
        deleteDirectory: (dirPath: string) => Promise<{ success: boolean; error?: string }>
        readScreenshotDataUrl: (filename: string) => Promise<string>
      }
      settings: {
        get: () => Promise<{ modelsDir: string; workspaceDir: string; workflowsDir: string; extensionsDir: string; hfToken?: string }>
        set: (patch: { modelsDir?: string; workspaceDir?: string; workflowsDir?: string; extensionsDir?: string; hfToken?: string }) => Promise<{ modelsDir: string; workspaceDir: string; workflowsDir: string; extensionsDir: string; hfToken?: string }>
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
        activeDownloads: () => Promise<{ modelId: string; percent: number; file?: string; fileIndex?: number; totalFiles?: number }[]>
        isDownloaded:   (modelId: string, downloadCheck?: string) => Promise<boolean>
        download:       (repoId: string, modelId: string, skipPrefixes?: string[], includePrefixes?: string[]) => Promise<{ success: boolean; error?: string }>
        pauseDownload:  (modelId: string) => Promise<{ success: boolean; error?: string }>
        cancelDownload: (modelId: string) => Promise<{ success: boolean; error?: string }>
        delete:         (modelId: string) => Promise<{ success: boolean; error?: string }>
        unloadAll:      () => Promise<{ success: boolean; error?: string }>
        showInFolder:   (modelId: string) => Promise<void>
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
        }) => void) => void
        offProgress:    () => void
      }
      app: {
        info: () => Promise<{
          version:   string
          userData:  string
          modelsDir: string
          apiUrl:    string
          platform:  string
          arch:      string
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
        library: {
          list: () => Promise<AssetLibraryListResult>
          read: (request: AssetLibraryReadRequest) => Promise<AssetLibraryReadResult>
          open: (request: AssetLibraryOpenRequest) => Promise<AssetLibraryOpenResult>
        }
      }
      setup: {
        check:        () => Promise<{ needed: boolean; defaultDataDir: string; platform: string; arch: string }>
        run:          () => Promise<{ success: boolean; error?: string }>
        saveDataDir:  (baseDir: string) => Promise<void>
        onProgress:   (cb: (data: { step: string; percent: number; currentPackage?: string }) => void) => void
        offProgress:  () => void
        onComplete:   (cb: () => void) => void
        offComplete:  () => void
        onError:      (cb: (data: { message: string }) => void) => void
        offError:     () => void
      }
      workflows: {
        list:   () => Promise<Workflow[]>
        save:   (workflow: Workflow) => Promise<{ success: boolean; error?: string }>
        delete: (id: string)        => Promise<{ success: boolean; error?: string }>
        import: ()                  => Promise<{ success: boolean; error?: string; workflow?: Workflow }>
        export: (workflow: Workflow) => Promise<{ success: boolean; error?: string }>
      }
      updater: {
        check:                 () => Promise<{ success: boolean }>
        quitAndInstall:        () => Promise<void>
        onApplying:            (cb: (data: { version: string }) => void) => void
        offApplying:           () => void
        onMajorMinorAvailable: (cb: (data: { version: string }) => void) => void
        offMajorMinorAvailable: () => void
      }
      extensions: {
        list:              () => Promise<AnyExtension[]>
        installFromGitHub: (url: string) => Promise<{
          success:      boolean
          error?:       string
          cancelled?:   boolean
          extensionId?: string
          extension?:   AnyExtension
        }>
        installFromLocal:  () => Promise<{
          success:      boolean
          error?:       string
          cancelled?:   boolean
          extensionId?: string
          extension?:   AnyExtension
          localPath?:   string
        }>
        uninstall:   (extensionId: string) => Promise<{ success: boolean; error?: string }>
        repair:      (extensionId: string) => Promise<{ success: boolean; error?: string }>
        reload:      () => Promise<{ success: boolean; error?: string; errors?: Record<string, string> }>
        runProcess:  (extensionId: string, input: ProcessInput, params: Record<string, unknown>) => Promise<{ success: boolean; result?: ProcessResult; error?: string }>
        onInstallProgress: (cb: (data: {
          step:          'downloading' | 'extracting' | 'validating' | 'setting_up' | 'done' | 'error'
          percent?:      number
          extensionId?:  string
          message?:      string
        }) => void) => void
        offInstallProgress: () => void
      }
    }
  }
}

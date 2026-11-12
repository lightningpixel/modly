import type { AnyExtension, ExtensionNode, Workflow } from '../../types/electron.d'
import type { AgentActionPayload, ClientToolEvent } from '../../utils/agentStream'
import type { GenerationOptions, UiScale } from '../../stores/appStore'
import type { Page } from '../../stores/navStore'
import type { GenerationApi, GenerationStoreActions } from '../../utils/generationRunner'
import { createGenerationApi, runGeneration } from '../../utils/generationRunner'
import { useAppStore } from '../../stores/appStore'
import { useExtensionsStore } from '../../stores/extensionsStore'
import { useWorkflowsStore } from '../../stores/workflowsStore'
import { useNavStore } from '../../stores/navStore'
import { redoDepth, undoDepth } from '../../stores/meshHistory'
import { showCompletionNotification, showRunErrorNotification } from '../../utils/notification'

// Tools the agent asks the frontend to run, because they need IPC or the
// renderer stores. Every handler returns the text sent back to the LLM and
// never throws: failures come back as text starting with "Error: ".

// ─── Dependencies ─────────────────────────────────────────────────────────────

type OpResult = { success: boolean; error?: string }

export type StorageKind = 'models' | 'workspace' | 'workflows'

export interface StorageDirs {
  modelsDir: string
  workspaceDir: string
  workflowsDir: string
  extensionsDir: string
}

export interface UiSettings {
  uiScale: UiScale
  useAtkinsonFont: boolean
  showRamIndicator: boolean
}

export interface ToolResultBody {
  call_id: string
  result: string
  error?: boolean
}

export interface ClientToolDeps {
  extensions: {
    list: () => AnyExtension[]
    installFromGitHub: (url: string) => Promise<OpResult & { extensionId?: string; extension?: AnyExtension }>
    uninstall: (extensionId: string) => Promise<OpResult>
    reload: () => Promise<void>
    loadErrors: () => Record<string, string>
  }
  weights: {
    download: (modelId: string, variantId?: string) => Promise<OpResult & { paused?: boolean; cancelled?: boolean }>
    delete: (modelId: string) => Promise<OpResult>
    deleteVariant: (modelId: string, variantId: string) => Promise<OpResult>
    deleteExtensionWeights: (extensionId: string) => Promise<OpResult>
    /** Re-reads what is installed, so the Models page stays accurate. */
    refresh: () => Promise<void>
  }
  workflows: {
    list: () => Workflow[]
    remove: (id: string) => Promise<OpResult>
    /** Opens the workflow as the active editor tab, without changing page. */
    open: (id: string) => void
    reload: () => Promise<void>
  }
  ui: {
    get: () => UiSettings
    setUiScale: (value: UiScale) => void
    setUseAtkinsonFont: (value: boolean) => void
    setShowRamIndicator: (value: boolean) => void
  }
  storage: {
    get: () => Promise<StorageDirs>
    listDir: (dirPath: string) => Promise<string[]>
    moveDirectory: (args: { src: string; dest: string }) => Promise<OpResult>
    /** Saves the new folder, the way Settings > Storage does once files are moved. */
    apply: (kind: StorageKind, path: string) => Promise<void>
  }
  mesh: {
    /** Steps available each way on the mesh undo stack. */
    history: () => { undo: number; redo: number }
    undo: () => void
    redo: () => void
  }
  navigate: (page: Page) => void
  postResult: (body: ToolResultBody) => Promise<void>
  /** How long a download is watched for an early failure before it is reported as started. */
  downloadSettleMs?: number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

type Args = Record<string, unknown>

const ERROR_PREFIX = 'Error: '

const fail = (message: string): string => ERROR_PREFIX + message

/** True for a result text that reports a failure. */
export function isErrorResult(result: string): boolean {
  return result.startsWith(ERROR_PREFIX)
}

const quote = (s: string): string => `“${s}”`

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function str(args: Args, key: string): string | null {
  const value = args[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function nodeHasManagedWeights(node: ExtensionNode): boolean {
  return Boolean(node.hfRepo || node.hasModelSources || node.weightGroups?.length)
}

function listOf(items: string[]): string {
  return items.length ? items.join(', ') : 'none'
}

function findExtension(id: string, deps: ClientToolDeps | undefined): AnyExtension | undefined {
  return deps?.extensions.list().find((e) => e.id === id.split('/')[0])
}

function extensionLabel(id: string, deps: ClientToolDeps | undefined): string {
  const ext = findExtension(id, deps)
  if (!ext) return quote(id)
  const nodeId = id.includes('/') ? id.slice(id.indexOf('/') + 1) : null
  const node = nodeId ? ext.nodes.find((n) => n.id === nodeId) : undefined
  return quote(node ? `${ext.name} / ${node.name}` : ext.name)
}

function workflowLabel(id: string, deps: ClientToolDeps | undefined): string {
  return quote(deps?.workflows.list().find((w) => w.id === id)?.name ?? id)
}

function lookupExtension(args: Args, deps: ClientToolDeps): { ext: AnyExtension; id: string } | string {
  const id = str(args, 'extension_id')
  if (!id) return 'extension_id is required.'
  const ext = findExtension(id, deps)
  if (!ext) {
    const installed = deps.extensions.list().map((e) => e.id)
    return `No installed extension has the id ${quote(id)}. Installed extensions: ${listOf(installed)}.`
  }
  return { ext, id }
}

function lookupWorkflow(args: Args, deps: ClientToolDeps): Workflow | string {
  const id = str(args, 'workflow_id')
  if (!id) return 'workflow_id is required.'
  const workflows = deps.workflows.list()
  const wf = workflows.find((w) => w.id === id)
  if (!wf) {
    return `No workflow has the id ${quote(id)}. Workflows: ${listOf(workflows.map((w) => `${w.name} (${w.id})`))}.`
  }
  return wf
}

interface WeightTarget {
  ext: AnyExtension
  /** Set when the id named one model ("ext/node") rather than the whole extension. */
  nodeId: string | null
  variant: string | null
  nodes: { fullId: string; node: ExtensionNode }[]
}

function lookupWeights(args: Args, deps: ClientToolDeps): WeightTarget | string {
  const found = lookupExtension(args, deps)
  if (typeof found === 'string') return found
  const { ext, id } = found
  if (args.variant !== undefined && args.variant !== null && typeof args.variant !== 'string') {
    return 'variant must be a string.'
  }
  const variant = str(args, 'variant')
  if (ext.type !== 'model') return `${quote(ext.name)} is a process extension; it has no model weights.`

  const nodeId = id.includes('/') ? id.slice(id.indexOf('/') + 1) : null
  let nodes = ext.nodes.filter(nodeHasManagedWeights)
  if (nodeId) {
    nodes = nodes.filter((n) => n.id === nodeId)
    if (!nodes.length) {
      const models = ext.nodes.filter(nodeHasManagedWeights).map((n) => `${ext.id}/${n.id}`)
      return `${quote(ext.name)} has no model ${quote(nodeId)} with weights. Models with weights: ${listOf(models)}.`
    }
  }
  if (!nodes.length) return `${quote(ext.name)} has no downloadable model weights.`
  if (variant) {
    const offered = [...new Set(nodes.flatMap((n) => n.weightVariants?.options.map((o) => o.id) ?? []))]
    nodes = nodes.filter((n) => n.weightVariants?.options.some((o) => o.id === variant))
    if (!nodes.length) {
      return offered.length
        ? `${quote(ext.name)} has no weight variant ${quote(variant)}. Available variants: ${listOf(offered)}.`
        : `${quote(ext.name)} does not offer weight variants.`
    }
  }
  return { ext, nodeId, variant, nodes: nodes.map((node) => ({ fullId: `${ext.id}/${node.id}`, node })) }
}

function weightsLabel(args: Args, deps: ClientToolDeps | undefined): string {
  const id = typeof args.extension_id === 'string' ? args.extension_id : '?'
  const variant = typeof args.variant === 'string' && args.variant ? ` (variant ${quote(args.variant)})` : ''
  return `${extensionLabel(id, deps)}${variant}`
}

const sleep = (ms: number): Promise<null> => new Promise((r) => setTimeout(() => r(null), ms))

// ─── Paths ────────────────────────────────────────────────────────────────────

const STORAGE_KINDS: StorageKind[] = ['models', 'workspace', 'workflows']

const STORAGE_KEY: Record<StorageKind, keyof StorageDirs> = {
  models: 'modelsDir',
  workspace: 'workspaceDir',
  workflows: 'workflowsDir',
}

function isAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/')
}

/** Comparable form: forward slashes, no trailing slash, Windows paths lower-cased. */
function normPath(p: string): string {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[A-Za-z]:/.test(s) || s.startsWith('//') ? s.toLowerCase() : s
}

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}/`)
}

// ─── Registry ─────────────────────────────────────────────────────────────────

export interface ClientTool {
  /** Destructive: the confirm card shows a red Confirm button. */
  destructive: boolean
  /** The human sentence for the confirm card and the action list. */
  describe: (args: Args, deps?: ClientToolDeps) => string
  /** Why the arguments cannot be run, or null when they can. */
  check: (args: Args, deps: ClientToolDeps) => string | null
  /** Runs the tool; returns the result text for the LLM and never throws. */
  run: (args: Args, deps: ClientToolDeps) => Promise<string>
}

interface ToolSpec {
  destructive?: boolean
  describe: (args: Args, deps?: ClientToolDeps) => string
  check: (args: Args, deps: ClientToolDeps) => string | null
  execute: (args: Args, deps: ClientToolDeps) => Promise<string>
}

function defineTool(spec: ToolSpec): ClientTool {
  return {
    destructive: spec.destructive ?? false,
    describe: spec.describe,
    check: (args, deps) => {
      try {
        return spec.check(args, deps)
      } catch (err) {
        return errorText(err)
      }
    },
    run: async (args, deps) => {
      try {
        const problem = spec.check(args, deps)
        if (problem) return fail(problem)
        return await spec.execute(args, deps)
      } catch (err) {
        return fail(errorText(err))
      }
    },
  }
}

const checked = <T>(value: T | string): string | null => (typeof value === 'string' ? value : null)

export const clientTools: Record<string, ClientTool> = {
  install_extension: defineTool({
    describe: (args) => `Install the extension from ${quote(String(args.github_url ?? '?'))}`,
    check: (args) => {
      const url = str(args, 'github_url')
      if (!url) return 'github_url is required.'
      let host: string
      try {
        host = new URL(url).hostname.toLowerCase()
      } catch {
        return `${quote(url)} is not a valid URL.`
      }
      return host === 'github.com' || host === 'www.github.com' ? null : 'github_url must be a github.com repository URL.'
    },
    async execute(args, deps) {
      const result = await deps.extensions.installFromGitHub(str(args, 'github_url')!)
      if (!result.success) return fail(result.error ?? 'Installation failed.')
      const ext = result.extension
      const id = ext?.id ?? result.extensionId ?? '?'
      const needsWeights = ext?.type === 'model' && ext.nodes.some(nodeHasManagedWeights)
      return `Installed the extension ${quote(ext?.name ?? id)} (id ${id}).`
        + (needsWeights ? ' Its model weights are not downloaded yet; download_model_weights fetches them.' : '')
    },
  }),

  uninstall_extension: defineTool({
    destructive: true,
    describe: (args, deps) => `Uninstall the extension ${extensionLabel(String(args.extension_id ?? '?'), deps)}`,
    check: (args, deps) => {
      const found = lookupExtension(args, deps)
      if (typeof found === 'string') return found
      return found.ext.builtin ? `${quote(found.ext.name)} is built into Modly and cannot be uninstalled.` : null
    },
    async execute(args, deps) {
      const { ext } = lookupExtension(args, deps) as { ext: AnyExtension }
      const result = await deps.extensions.uninstall(ext.id)
      if (!result.success) return fail(result.error ?? `Could not uninstall ${quote(ext.name)}.`)
      return `Uninstalled the extension ${quote(ext.name)}. Its downloaded model weights, if any, were left on disk.`
    },
  }),

  reload_extensions: defineTool({
    describe: () => 'Reload the installed extensions',
    check: () => null,
    async execute(_args, deps) {
      await deps.extensions.reload()
      const count = deps.extensions.list().length
      const errors = Object.entries(deps.extensions.loadErrors())
      const tail = errors.length
        ? ` ${errors.length} failed to load: ${errors.map(([id, err]) => `${id} (${err})`).join('; ')}.`
        : ''
      return `Reloaded the extensions: ${count} installed.${tail}`
    },
  }),

  download_model_weights: defineTool({
    describe: (args, deps) => `Download the model weights of ${weightsLabel(args, deps)}`,
    check: (args, deps) => checked(lookupWeights(args, deps)),
    async execute(args, deps) {
      const target = lookupWeights(args, deps) as WeightTarget
      const variant = target.variant ?? undefined
      // Downloads run one after the other, as "Install all" does on the Models page.
      const queue = (async () => {
        const outcomes: { fullId: string; result: OpResult & { paused?: boolean; cancelled?: boolean } }[] = []
        for (const { fullId } of target.nodes) {
          let result: OpResult & { paused?: boolean; cancelled?: boolean }
          try {
            result = await deps.weights.download(fullId, variant)
          } catch (err) {
            result = { success: false, error: errorText(err) }
          }
          outcomes.push({ fullId, result })
        }
        await deps.weights.refresh().catch(() => {})
        return outcomes
      })()
      const outcomes = await Promise.race([queue, sleep(deps.downloadSettleMs ?? 1500)])
      const label = weightsLabel(args, deps)
      if (!outcomes) {
        return `Started downloading the model weights of ${label} (${target.nodes.length} model${target.nodes.length > 1 ? 's' : ''}). `
          + 'The download continues in the background; its progress shows on the Models page.'
      }
      const failed = outcomes.filter((o) => !o.result.success && !o.result.paused && !o.result.cancelled)
      if (failed.length) {
        return fail(`Downloading ${label} failed: ${failed.map((o) => `${o.fullId}: ${o.result.error ?? 'unknown error'}`).join('; ')}.`)
      }
      if (outcomes.some((o) => o.result.paused || o.result.cancelled)) {
        return `The download of ${label} was paused or cancelled before it finished.`
      }
      return `Downloaded the model weights of ${label}.`
    },
  }),

  delete_model_weights: defineTool({
    destructive: true,
    describe: (args, deps) => `Delete the downloaded model weights of ${weightsLabel(args, deps)}`,
    check: (args, deps) => checked(lookupWeights(args, deps)),
    async execute(args, deps) {
      const target = lookupWeights(args, deps) as WeightTarget
      const label = weightsLabel(args, deps)
      const results: OpResult[] = []
      if (target.variant) {
        for (const { fullId } of target.nodes) results.push(await deps.weights.deleteVariant(fullId, target.variant))
      } else if (!target.nodeId && target.ext.type === 'model' && target.ext.weightGroups?.length) {
        // Shared weight groups: the whole-extension delete, as the uninstall dialog does.
        results.push(await deps.weights.deleteExtensionWeights(target.ext.id))
      } else {
        for (const { fullId } of target.nodes) results.push(await deps.weights.delete(fullId))
      }
      await deps.weights.refresh().catch(() => {})
      const errors = results.filter((r) => !r.success).map((r) => r.error ?? 'unknown error')
      if (errors.length) return fail(`Deleting the weights of ${label} failed: ${errors.join('; ')}.`)
      return `Deleted the downloaded model weights of ${label}.`
    },
  }),

  delete_workflow: defineTool({
    destructive: true,
    describe: (args, deps) => `Delete the workflow ${workflowLabel(String(args.workflow_id ?? '?'), deps)}`,
    check: (args, deps) => checked(lookupWorkflow(args, deps)),
    async execute(args, deps) {
      const wf = lookupWorkflow(args, deps) as Workflow
      const result = await deps.workflows.remove(wf.id)
      if (!result.success) return fail(result.error ?? `Could not delete the workflow ${quote(wf.name)}.`)
      return `Deleted the workflow ${quote(wf.name)}.`
    },
  }),

  open_workflow: defineTool({
    describe: (args, deps) => `Open the workflow ${workflowLabel(String(args.workflow_id ?? '?'), deps)}`,
    check: (args, deps) => checked(lookupWorkflow(args, deps)),
    async execute(args, deps) {
      const wf = lookupWorkflow(args, deps) as Workflow
      deps.workflows.open(wf.id)
      return `Opened the workflow ${quote(wf.name)} as the active tab of the Workflows editor. The current page did not change.`
    },
  }),

  set_setting: defineTool({
    describe: (args) => `Set ${SETTING_LABELS[String(args.key)] ?? String(args.key ?? '?')} to ${JSON.stringify(args.value)}`,
    check: (args) => {
      const key = args.key
      if (typeof key !== 'string' || !(key in SETTING_LABELS)) {
        return `key must be one of: ${Object.keys(SETTING_LABELS).join(', ')}.`
      }
      if (key === 'uiScale') {
        return UI_SCALES.includes(args.value as UiScale) ? null : `uiScale must be one of: ${UI_SCALES.join(', ')}.`
      }
      return toBool(args.value) === null ? `${key} must be true or false.` : null
    },
    async execute(args, deps) {
      const key = args.key as keyof UiSettings
      if (key === 'uiScale') deps.ui.setUiScale(args.value as UiScale)
      else if (key === 'useAtkinsonFont') deps.ui.setUseAtkinsonFont(toBool(args.value)!)
      else deps.ui.setShowRamIndicator(toBool(args.value)!)
      return `Set ${SETTING_LABELS[key]} to ${JSON.stringify(deps.ui.get()[key])}.`
    },
  }),

  set_storage_folder: defineTool({
    destructive: true,
    describe: (args) => `Change the ${String(args.kind ?? '?')} folder to ${quote(String(args.path ?? '?'))}, moving its current files there`,
    check: (args) => {
      if (!STORAGE_KINDS.includes(args.kind as StorageKind)) return `kind must be one of: ${STORAGE_KINDS.join(', ')}.`
      const path = str(args, 'path')
      if (!path) return 'path is required.'
      return isAbsolutePath(path) ? null : `${quote(path)} is not an absolute path.`
    },
    async execute(args, deps) {
      const kind = args.kind as StorageKind
      const path = str(args, 'path')!
      const dirs = await deps.storage.get()
      const current = dirs[STORAGE_KEY[kind]]
      const next = normPath(path)
      if (current && normPath(current) === next) return `The ${kind} folder is already ${quote(current)}; nothing changed.`
      if (current && (isInside(next, normPath(current)) || isInside(normPath(current), next))) {
        return fail(`${quote(path)} overlaps the current ${kind} folder ${quote(current)}; choose a folder outside it. Nothing changed.`)
      }
      for (const [key, dir] of Object.entries(dirs) as [keyof StorageDirs, string][]) {
        if (key === STORAGE_KEY[kind] || !dir) continue
        if (isInside(next, normPath(dir)) || isInside(normPath(dir), next)) {
          return fail(`${quote(path)} overlaps another Modly folder (${quote(dir)}); choose a separate folder. Nothing changed.`)
        }
      }

      const items = current ? await deps.storage.listDir(current).catch(() => [] as string[]) : []
      if (items.length > 0) {
        const moved = await deps.storage.moveDirectory({ src: current, dest: path })
        if (!moved.success) {
          return fail(`Could not move the ${kind} files to ${quote(path)}: ${moved.error ?? 'unknown error'}. Nothing changed.`)
        }
      }
      try {
        await deps.storage.apply(kind, path)
      } catch (err) {
        return fail(items.length
          ? `Moved the ${kind} files to ${quote(path)}, but saving the new folder failed: ${errorText(err)}. Set it in Settings > Storage.`
          : `Saving the new ${kind} folder failed: ${errorText(err)}. Nothing changed.`)
      }
      return items.length
        ? `Moved ${items.length} item${items.length > 1 ? 's' : ''} from ${quote(current)} and set the ${kind} folder to ${quote(path)}.`
        : `Set the ${kind} folder to ${quote(path)}.`
    },
  }),

  undo_mesh: defineTool({
    describe: () => 'Undo the last mesh change',
    check: () => null,
    async execute(_args, deps) {
      if (deps.mesh.history().undo <= 0) return 'There is no mesh change to undo.'
      deps.mesh.undo()
      return 'Undid the last mesh change; the viewer shows the previous mesh.'
    },
  }),

  redo_mesh: defineTool({
    describe: () => 'Redo the mesh change',
    check: () => null,
    async execute(_args, deps) {
      if (deps.mesh.history().redo <= 0) return 'There is no mesh change to redo.'
      deps.mesh.redo()
      return 'Redid the mesh change; the viewer shows the next mesh.'
    },
  }),

  navigate: defineTool({
    describe: (args) => `Go to the ${String(args.page ?? '?')} page`,
    check: (args) => (PAGES.includes(args.page as Page) ? null : `page must be one of: ${PAGES.join(', ')}.`),
    async execute(args, deps) {
      deps.navigate(args.page as Page)
      return `Opened the ${String(args.page)} page.`
    },
  }),
}

const SETTING_LABELS: Record<string, string> = {
  uiScale: 'the interface scale',
  useAtkinsonFont: 'the Atkinson Hyperlegible font',
  showRamIndicator: 'the RAM indicator',
}

const UI_SCALES: UiScale[] = ['small', 'medium', 'large', 'very-large']

const PAGES: Page[] = ['generate', 'workflows', 'models', 'settings']

function toBool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return null
}

/** The sentence for a tool call; falls back to the tool name for an unknown tool. */
export function describeClientTool(tool: string, args: Args, deps?: ClientToolDeps): string {
  const entry = clientTools[tool]
  if (!entry) return tool.replace(/_/g, ' ')
  try {
    return entry.describe(args ?? {}, deps)
  } catch {
    return tool.replace(/_/g, ' ')
  }
}

// ─── Running a client_tool event ──────────────────────────────────────────────

export interface ConfirmInfo {
  tool: string
  /** The `client_tool` event id, which the later `tool_done` carries too. */
  id: string
  callId: string
  destructive: boolean
}

export type ConfirmFn = (description: string, info?: ConfirmInfo) => Promise<boolean>

export interface ClientToolOutcome {
  description: string
  result: string
  error: boolean
  declined: boolean
  /** False when the result could not be sent back to the server. */
  posted: boolean
}

/**
 * Runs one `client_tool` event: asks for confirmation when the server says so,
 * runs the tool, then posts the result to `/agent/tool-result`. Never throws.
 */
export async function runClientTool(
  event: Pick<ClientToolEvent, 'id' | 'call_id' | 'tool' | 'arguments' | 'confirm'>,
  deps: ClientToolDeps,
  confirm: ConfirmFn,
): Promise<ClientToolOutcome> {
  const tool = clientTools[event.tool]
  const args: Args = event.arguments && typeof event.arguments === 'object' && !Array.isArray(event.arguments)
    ? event.arguments
    : {}
  const description = describeClientTool(event.tool, args, deps)
  let result: string
  let declined = false

  if (!tool) {
    result = fail(`Unknown client tool ${quote(event.tool)}. Client tools: ${Object.keys(clientTools).join(', ')}.`)
  } else {
    const problem = tool.check(args, deps)
    if (problem) {
      // Nothing to confirm: the call cannot run as given.
      result = fail(problem)
    } else {
      let ok = true
      if (event.confirm) {
        try {
          ok = await confirm(description, { tool: event.tool, id: event.id, callId: event.call_id, destructive: tool.destructive })
        } catch {
          ok = false
        }
      }
      if (ok) {
        result = await tool.run(args, deps)
      } else {
        declined = true
        result = `The user declined: ${description}.`
      }
    }
  }

  const error = isErrorResult(result)
  let posted = true
  try {
    await deps.postResult({ call_id: event.call_id, result, ...(error ? { error: true } : {}) })
  } catch {
    posted = false
  }
  return { description, result, error, declined, posted }
}

// ─── generate_from_image ──────────────────────────────────────────────────────

export interface GenerationDeps {
  api: GenerationApi
  store: GenerationStoreActions
  /** The Generate page's current options (model, remesh, texture, params). */
  options: () => GenerationOptions
  notifyComplete: (body: string) => void | Promise<void>
  notifyError: (error: string | undefined, modelId: string) => void | Promise<void>
  isCancelled?: () => boolean
  wait?: () => Promise<void>
}

/** The first image of the most recent user message that has one. */
export function latestUserImage(messages: { role: string; imageDataUrls?: string[] }[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'user' && m.imageDataUrls?.length) return m.imageDataUrls[0]
  }
  return undefined
}

/**
 * Runs a `generate_from_image` payload through the Generate page's own path,
 * so the result appears in its viewer. `image` is a data URL or bare base64.
 * Resolves once the generation ends, with a sentence describing the outcome.
 */
export async function startGenerationFromImage(
  payload: AgentActionPayload | null | undefined,
  image: string | undefined,
  deps: GenerationDeps,
): Promise<string> {
  if (payload?.type !== 'generate_from_image') return fail('Not a generate_from_image payload.')
  const base64 = image?.startsWith('data:') ? image.slice(image.indexOf(',') + 1) : image
  if (!base64) return fail('No image is attached to the conversation; attach one and ask again.')

  const current = deps.options()
  const modelId = payload.model_id || current.modelId
  if (!modelId) return fail('No generation model is selected or downloaded.')
  const options: GenerationOptions = {
    ...current,
    modelId,
    // Saved params belong to the selected model; another model starts from its defaults.
    modelParams: { ...(modelId === current.modelId ? current.modelParams : {}), ...(payload.params ?? {}) },
  }

  try {
    const outcome = await runGeneration('agent-image.png', options, base64, {
      api: deps.api,
      store: deps.store,
      notifyComplete: deps.notifyComplete,
      notifyError: deps.notifyError,
      isCancelled: deps.isCancelled ?? (() => false),
      wait: deps.wait,
    })
    if (outcome.status === 'done') return `Generated a mesh with ${modelId}${outcome.outputUrl ? `: ${outcome.outputUrl}` : ''}.`
    if (outcome.status === 'cancelled') return 'The generation was cancelled.'
    return fail(`The generation failed: ${outcome.error}`)
  } catch (err) {
    return fail(`The generation failed: ${errorText(err)}`)
  }
}

// ─── App wiring ───────────────────────────────────────────────────────────────

/** The real dependencies: stores, IPC and the local API. */
export function createClientToolDeps(): ClientToolDeps {
  const ext = () => useExtensionsStore.getState()
  const app = () => useAppStore.getState()
  const wfs = () => useWorkflowsStore.getState()
  return {
    extensions: {
      list: () => [...ext().modelExtensions, ...ext().processExtensions],
      installFromGitHub: (url) => ext().installFromGitHub(url),
      uninstall: (id) => ext().uninstall(id),
      reload: () => ext().reload(),
      loadErrors: () => ext().loadErrors,
    },
    weights: {
      download: (modelId, variantId) => window.electron.model.download(modelId, variantId),
      delete: (modelId) => window.electron.model.delete(modelId),
      deleteVariant: (modelId, variantId) => window.electron.model.deleteWeightVariant(modelId, variantId),
      deleteExtensionWeights: (extensionId) => window.electron.model.deleteExtensionWeights(extensionId),
      refresh: () => ext().refreshInstalledWeightVariants(),
    },
    workflows: {
      list: () => wfs().workflows,
      remove: (id) => wfs().remove(id),
      open: (id) => wfs().openWorkflow(id),
      reload: () => wfs().load(),
    },
    ui: {
      get: () => ({ uiScale: app().uiScale, useAtkinsonFont: app().useAtkinsonFont, showRamIndicator: app().showRamIndicator }),
      setUiScale: (v) => app().setUiScale(v),
      setUseAtkinsonFont: (v) => app().setUseAtkinsonFont(v),
      setShowRamIndicator: (v) => app().setShowRamIndicator(v),
    },
    storage: {
      get: () => window.electron.settings.get(),
      listDir: (dirPath) => window.electron.fs.listDir(dirPath),
      moveDirectory: (args) => window.electron.fs.moveDirectory(args),
      async apply(kind, path) {
        // Same calls as Settings > Storage.
        if (kind === 'models') {
          await window.electron.settings.set({ modelsDir: path })
          await window.electron.api.updatePaths({ modelsDir: path })
        } else if (kind === 'workspace') {
          await window.electron.settings.set({ workspaceDir: path })
          await window.electron.api.updatePaths({ workspaceDir: path })
        } else {
          await window.electron.settings.set({ workflowsDir: path })
          await wfs().load()
        }
      },
    },
    mesh: {
      history: () => ({ undo: undoDepth(app().meshHistory), redo: redoDepth(app().meshHistory) }),
      undo: () => app().undoMesh(),
      redo: () => app().redoMesh(),
    },
    navigate: (page) => useNavStore.getState().navigate(page),
    async postResult(body) {
      const res = await fetch(`${app().apiUrl}/agent/tool-result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`API error ${res.status}`)
    },
  }
}

/** The real dependencies of startGenerationFromImage. */
export function createGenerationDeps(): GenerationDeps {
  const app = () => useAppStore.getState()
  return {
    api: createGenerationApi(app().apiUrl),
    store: {
      setCurrentJob: (job) => app().setCurrentJob(job),
      updateCurrentJob: (patch) => app().updateCurrentJob(patch),
      pushMeshUrl: (url) => app().pushMeshUrl(url),
      clearMeshHistory: () => app().clearMeshHistory(),
    },
    options: () => app().generationOptions,
    notifyComplete: (body) => showCompletionNotification(body),
    notifyError: (error, modelId) => showRunErrorNotification({ title: 'Generation failed', name: modelId, error }),
  }
}

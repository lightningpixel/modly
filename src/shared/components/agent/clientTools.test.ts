import assert from 'node:assert/strict'
import test from 'node:test'

import {
  clientTools,
  describeClientTool,
  isErrorResult,
  latestUserImage,
  runClientTool,
  startGenerationFromImage,
} from './clientTools'
import type { ClientToolDeps, GenerationDeps, StorageKind, ToolResultBody } from './clientTools'
import type { AnyExtension, Workflow } from '../../types/electron.d'
import type { GenerationJob, GenerationOptions, UiScale } from '../../stores/appStore'

// ─── Fakes ────────────────────────────────────────────────────────────────────

const node = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: id.toUpperCase(), input: 'image', output: 'mesh', paramsSchema: [], ...extra,
})

function extensions(): AnyExtension[] {
  return [
    {
      type: 'model', id: 'triposr', name: 'TripoSR', trusted: true, builtin: false,
      nodes: [node('main', { hfRepo: 'stabilityai/TripoSR' })],
    },
    {
      type: 'model', id: 'hunyuan', name: 'Hunyuan3D', trusted: true, builtin: false,
      nodes: [
        node('shape', { hfRepo: 'tencent/h', weightVariants: { param: 'v', default: 'full', options: [{ id: 'full', label: 'Full' }, { id: 'mini', label: 'Mini' }] } }),
        node('paint', { hfRepo: 'tencent/p' }),
      ],
    },
    {
      type: 'model', id: 'shared', name: 'Shared', trusted: true, builtin: false,
      weightGroups: [{ id: 'g', dependentNodeIds: ['a'] }],
      nodes: [node('a', { weightGroups: ['g'] })],
    },
    {
      type: 'process', id: 'mesh-ops', name: 'Mesh Ops', trusted: true, builtin: true, entry: 'x',
      nodes: [node('decimate')],
    },
  ] as AnyExtension[]
}

const workflow = (id: string, name: string): Workflow => ({
  id, name, description: '', nodes: [], edges: [], createdAt: '', updatedAt: '',
})

interface Fake {
  deps: ClientToolDeps
  calls: unknown[][]
  posted: ToolResultBody[]
  ui: { uiScale: UiScale; useAtkinsonFont: boolean; showRamIndicator: boolean }
  dirs: { modelsDir: string; workspaceDir: string; workflowsDir: string; extensionsDir: string }
  history: { undo: number; redo: number }
  dirItems: Record<string, string[]>
}

function fake(overrides: Partial<ClientToolDeps> = {}): Fake {
  const calls: unknown[][] = []
  const posted: ToolResultBody[] = []
  const rec = (...call: unknown[]) => { calls.push(call) }
  const ok = { success: true }
  const state = {
    ui: { uiScale: 'medium' as UiScale, useAtkinsonFont: false, showRamIndicator: true },
    dirs: { modelsDir: 'C:\\Modly\\models', workspaceDir: 'C:\\Modly\\workspace', workflowsDir: 'C:\\Modly\\workflows', extensionsDir: 'C:\\Modly\\extensions' },
    history: { undo: 1, redo: 1 },
    dirItems: {} as Record<string, string[]>,
  }
  const list = extensions()
  const wfs = [workflow('wf1', 'Turntable'), workflow('wf2', 'Cleanup')]
  const deps: ClientToolDeps = {
    extensions: {
      list: () => list,
      installFromGitHub: async (url) => {
        rec('install', url)
        return { success: true, extensionId: 'sf3d', extension: { type: 'model', id: 'sf3d', name: 'SF3D', trusted: false, builtin: false, nodes: [node('main', { hfRepo: 'x/y' })] } as AnyExtension }
      },
      uninstall: async (id) => { rec('uninstall', id); return ok },
      reload: async () => { rec('reload') },
      loadErrors: () => ({ broken: 'bad manifest' }),
    },
    weights: {
      download: async (id, variant) => { rec('download', id, variant); return ok },
      delete: async (id) => { rec('delete', id); return ok },
      deleteVariant: async (id, variant) => { rec('deleteVariant', id, variant); return ok },
      deleteExtensionWeights: async (id) => { rec('deleteExtensionWeights', id); return ok },
      refresh: async () => { rec('refresh') },
    },
    workflows: {
      list: () => wfs,
      remove: async (id) => { rec('removeWorkflow', id); return ok },
      open: (id) => { rec('openWorkflow', id) },
      reload: async () => { rec('reloadWorkflows') },
    },
    ui: {
      get: () => state.ui,
      setUiScale: (v) => { state.ui.uiScale = v },
      setUseAtkinsonFont: (v) => { state.ui.useAtkinsonFont = v },
      setShowRamIndicator: (v) => { state.ui.showRamIndicator = v },
    },
    storage: {
      get: async () => state.dirs,
      entries: async (kind: StorageKind) => ({ modly: state.dirItems[kind] ?? [], other: [] }),
      checkLocation: async (path: string) => (path.startsWith('C:\\Windows') ? { ok: false, error: 'This is a system folder.' } : { ok: true }),
      moveDirectory: async (args) => { rec('move', args.src, args.dest); return ok },
      apply: async (kind: StorageKind, path: string) => { rec('applyStorage', kind, path) },
    },
    mesh: {
      history: () => state.history,
      undo: () => { rec('undo') },
      redo: () => { rec('redo') },
    },
    navigate: (page) => { rec('navigate', page) },
    postResult: async (body) => { posted.push(body) },
    downloadSettleMs: 20,
    ...overrides,
  }
  return { deps, calls, posted, ...state }
}

const run = (tool: string, args: Record<string, unknown>, f = fake()) => clientTools[tool].run(args, f.deps)

// ─── Extensions ───────────────────────────────────────────────────────────────

test('install_extension installs from GitHub and names the extension', async () => {
  const f = fake()
  const result = await run('install_extension', { github_url: 'https://github.com/x/sf3d' }, f)

  assert.deepEqual(f.calls, [['install', 'https://github.com/x/sf3d']])
  assert.match(result, /Installed the extension “SF3D” \(id sf3d\)/)
  assert.match(result, /not downloaded yet/)
})

test('install_extension refuses a missing or non-GitHub URL without installing', async () => {
  const f = fake()
  assert.match(await run('install_extension', {}, f), /^Error: github_url is required/)
  assert.match(await run('install_extension', { github_url: 'https://evil.example/x' }, f), /^Error: .*github\.com/)
  assert.match(await run('install_extension', { github_url: 'not a url' }, f), /^Error: .*not a valid URL/)
  assert.deepEqual(f.calls, [])
})

test('install_extension reports the installer error', async () => {
  const f = fake()
  f.deps.extensions.installFromGitHub = async () => ({ success: false, error: 'No manifest.json' })
  assert.equal(await run('install_extension', { github_url: 'https://github.com/x/y' }, f), 'Error: No manifest.json')
})

test('uninstall_extension uninstalls by id, describes by name and refuses built-ins and unknown ids', async () => {
  const f = fake()
  assert.equal(describeClientTool('uninstall_extension', { extension_id: 'triposr' }, f.deps), 'Uninstall the extension “TripoSR”')
  assert.match(await run('uninstall_extension', { extension_id: 'triposr' }, f), /^Uninstalled the extension “TripoSR”/)
  assert.deepEqual(f.calls, [['uninstall', 'triposr']])

  assert.match(await run('uninstall_extension', { extension_id: 'mesh-ops' }, f), /^Error: “Mesh Ops” is built into Modly/)
  assert.match(await run('uninstall_extension', { extension_id: 'nope' }, f), /^Error: No installed extension has the id “nope”. Installed extensions: triposr, hunyuan, shared, mesh-ops\./)
  assert.match(await run('uninstall_extension', {}, f), /^Error: extension_id is required/)
  assert.equal(f.calls.length, 1)
})

test('reload_extensions reloads and reports the count and load errors', async () => {
  const f = fake()
  const result = await run('reload_extensions', {}, f)
  assert.deepEqual(f.calls, [['reload']])
  assert.equal(result, 'Reloaded the extensions: 4 installed. 1 failed to load: broken (bad manifest).')
})

// ─── Weights ──────────────────────────────────────────────────────────────────

test('download_model_weights downloads every model of the extension in turn', async () => {
  const f = fake()
  const result = await run('download_model_weights', { extension_id: 'hunyuan' }, f)
  assert.deepEqual(f.calls, [['download', 'hunyuan/shape', undefined], ['download', 'hunyuan/paint', undefined], ['refresh']])
  assert.equal(result, 'Downloaded the model weights of “Hunyuan3D”.')
})

test('download_model_weights with a variant only targets the models offering it', async () => {
  const f = fake()
  const result = await run('download_model_weights', { extension_id: 'hunyuan', variant: 'mini' }, f)
  assert.deepEqual(f.calls, [['download', 'hunyuan/shape', 'mini'], ['refresh']])
  assert.equal(result, 'Downloaded the model weights of “Hunyuan3D” (variant “mini”).')
})

test('download_model_weights validates the extension, model and variant', async () => {
  const f = fake()
  assert.match(await run('download_model_weights', { extension_id: 'hunyuan', variant: 'huge' }, f), /^Error: “Hunyuan3D” has no weight variant “huge”. Available variants: full, mini\./)
  assert.match(await run('download_model_weights', { extension_id: 'triposr', variant: 'x' }, f), /^Error: “TripoSR” does not offer weight variants/)
  assert.match(await run('download_model_weights', { extension_id: 'hunyuan/nope' }, f), /^Error: “Hunyuan3D” has no model “nope”/)
  assert.match(await run('download_model_weights', { extension_id: 'mesh-ops' }, f), /^Error: “Mesh Ops” is a process extension/)
  assert.match(await run('download_model_weights', { extension_id: 'ghost' }, f), /^Error: No installed extension/)
  assert.match(await run('download_model_weights', { extension_id: 'triposr', variant: 3 }, f), /^Error: variant must be a string/)
  assert.deepEqual(f.calls, [])
})

test('download_model_weights reports a long download as started, and an early failure as an error', async () => {
  const slow = fake()
  slow.deps.weights.download = () => new Promise(() => {})
  assert.match(await run('download_model_weights', { extension_id: 'triposr' }, slow), /^Started downloading the model weights of “TripoSR” \(1 model\)\. The download continues in the background/)

  const broken = fake()
  broken.deps.weights.download = async () => ({ success: false, error: 'HF 401' })
  assert.equal(await run('download_model_weights', { extension_id: 'triposr/main' }, broken), 'Error: Downloading “TripoSR / MAIN” failed: triposr/main: HF 401.')
})

test('delete_model_weights deletes per model, per variant, or the shared extension weights', async () => {
  const f = fake()
  assert.equal(await run('delete_model_weights', { extension_id: 'hunyuan' }, f), 'Deleted the downloaded model weights of “Hunyuan3D”.')
  assert.equal(await run('delete_model_weights', { extension_id: 'hunyuan', variant: 'full' }, f), 'Deleted the downloaded model weights of “Hunyuan3D” (variant “full”).')
  await run('delete_model_weights', { extension_id: 'shared' }, f)
  assert.deepEqual(f.calls, [
    ['delete', 'hunyuan/shape'], ['delete', 'hunyuan/paint'], ['refresh'],
    ['deleteVariant', 'hunyuan/shape', 'full'], ['refresh'],
    ['deleteExtensionWeights', 'shared'], ['refresh'],
  ])
  assert.equal(describeClientTool('delete_model_weights', { extension_id: 'hunyuan/shape', variant: 'full' }, f.deps), 'Delete the downloaded model weights of “Hunyuan3D / SHAPE” (variant “full”)')
})

test('delete_model_weights reports a failed delete', async () => {
  const f = fake()
  f.deps.weights.delete = async () => ({ success: false, error: 'file locked' })
  assert.equal(await run('delete_model_weights', { extension_id: 'triposr' }, f), 'Error: Deleting the weights of “TripoSR” failed: file locked.')
})

// ─── Workflows ────────────────────────────────────────────────────────────────

test('delete_workflow deletes by id and resolves its name', async () => {
  const f = fake()
  assert.equal(describeClientTool('delete_workflow', { workflow_id: 'wf2' }, f.deps), 'Delete the workflow “Cleanup”')
  assert.equal(await run('delete_workflow', { workflow_id: 'wf2' }, f), 'Deleted the workflow “Cleanup”.')
  assert.deepEqual(f.calls, [['removeWorkflow', 'wf2']])
  assert.match(await run('delete_workflow', { workflow_id: 'wf9' }, f), /^Error: No workflow has the id “wf9”. Workflows: Turntable \(wf1\), Cleanup \(wf2\)\./)
})

test('open_workflow opens the tab without navigating', async () => {
  const f = fake()
  const result = await run('open_workflow', { workflow_id: 'wf1' }, f)
  assert.deepEqual(f.calls, [['openWorkflow', 'wf1']])
  assert.match(result, /“Turntable”.*did not change/)
  assert.match(await run('open_workflow', {}, f), /^Error: workflow_id is required/)
})

// ─── Settings ─────────────────────────────────────────────────────────────────

test('set_setting sets each UI option and validates key and value', async () => {
  const f = fake()
  assert.equal(await run('set_setting', { key: 'uiScale', value: 'large' }, f), 'Set the interface scale to "large".')
  assert.equal(await run('set_setting', { key: 'useAtkinsonFont', value: true }, f), 'Set the Atkinson Hyperlegible font to true.')
  assert.equal(await run('set_setting', { key: 'showRamIndicator', value: 'false' }, f), 'Set the RAM indicator to false.')
  assert.deepEqual(f.ui, { uiScale: 'large', useAtkinsonFont: true, showRamIndicator: false })

  assert.match(await run('set_setting', { key: 'uiScale', value: 'huge' }, f), /^Error: uiScale must be one of: small, medium, large, very-large/)
  assert.match(await run('set_setting', { key: 'showRamIndicator', value: 1 }, f), /^Error: showRamIndicator must be true or false/)
  assert.match(await run('set_setting', { key: 'hfToken', value: 'x' }, f), /^Error: key must be one of/)
})

test('set_storage_folder moves existing files, then saves the folder', async () => {
  const f = fake()
  f.dirItems.models = ['triposr', 'hunyuan']
  const result = await run('set_storage_folder', { kind: 'models', path: 'D:\\AI\\models' }, f)
  assert.deepEqual(f.calls, [['move', 'C:\\Modly\\models', 'D:\\AI\\models'], ['applyStorage', 'models', 'D:\\AI\\models']])
  assert.equal(result, 'Moved 2 items from “C:\\Modly\\models” and set the models folder to “D:\\AI\\models”.')
})

test('set_storage_folder moves a workflows folder that holds only files', async () => {
  const f = fake()
  f.dirItems.workflows = ['turntable.json']
  const result = await run('set_storage_folder', { kind: 'workflows', path: 'D:/flows' }, f)
  assert.deepEqual(f.calls, [['move', 'C:\\Modly\\workflows', 'D:/flows'], ['applyStorage', 'workflows', 'D:/flows']])
  assert.match(result, /^Moved 1 item from/)
})

test('set_storage_folder refuses a location Settings would refuse', async () => {
  const f = fake()
  assert.equal(await run('set_storage_folder', { kind: 'models', path: 'C:\\Windows\\m' }, f), 'Error: This is a system folder. Nothing changed.')
  assert.deepEqual(f.calls, [])
})

test('set_storage_folder says which items stayed behind', async () => {
  const f = fake()
  f.dirItems.models = ['a', 'b']
  f.deps.storage.moveDirectory = async (args) => { f.calls.push(['move', args.src, args.dest]); return { success: true, kept: ['b'] } }
  assert.match(await run('set_storage_folder', { kind: 'models', path: 'D:/m' }, f), /^Moved 1 item from .*; 1 item could not be moved and stayed in “C:\\Modly\\models”\.$/)
})

test('set_storage_folder with an empty folder only saves it', async () => {
  const f = fake()
  assert.equal(await run('set_storage_folder', { kind: 'workflows', path: 'D:/flows' }, f), 'Set the workflows folder to “D:/flows”.')
  assert.deepEqual(f.calls, [['applyStorage', 'workflows', 'D:/flows']])
})

test('set_storage_folder refuses invalid locations and keeps everything on a failed move', async () => {
  const f = fake()
  assert.match(await run('set_storage_folder', { kind: 'cache', path: 'D:/x' }, f), /^Error: kind must be one of/)
  assert.match(await run('set_storage_folder', { kind: 'models', path: 'models' }, f), /^Error: “models” is not an absolute path/)
  assert.match(await run('set_storage_folder', { kind: 'models', path: 'c:/modly/models/sub' }, f), /^Error: .*overlaps the current models folder/)
  assert.match(await run('set_storage_folder', { kind: 'models', path: 'C:\\Modly' }, f), /^Error: .*overlaps the current models folder/)
  assert.match(await run('set_storage_folder', { kind: 'models', path: 'C:\\Modly\\workspace\\m' }, f), /^Error: .*overlaps another Modly folder/)
  assert.match(await run('set_storage_folder', { kind: 'models', path: 'C:/Modly/models/' }, f), /already/)
  assert.deepEqual(f.calls, [])

  f.dirItems.workspace = ['a.glb']
  f.deps.storage.moveDirectory = async () => ({ success: false, error: 'EACCES' })
  assert.equal(await run('set_storage_folder', { kind: 'workspace', path: 'E:/ws' }, f), 'Error: Could not move the workspace files to “E:/ws”: EACCES. Nothing changed.')
  assert.deepEqual(f.calls, [])
})

// ─── Mesh, navigation ─────────────────────────────────────────────────────────

test('undo_mesh and redo_mesh step through the history, and say when there is nothing to do', async () => {
  const f = fake()
  assert.match(await run('undo_mesh', {}, f), /^Undid/)
  assert.match(await run('redo_mesh', {}, f), /^Redid/)
  assert.deepEqual(f.calls, [['undo'], ['redo']])

  f.history.undo = 0
  f.history.redo = 0
  assert.equal(await run('undo_mesh', {}, f), 'There is no mesh change to undo.')
  assert.equal(await run('redo_mesh', {}, f), 'There is no mesh change to redo.')
  assert.equal(f.calls.length, 2)
})

test('navigate changes page and validates it', async () => {
  const f = fake()
  assert.equal(await run('navigate', { page: 'models' }, f), 'Opened the models page.')
  assert.deepEqual(f.calls, [['navigate', 'models']])
  assert.match(await run('navigate', { page: 'home' }, f), /^Error: page must be one of: generate, workflows, models, settings/)
})

test('a throwing dependency comes back as an error text', async () => {
  const f = fake()
  f.deps.extensions.reload = async () => { throw new Error('IPC gone') }
  assert.equal(await run('reload_extensions', {}, f), 'Error: IPC gone')
})

// ─── runClientTool ────────────────────────────────────────────────────────────

const event = (tool: string, args: Record<string, unknown>, confirm = false) => ({
  type: 'client_tool' as const, id: 'evt-1', call_id: 'call-7', tool, arguments: args, confirm,
})

test('runClientTool runs the tool and posts the result with its call_id', async () => {
  const f = fake()
  const outcome = await runClientTool(event('navigate', { page: 'settings' }), f.deps, async () => { throw new Error('not asked') })
  assert.deepEqual(f.posted, [{ call_id: 'call-7', result: 'Opened the settings page.' }])
  assert.deepEqual(outcome, { description: 'Go to the settings page', result: 'Opened the settings page.', error: false, declined: false, posted: true })
})

test('runClientTool asks first when confirm is set, and runs on Confirm', async () => {
  const f = fake()
  const asked: unknown[] = []
  await runClientTool(event('uninstall_extension', { extension_id: 'triposr' }, true), f.deps, async (description, info) => {
    asked.push(description, info)
    return true
  })
  assert.deepEqual(asked, ['Uninstall the extension “TripoSR”', { tool: 'uninstall_extension', id: 'evt-1', callId: 'call-7', destructive: true }])
  assert.deepEqual(f.calls, [['uninstall', 'triposr']])
  assert.equal(f.posted[0].call_id, 'call-7')
})

test('runClientTool reports a declined confirmation without running the tool', async () => {
  const f = fake()
  const outcome = await runClientTool(event('delete_workflow', { workflow_id: 'wf1' }, true), f.deps, async () => false)
  assert.deepEqual(f.calls, [])
  assert.deepEqual(f.posted, [{ call_id: 'call-7', result: 'The user declined: Delete the workflow “Turntable”.' }])
  assert.equal(outcome.declined, true)
})

test('runClientTool asks for code installs and destructive tools even when the event says no confirm', async () => {
  for (const [tool, args] of [
    ['install_extension', { github_url: 'https://github.com/a/b' }],
    ['delete_workflow', { workflow_id: 'wf1' }],
  ] as const) {
    const f = fake()
    let asked = false
    const outcome = await runClientTool(event(tool, { ...args }, false), f.deps, async () => { asked = true; return false })
    assert.equal(asked, true, tool)
    assert.equal(outcome.declined, true, tool)
    assert.deepEqual(f.calls, [], tool)
  }
})

test('runClientTool does not ask about a call that cannot run, and flags errors', async () => {
  const f = fake()
  let asked = false
  const outcome = await runClientTool(event('delete_workflow', { workflow_id: 'nope' }, true), f.deps, async () => { asked = true; return true })
  assert.equal(asked, false)
  assert.equal(outcome.error, true)
  assert.equal(f.posted[0].error, true)
  assert.match(f.posted[0].result, /^Error: No workflow has the id “nope”/)
})

test('runClientTool answers an unknown tool with an error', async () => {
  const f = fake()
  const outcome = await runClientTool(event('format_disk', {}), f.deps, async () => true)
  assert.match(outcome.result, /^Error: Unknown client tool “format_disk”. Client tools: install_extension,/)
  assert.deepEqual(f.posted, [{ call_id: 'call-7', result: outcome.result, error: true }])
})

test('runClientTool survives a failed post', async () => {
  const f = fake({ postResult: async () => { throw new Error('offline') } })
  const outcome = await runClientTool(event('reload_extensions', {}), f.deps, async () => true)
  assert.equal(outcome.posted, false)
  assert.equal(isErrorResult(outcome.result), false)
})

// ─── generate_from_image ──────────────────────────────────────────────────────

const OPTIONS: GenerationOptions = { modelId: 'triposr/main', remesh: 'quad', enableTexture: false, textureResolution: 512, modelParams: { steps: 30 } }

function generation(statuses: { status: string; progress?: number; outputUrl?: string; error?: string }[]) {
  const calls: unknown[][] = []
  let job: GenerationJob | null = null
  const deps: GenerationDeps = {
    api: {
      generateFromImage: async (path, options, data) => { calls.push(['submit', path, options, data]); return { jobId: 'j1' } },
      pollJobStatus: async () => ({ progress: 0, ...statuses.shift()! }) as never,
      cancelJob: async () => { calls.push(['cancel']) },
    },
    store: {
      setCurrentJob: (j) => { job = j },
      updateCurrentJob: (patch) => { if (job) job = { ...job, ...patch } },
      pushMeshUrl: (url) => { calls.push(['push', url]) },
      clearMeshHistory: () => { calls.push(['clear']) },
    },
    options: () => OPTIONS,
    notifyComplete: () => {},
    notifyError: () => {},
    wait: async () => {},
  }
  return { deps, calls, job: () => job }
}

test('startGenerationFromImage generates from the attached image into the current job', async () => {
  const g = generation([{ status: 'running', progress: 50 }, { status: 'done', outputUrl: '/workspace/out.glb' }])
  const result = await startGenerationFromImage({ type: 'generate_from_image', model_id: 'sf3d/main' }, 'data:image/jpeg;base64,QUJD', g.deps)

  assert.equal(result, 'Generated a mesh with sf3d/main: /workspace/out.glb.')
  const submit = g.calls.find((c) => c[0] === 'submit')!
  assert.equal(submit[3], 'QUJD')
  assert.deepEqual(submit[2], { ...OPTIONS, modelId: 'sf3d/main', modelParams: {} })
  assert.deepEqual(g.calls.at(-1), ['push', '/workspace/out.glb'])
  assert.equal(g.job()?.status, 'done')
  assert.equal(g.job()?.outputUrl, '/workspace/out.glb')
})

test('startGenerationFromImage keeps the selected model and its params when none is given', async () => {
  const g = generation([{ status: 'done', outputUrl: '/workspace/o.glb' }])
  await startGenerationFromImage({ type: 'generate_from_image' }, 'QUJD', g.deps)
  assert.deepEqual(g.calls.find((c) => c[0] === 'submit')![2], OPTIONS)
})

test('startGenerationFromImage reports a missing image, a wrong payload and a failed job', async () => {
  const g = generation([{ status: 'error', error: 'CUDA OOM' }])
  assert.match(await startGenerationFromImage({ type: 'generate_from_image' }, undefined, g.deps), /^Error: No image/)
  assert.match(await startGenerationFromImage({ type: 'mesh_update' }, 'QUJD', g.deps), /^Error: Not a generate_from_image payload/)
  assert.equal(await startGenerationFromImage({ type: 'generate_from_image' }, 'QUJD', g.deps), 'Error: The generation failed: CUDA OOM')
  assert.equal(g.job()?.status, 'error')
})

test('latestUserImage takes the most recent user message with an image', () => {
  assert.equal(latestUserImage([
    { role: 'user', imageDataUrls: ['data:old'] },
    { role: 'assistant', imageDataUrls: ['data:assistant'] },
    { role: 'user', imageDataUrls: ['data:new', 'data:second'] },
    { role: 'user' },
  ]), 'data:new')
  assert.equal(latestUserImage([{ role: 'user' }]), undefined)
})

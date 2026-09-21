import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'modly-scene-run-'))
const stub = (name, source) => { const path = join(dir, name); writeFileSync(path, source); return path }
const appStoreStub = stub('app.ts', `
export const appState: any = { apiUrl: 'http://modly.test', currentJob: null,
 setCurrentJob(value: any) { this.currentJob = value },
 updateCurrentJob(value: any) { this.currentJob = { ...(this.currentJob ?? {}), ...value } } }
export const useAppStore: any = (selector: any) => selector(appState)
useAppStore.getState = () => appState
`)
const axiosStub = stub('axios.ts', `const axios: any = { create: () => (globalThis as any).__sceneClient }; export default axios; export type AxiosInstance = any`)
const extStub = stub('ext.ts', `export const getWorkflowExtension = (id: string, all: any[]) => all.find((value) => value.id === id); export type WorkflowExtension = any`)
const notifyStub = stub('notify.ts', `export const showCompletionNotification = async () => {}`)
const aliases = new Map([
  ['axios', axiosStub], ['@shared/stores/appStore', appStoreStub],
  ['./mockExtensions', extStub], ['@shared/utils/notification', notifyStub],
])
const outfile = join(dir, 'store.cjs')
writeFileSync(outfile, (await build({
  entryPoints: [resolve('src/areas/workflows/workflowRunStore.ts')], bundle: true,
  platform: 'node', format: 'cjs', write: false,
  plugins: [{ name: 'aliases', setup(build) { build.onResolve({ filter: /.*/ }, (args) => aliases.has(args.path) ? { path: aliases.get(args.path) } : null) } }],
})).outputFiles[0].text)
const { useWorkflowRunStore } = createRequire(import.meta.url)(outfile)

test('scene model uses typed artifact route and preserves scene output', async () => {
  const posts = []
  globalThis.window = { electron: {
    settings: { get: async () => ({ workspaceDir: '/workspace' }) },
    fs: { deleteDirectory: async () => ({ success: true }), listFiles: async () => [], readFileBase64: async () => { throw new Error('scene must not be read as image bytes') } },
  } }
  globalThis.__sceneClient = {
    post: async (url, body) => { posts.push({ url, body }); return { data: { job_id: 'scene-job' } } },
    get: async () => ({ data: { status: 'done', progress: 100, output_url: '/workspace/Workflows/result/scene-manifest.json' } }),
  }
  const workflow = {
    id: 'wf', name: 'Scene', description: '', createdAt: '', updatedAt: '',
    nodes: [
      { id: 'source', type: 'sceneNode', position: { x: 0, y: 0 }, data: { enabled: true, params: { manifestPath: 'Workflows/input/scene-manifest.json' } } },
      { id: 'model', type: 'extensionNode', position: { x: 1, y: 0 }, data: { enabled: true, extensionId: 'pixal/world', params: {} } },
    ],
    edges: [{ id: 'e', source: 'source', target: 'model' }],
  }
  const extension = { id: 'pixal/world', name: 'World', type: 'model', input: 'scene', output: 'scene', params: [] }
  await useWorkflowRunStore.getState().run(workflow, [extension])
  assert.equal(posts[0].url, '/generate/from-artifact')
  assert.deepEqual(posts[0].body, {
    input_kind: 'scene', input_path: 'Workflows/input/scene-manifest.json',
    model_id: 'pixal/world', collection: 'Workflows', params: {},
  })
  assert.equal(useWorkflowRunStore.getState().runState.outputPath, '/workspace/Workflows/result/scene-manifest.json')
  assert.equal(useWorkflowRunStore.getState().runState.outputUrl, undefined)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'modly-video-run-'))
const stub = (name, source) => { const path = join(dir, name); writeFileSync(path, source); return path }
const aliases = new Map([
  ['axios', stub('axios.ts', `const axios: any = { create: () => (globalThis as any).__client }; export default axios; export type AxiosInstance = any`)],
  ['@shared/stores/appStore', stub('app.ts', `export const state: any = { apiUrl: 'x', setCurrentJob() {}, updateCurrentJob() {} }; export const useAppStore: any = (s: any) => s(state); useAppStore.getState = () => state`)],
  ['./mockExtensions', stub('ext.ts', `export const getWorkflowExtension = (id: string, all: any[]) => all.find((x) => x.id === id); export type WorkflowExtension = any`)],
  ['@shared/utils/notification', stub('notify.ts', `export const showCompletionNotification = async () => {}; export const showErrorNotification = async () => {}`)],
])
const outfile = join(dir, 'store.cjs')
writeFileSync(outfile, (await build({ entryPoints: [resolve('src/areas/workflows/workflowRunStore.ts')], bundle: true, platform: 'node', format: 'cjs', write: false, plugins: [{ name: 'aliases', setup(build) { build.onResolve({ filter: /.*/ }, (args) => aliases.has(args.path) ? { path: aliases.get(args.path) } : null) } }] })).outputFiles[0].text)
const { useWorkflowRunStore } = createRequire(import.meta.url)(outfile)

test('video model receives a typed artifact path without fake image bytes', async () => {
  const posts = []
  globalThis.window = { electron: { settings: { get: async () => ({ workspaceDir: 'C:\\MODLY\\workspace' }) }, fs: { deleteDirectory: async () => ({ success: true }), listFiles: async () => [], readFileBase64: async () => { throw new Error('video must not be read as image bytes') } } } }
  globalThis.__client = { post: async (url, body) => { posts.push({ url, body }); return { data: { job_id: 'video-job' } } }, get: async () => ({ data: { status: 'done', progress: 100, output_url: '/workspace/Workflows/result.glb' } }) }
  const workflow = { id: 'wf', name: 'Video', description: '', createdAt: '', updatedAt: '', nodes: [
    { id: 'source', type: 'videoNode', position: { x: 0, y: 0 }, data: { enabled: true, params: { workspacePath: 'Workflows/Videos/clip.mp4' } } },
    { id: 'model', type: 'extensionNode', position: { x: 1, y: 0 }, data: { enabled: true, extensionId: 'demo/video', params: {} } },
  ], edges: [{ id: 'e', source: 'source', target: 'model' }] }
  await useWorkflowRunStore.getState().run(workflow, [{ id: 'demo/video', name: 'Video', type: 'model', input: 'video', output: 'mesh', params: [] }])
  assert.deepEqual(posts[0], { url: '/generate/from-artifact', body: { input_kind: 'video', input_path: 'Workflows/Videos/clip.mp4', model_id: 'demo/video', collection: 'Workflows', params: {} } })
})

test('process video input and video output keep the generic process contract', async () => {
  const calls = []
  globalThis.window = { electron: {
    settings: { get: async () => ({ workspaceDir: 'C:\\MODLY\\workspace' }) },
    fs: { deleteDirectory: async () => ({ success: true }), listFiles: async () => [] },
    extensions: { runProcess: async (...args) => {
      calls.push(args)
      return { success: true, result: { filePath: 'C:\\MODLY\\workspace\\Workflows\\result.mp4' } }
    } },
  } }
  globalThis.__client = { post: async () => { throw new Error('process video must not use the model API') } }
  const workflow = { id: 'wf-process', name: 'Process video', description: '', createdAt: '', updatedAt: '', nodes: [
    { id: 'source', type: 'videoNode', position: { x: 0, y: 0 }, data: { enabled: true, params: { workspacePath: 'Workflows/Videos/clip.mp4' } } },
    { id: 'process', type: 'extensionNode', position: { x: 1, y: 0 }, data: { enabled: true, extensionId: 'demo/process-video', params: {} } },
  ], edges: [{ id: 'e', source: 'source', target: 'process' }] }
  await useWorkflowRunStore.getState().run(workflow, [{ id: 'demo/process-video', name: 'Video process', type: 'process', input: 'video', output: 'video', params: [] }])
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], [
    'demo',
    { filePath: 'C:/MODLY/workspace/Workflows/Videos/clip.mp4', text: undefined, texts: undefined, nodeId: 'process-video' },
    {},
  ])
})

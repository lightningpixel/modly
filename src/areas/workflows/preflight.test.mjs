import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Bundle preflight.ts (and its real dependency mockExtensions.ts) into CJS.
// All @shared/* imports in those files are type-only, so esbuild erases them
// and no path-alias resolution is required.
function loadModule() {
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-preflight-test-')), 'preflight.cjs')
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve('src/areas/workflows/preflight.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return require(outfile)
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

function ext(overrides = {}) {
  return {
    id: 'pack/process-node',
    extensionId: 'pack',
    extensionName: 'Pack',
    extensionAuthor: 'tester',
    nodeId: 'process-node',
    name: 'Process Node',
    description: '',
    input: 'image',
    output: 'mesh',
    params: [],
    builtin: false,
    type: 'process',
    ...overrides,
  }
}

function wf(nodes, edges = []) {
  return { id: 'wf', name: 'wf', description: '', nodes, edges, createdAt: '', updatedAt: '' }
}

const imageNode = (id = 'img') => ({ id, type: 'imageNode', position: { x: 0, y: 0 }, data: {} })
const textNode = (id = 'txt') => ({ id, type: 'textNode', position: { x: 0, y: 0 }, data: {} })

// ─── Tests ───────────────────────────────────────────────────────────────────

test('valid graph (image → extension expecting image) produces no issues', () => {
  const { validateWorkflowPreflight } = loadModule()
  const extensions = [ext()]
  const workflow = wf(
    [imageNode('img'), { id: 'proc', type: 'extensionNode', position: { x: 0, y: 0 }, data: { extensionId: 'pack/process-node' } }],
    [{ id: 'e1', source: 'img', target: 'proc' }],
  )

  assert.deepEqual(validateWorkflowPreflight(workflow, extensions), [])
})

test('extension node with no matching incoming connection is flagged', () => {
  const { validateWorkflowPreflight } = loadModule()
  const extensions = [ext()]
  const workflow = wf(
    [{ id: 'proc', type: 'extensionNode', position: { x: 0, y: 0 }, data: { extensionId: 'pack/process-node' } }],
    [],
  )

  const issues = validateWorkflowPreflight(workflow, extensions)
  assert.equal(issues.length, 1)
  assert.equal(issues[0].key, 'proc:missing:image')
  assert.match(issues[0].message, /needs an incoming image connection/)
})

test('type mismatch on an incoming edge is flagged', () => {
  const { validateWorkflowPreflight } = loadModule()
  const extensions = [ext()] // expects image
  const workflow = wf(
    [textNode('txt'), { id: 'proc', type: 'extensionNode', position: { x: 0, y: 0 }, data: { extensionId: 'pack/process-node' } }],
    [{ id: 'e1', source: 'txt', target: 'proc' }],
  )

  const issues = validateWorkflowPreflight(workflow, extensions)
  // missing required image input AND a text→image type mismatch
  assert.ok(issues.some((i) => i.key === 'proc:missing:image'))
  assert.ok(issues.some((i) => i.key === 'proc:type:e1' && /outputs text/.test(i.message)))
})

test('unknown extension id is reported as unavailable', () => {
  const { validateWorkflowPreflight } = loadModule()
  const workflow = wf(
    [{ id: 'proc', type: 'extensionNode', position: { x: 0, y: 0 }, data: { extensionId: 'ghost/node' } }],
    [],
  )

  const issues = validateWorkflowPreflight(workflow, [])
  assert.equal(issues.length, 1)
  assert.equal(issues[0].key, 'proc:missing-extension')
  assert.match(issues[0].message, /unavailable/)
})

test('meshNode set to current scene flags when no mesh is loaded', () => {
  const { validateWorkflowPreflight } = loadModule()
  const workflow = wf([
    { id: 'mesh', type: 'meshNode', position: { x: 0, y: 0 }, data: { params: { source: 'current' } } },
  ])

  const without = validateWorkflowPreflight(workflow, [], { currentMeshUrl: null })
  assert.equal(without.length, 1)
  assert.equal(without[0].key, 'mesh:current-mesh')

  const withMesh = validateWorkflowPreflight(workflow, [], { currentMeshUrl: '/tmp/mesh.glb' })
  assert.deepEqual(withMesh, [])
})

test('multi-input extension requires every declared input type', () => {
  const { validateWorkflowPreflight } = loadModule()
  const extensions = [ext({ inputs: ['image', 'text'] })]
  const workflow = wf(
    [imageNode('img'), { id: 'proc', type: 'extensionNode', position: { x: 0, y: 0 }, data: { extensionId: 'pack/process-node' } }],
    [{ id: 'e1', source: 'img', target: 'proc' }],
  )

  const issues = validateWorkflowPreflight(workflow, extensions)
  // image satisfied, text still missing
  assert.ok(!issues.some((i) => i.key === 'proc:missing:image'))
  assert.ok(issues.some((i) => i.key === 'proc:missing:text'))
})

test('scene input requires a validated Load Scene source and rejects image wiring', () => {
  const { validateWorkflowPreflight } = loadModule()
  const model = { id: 'model', type: 'extensionNode', position: { x: 0, y: 0 }, data: { extensionId: 'pack/process-node' } }
  const scene = { id: 'scene', type: 'sceneNode', position: { x: 0, y: 0 }, data: { params: { manifestPath: 'Workflows/room/scene-manifest.json' } } }
  for (const output of ['scene', 'mesh']) {
    const extension = ext({ input: 'scene', output, type: 'model' })
    assert.deepEqual(validateWorkflowPreflight(wf([scene, model], [{ id: 'scene-edge', source: 'scene', target: 'model' }]), [extension]), [])
  }

  const extension = ext({ input: 'scene', output: 'scene', type: 'model' })
  const issues = validateWorkflowPreflight(wf([imageNode(), model], [{ id: 'image-edge', source: 'img', target: 'model' }]), [extension])
  assert.ok(issues.some((issue) => issue.key === 'model:missing:scene'))
  assert.ok(issues.some((issue) => issue.key === 'model:type:image-edge'))
})

test('Load Scene must be validated before a workflow can run', () => {
  const { validateWorkflowPreflight } = loadModule()
  const scene = { id: 'scene', type: 'sceneNode', position: { x: 0, y: 0 }, data: { params: { path: 'Workflows/room' } } }
  const issues = validateWorkflowPreflight(wf([scene], []), [])
  assert.equal(issues[0].key, 'scene:scene-invalid')
})

test('renderer fails closed for unsupported process and mixed scene node shapes', () => {
  const { validateWorkflowPreflight } = loadModule()
  const scene = { id: 'scene', type: 'sceneNode', position: { x: 0, y: 0 }, data: { params: { manifestPath: 'Workflows/room/scene-manifest.json' } } }
  const target = { id: 'target', type: 'extensionNode', position: { x: 0, y: 0 }, data: { extensionId: 'pack/process-node' } }
  for (const extension of [
    ext({ input: 'scene', output: 'mesh', type: 'process' }),
    ext({ input: 'scene', inputs: ['scene', 'text'], output: 'mesh', type: 'model' }),
  ]) {
    const issues = validateWorkflowPreflight(wf([scene, target], [{ id: 'e', source: 'scene', target: 'target' }]), [extension])
    assert.ok(issues.some((issue) => issue.key === 'target:unsupported-scene-shape'))
  }
})

test('video input accepts only a validated Load Video source and fails closed on unsupported shapes', () => {
  const { validateWorkflowPreflight } = loadModule()
  const video = { id: 'video', type: 'videoNode', position: { x: 0, y: 0 }, data: { params: { workspacePath: 'Workflows/Videos/clip.mp4' } } }
  const target = { id: 'target', type: 'extensionNode', position: { x: 0, y: 0 }, data: { extensionId: 'pack/process-node' } }
  const valid = ext({ input: 'video', output: 'mesh', type: 'model' })
  assert.deepEqual(validateWorkflowPreflight(wf([video, target], [{ id: 'e', source: 'video', target: 'target' }]), [valid]), [])
  for (const extension of [
    ext({ input: 'video', output: 'mesh', type: 'process' }),
    ext({ input: 'video', inputs: ['video'], output: 'mesh', type: 'model' }),
    ext({ input: 'image', output: 'video', type: 'model' }),
  ]) {
    const issues = validateWorkflowPreflight(wf([video, target], [{ id: 'e', source: 'video', target: 'target' }]), [extension])
    assert.ok(issues.some((issue) => issue.key === 'target:unsupported-video-shape'))
  }
  for (const params of [{ path: '/tmp/clip.mp4' }, { workspacePath: '../clip.mp4' }, { workspacePath: 'Workflows/clip.exe' }]) {
    const invalid = { ...video, data: { params } }
    assert.ok(validateWorkflowPreflight(wf([invalid], []), []).some((issue) => issue.key === 'video:video-invalid'))
  }
})

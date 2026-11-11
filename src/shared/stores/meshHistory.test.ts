import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MESH_HISTORY_LIMIT,
  createMeshHistory,
  currentMeshUrl,
  recordMesh,
  recordMeshEdit,
  redoDepth,
  stepBack,
  stepForward,
  undoDepth,
} from './meshHistory.ts'

test('3 edits then 3 undos return the mesh to its initial state', () => {
  let h = createMeshHistory('/workspace/a.glb')
  h = recordMeshEdit(h, '/workspace/a.glb', '/workspace/b.glb')
  h = recordMeshEdit(h, '/workspace/b.glb', '/workspace/c.glb')
  h = recordMeshEdit(h, '/workspace/c.glb', '/workspace/d.glb')
  assert.equal(undoDepth(h), 3)

  h = stepBack(h)
  assert.equal(currentMeshUrl(h), '/workspace/c.glb')
  h = stepBack(h)
  assert.equal(currentMeshUrl(h), '/workspace/b.glb')
  h = stepBack(h)
  assert.equal(currentMeshUrl(h), '/workspace/a.glb')
  assert.equal(undoDepth(h), 0)
  assert.equal(redoDepth(h), 3)
})

test('an edit on a mesh that was never recorded seeds it as the undo baseline', () => {
  // e.g. a workflow output or an Add-to-Scene mesh that bypassed recordMesh
  let h = createMeshHistory()
  h = recordMeshEdit(h, '/workspace/wf.glb', '/workspace/wf_smooth.glb')
  assert.equal(undoDepth(h), 1)
  assert.equal(currentMeshUrl(stepBack(h)), '/workspace/wf.glb')
})

test('an empty history cannot step in either direction', () => {
  const h = createMeshHistory()
  assert.equal(undoDepth(h), 0)
  assert.equal(redoDepth(h), 0)
  assert.equal(stepBack(h), h)
  assert.equal(stepForward(h), h)
  assert.equal(currentMeshUrl(h), undefined)
})

test('redo replays undone edits, and a new edit drops the redo branch', () => {
  let h = createMeshHistory('a')
  h = recordMeshEdit(h, 'a', 'b')
  h = recordMeshEdit(h, 'b', 'c')
  h = stepBack(stepBack(h))
  h = stepForward(h)
  assert.equal(currentMeshUrl(h), 'b')

  h = recordMeshEdit(h, 'b', 'x')
  assert.equal(redoDepth(h), 0)
  assert.equal(stepForward(h), h)
  assert.deepEqual(h.entries, ['a', 'b', 'x'])
})

test('recording the mesh that is already current is a no-op', () => {
  const h = createMeshHistory('a')
  assert.equal(recordMesh(h, 'a'), h)
  const seeded = recordMesh(createMeshHistory(), 'a')
  assert.deepEqual(seeded.entries, ['a'])
  assert.equal(undoDepth(seeded), 0)
})

test('the stack keeps at most MESH_HISTORY_LIMIT undo steps, dropping the oldest', () => {
  let h = createMeshHistory('m0')
  for (let i = 1; i <= MESH_HISTORY_LIMIT + 5; i++) h = recordMeshEdit(h, `m${i - 1}`, `m${i}`)
  assert.equal(undoDepth(h), MESH_HISTORY_LIMIT)
  assert.equal(currentMeshUrl(h), `m${MESH_HISTORY_LIMIT + 5}`)
  while (undoDepth(h) > 0) h = stepBack(h)
  assert.equal(currentMeshUrl(h), 'm5')
})

test('the limit is applicable per call', () => {
  let h = createMeshHistory('a')
  h = recordMeshEdit(h, 'a', 'b', 1)
  h = recordMeshEdit(h, 'b', 'c', 1)
  assert.deepEqual(h.entries, ['b', 'c'])
  assert.equal(undoDepth(h), 1)
})

// ── Store wiring ─────────────────────────────────────────────────────────────

const { useAppStore } = await import('./appStore.ts')

function loadModel(id: string, url: string): void {
  useAppStore.getState().setCurrentJob({
    id, imageFile: '', status: 'done', progress: 100, outputUrl: url, createdAt: 0,
  })
}

const viewerUrl = () => useAppStore.getState().currentJob?.outputUrl

test('store: 3 edits then 3 undos restore the initial mesh, redo replays them', () => {
  loadModel('job-1', '/workspace/a.glb')
  const s = useAppStore.getState()
  s.applyMeshEdit('/workspace/b.glb')
  s.applyMeshEdit('/workspace/c.glb')
  s.applyMeshEdit('/workspace/d.glb')
  assert.equal(viewerUrl(), '/workspace/d.glb')

  s.undoMesh(); s.undoMesh(); s.undoMesh()
  assert.equal(viewerUrl(), '/workspace/a.glb')
  s.undoMesh()
  assert.equal(viewerUrl(), '/workspace/a.glb')

  s.redoMesh(); s.redoMesh(); s.redoMesh()
  assert.equal(viewerUrl(), '/workspace/d.glb')
})

test('store: loading another model clears the stack so undo never crosses models', () => {
  loadModel('job-1', '/workspace/a.glb')
  useAppStore.getState().applyMeshEdit('/workspace/b.glb')

  loadModel('job-2', '/workspace/other.glb')
  assert.equal(undoDepth(useAppStore.getState().meshHistory), 0)
  useAppStore.getState().undoMesh()
  assert.equal(viewerUrl(), '/workspace/other.glb')
})

test('store: reloading under the same job id still starts a fresh stack', () => {
  // Add-to-Scene reuses the id "workflow-output" for every mesh it opens.
  loadModel('workflow-output', '/workspace/one.glb')
  useAppStore.getState().applyMeshEdit('/workspace/one_edit.glb')
  loadModel('workflow-output', '/workspace/two.glb')
  useAppStore.getState().undoMesh()
  assert.equal(viewerUrl(), '/workspace/two.glb')
})

test('store: a mesh set without recording is still the baseline of the next edit', () => {
  useAppStore.getState().setCurrentJob({
    id: 'wf', imageFile: '', status: 'generating', progress: 0, createdAt: 0,
  })
  // A workflow run finishing sets the output without pushing it.
  useAppStore.getState().updateCurrentJob({ status: 'done', outputUrl: '/workspace/wf.glb' })
  useAppStore.getState().applyMeshEdit('/workspace/wf_smooth.glb')
  useAppStore.getState().undoMesh()
  assert.equal(viewerUrl(), '/workspace/wf.glb')
})

test('store: clearing the scene empties the stack', () => {
  loadModel('job-1', '/workspace/a.glb')
  useAppStore.getState().applyMeshEdit('/workspace/b.glb')
  useAppStore.getState().setCurrentJob(null)
  assert.equal(undoDepth(useAppStore.getState().meshHistory), 0)
  assert.equal(redoDepth(useAppStore.getState().meshHistory), 0)
})

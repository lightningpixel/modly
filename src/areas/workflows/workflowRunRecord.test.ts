import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_RECORD_STEPS,
  endRecordStep,
  finishWorkflowRunRecord,
  newWorkflowRunRecord,
  reopenWorkflowRunRecord,
  runOutputPath,
  startRecordStep,
  workflowRunParams,
} from './workflowRunRecord'

const workflow = {
  id: 'wf-1',
  name: 'Image to mesh',
  nodes: [
    { id: 'img', type: 'imageNode', data: { enabled: true, params: { filePath: 'C:/a.png' } } },
    { id: 'gen', type: 'extensionNode', data: { extensionId: 'triposg/generate', enabled: true, params: { seed: 7 } } },
    { id: 'off', type: 'extensionNode', data: { extensionId: 'mesh/decimate', enabled: false, params: {} } },
  ],
}

test('a new record is running with the workflow, its inputs and enabled node params', () => {
  const record = newWorkflowRunRecord('run-1', workflow, { image: 'C:/a.png' }, 100)
  assert.equal(record.status, 'running')
  assert.equal(record.workflow_id, 'wf-1')
  assert.equal(record.workflow_name, 'Image to mesh')
  assert.deepEqual(record.inputs, { image: 'C:/a.png' })
  assert.deepEqual(record.params, { nodes: { gen: { extension_id: 'triposg/generate', params: { seed: 7 } } } })
  assert.equal(record.created_at, 100)
  assert.equal(record.started_at, 100)
  assert.deepEqual(record.steps, [])
})

test('workflowRunParams skips disabled and non-extension nodes', () => {
  assert.deepEqual(Object.keys(workflowRunParams(workflow).nodes as object), ['gen'])
})

test('steps are timed per node and a new step closes the open one as done', () => {
  let record = newWorkflowRunRecord('run-1', workflow, {}, 100)
  record = startRecordStep(record, 'TripoSG', 'gen', 101)
  record = startRecordStep(record, 'Decimate', 'dec', 110)
  assert.deepEqual(record.steps[0], { name: 'TripoSG', node_id: 'gen', status: 'done', started_at: 101, ended_at: 110 })
  assert.deepEqual(record.steps[1], { name: 'Decimate', node_id: 'dec', status: 'running', started_at: 110 })
  record = endRecordStep(record, 'error', 115)
  assert.equal(record.steps[1].status, 'error')
  assert.equal(record.steps[1].ended_at, 115)
  // Ending again is a no-op: the step is already closed.
  assert.equal(endRecordStep(record, 'done', 120), record)
})

test('steps are capped', () => {
  let record = newWorkflowRunRecord('run-1', workflow, {}, 0)
  for (let i = 0; i < MAX_RECORD_STEPS + 10; i++) record = startRecordStep(record, `n${i}`, `n${i}`, i)
  assert.equal(record.steps.length, MAX_RECORD_STEPS)
})

test('finishing closes the open step with the run status and records the outcome', () => {
  let record = startRecordStep(newWorkflowRunRecord('run-1', workflow, {}, 100), 'TripoSG', 'gen', 100)
  record = finishWorkflowRunRecord(record, 'error', 130, { error: 'Error: boom' })
  assert.equal(record.status, 'error')
  assert.equal(record.ended_at, 130)
  assert.equal(record.error, 'Error: boom')
  assert.equal(record.steps[0].status, 'error')

  const done = finishWorkflowRunRecord(newWorkflowRunRecord('run-2', workflow, {}, 100), 'done', 150, { outputPath: 'Workflows/a.glb' })
  assert.equal(done.output_path, 'Workflows/a.glb')
  assert.equal(done.error, null)
})

test('a cancelled run keeps its status and partial steps', () => {
  let record = startRecordStep(newWorkflowRunRecord('run-1', workflow, {}, 100), 'TripoSG', 'gen', 100)
  record = finishWorkflowRunRecord(record, 'cancelled', 105)
  assert.equal(record.status, 'cancelled')
  assert.equal(record.steps[0].status, 'cancelled')
})

test('reopening a finished run makes it running again and clears the end', () => {
  const finished = finishWorkflowRunRecord(newWorkflowRunRecord('run-1', workflow, {}, 100), 'error', 120, { error: 'x' })
  const reopened = reopenWorkflowRunRecord(finished)
  assert.equal(reopened.status, 'running')
  assert.equal(reopened.ended_at, null)
  assert.equal(reopened.error, null)
  const running = newWorkflowRunRecord('run-2', workflow, {}, 100)
  assert.equal(reopenWorkflowRunRecord(running), running)
})

test('runOutputPath prefers a workspace-relative path', () => {
  assert.equal(runOutputPath('/workspace/Workflows/a 100%.glb'), 'Workflows/a 100%.glb')
  assert.equal(runOutputPath(undefined, 'D:/out/a.wav'), 'D:/out/a.wav')
  assert.equal(runOutputPath('/optimize/serve-file?path=x', 'D:/x.glb'), 'D:/x.glb')
  assert.equal(runOutputPath(), undefined)
})

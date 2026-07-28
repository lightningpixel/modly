import assert from 'node:assert/strict'
import test from 'node:test'

import {
  areAllWorkflowNodeParamsBound,
  resolveBoundWorkflowParams,
} from './workflowParamBindings.ts'

const workflow = {
  id: 'asset',
  name: 'Asset',
  description: '',
  createdAt: '',
  updatedAt: '',
  nodes: [],
  edges: [],
  paramBindings: [{
    sourceNodeId: 'generate',
    sourceParam: 'faces',
    targetNodeId: 'optimize',
    targetParam: 'target_faces',
  }],
}

test('bound params read the source value at target execution time', () => {
  const live = new Map([
    ['generate', { faces: 60_000 }],
    ['optimize', { target_faces: 1_000_000 }],
  ])

  assert.deepEqual(
    resolveBoundWorkflowParams(workflow, 'optimize', live.get('optimize'), (nodeId) => live.get(nodeId)),
    { target_faces: 60_000 },
  )

  live.set('generate', { faces: 12_000 })
  assert.deepEqual(
    resolveBoundWorkflowParams(workflow, 'optimize', live.get('optimize'), (nodeId) => live.get(nodeId)),
    { target_faces: 12_000 },
  )
})

test('unbound params remain unchanged and only fully bound nodes disappear from Generate', () => {
  const params = { target_faces: 1_000_000, preserve_uvs: true }
  assert.equal(resolveBoundWorkflowParams(workflow, 'export', params, () => undefined), params)
  assert.equal(areAllWorkflowNodeParamsBound(workflow, 'optimize', ['target_faces']), true)
  assert.equal(areAllWorkflowNodeParamsBound(workflow, 'optimize', ['target_faces', 'preserve_uvs']), false)
  assert.equal(areAllWorkflowNodeParamsBound(workflow, 'generate', ['faces']), false)
})

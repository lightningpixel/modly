import assert from 'node:assert/strict'
import test from 'node:test'

import type { RunRecord } from '../../shared/types/runs'
import type { LiveWorkflowRun } from '../workflows/workflowRunRecord'
import {
  buildQueueSections,
  formatDuration,
  formatStepLabel,
  inputImagePath,
  modelNameResolver,
  runDisplayName,
  runElapsedSeconds,
  runOpenTarget,
} from './queueModel'

function record(id: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id,
    kind: 'workflow',
    status: 'done',
    workflow_name: `wf ${id}`,
    inputs: {},
    params: {},
    steps: [],
    created_at: 100,
    started_at: 100,
    ended_at: 160,
    ...overrides,
  }
}

function live(overrides: Partial<LiveWorkflowRun> = {}): LiveWorkflowRun {
  return {
    runId: 'live',
    workflowId: 'wf-1',
    workflowName: 'Image to mesh',
    status: 'running',
    paused: false,
    startedAt: 500,
    endedAt: null,
    inputs: { image: 'C:/in/cat.png' },
    steps: [{ name: 'Generate Mesh', node_id: 'gen', status: 'running', started_at: 501 }],
    current: { index: 2, total: 4, name: 'Generate Mesh', detail: 'Generating…', progress: 40 },
    outputPath: null,
    error: null,
    ...overrides,
  }
}

const ids = (rows: { id: string }[]) => rows.map((r) => r.id)

test('records split into running, queued and history', () => {
  const sections = buildQueueSections(null, [
    record('r1', { status: 'running', started_at: 300, ended_at: null }),
    record('q2', { status: 'pending', created_at: 250, started_at: null, ended_at: null }),
    record('q1', { status: 'pending', created_at: 200, started_at: null, ended_at: null }),
    record('d1', { status: 'done', started_at: 150 }),
    record('e1', { status: 'error', started_at: 180, error: 'boom' }),
    record('c1', { status: 'interrupted', started_at: 120 }),
  ])
  assert.deepEqual(ids(sections.running), ['r1'])
  // Next up first.
  assert.deepEqual(ids(sections.queued), ['q1', 'q2'])
  assert.deepEqual(ids(sections.history), ['e1', 'd1', 'c1'])
  assert.equal(sections.history[0].error, 'boom')
})

test('the live run replaces its own running record, with its live progress', () => {
  const sections = buildQueueSections(live(), [
    record('live', { status: 'running', started_at: 500, ended_at: null }),
    record('d1'),
  ])
  assert.deepEqual(ids(sections.running), ['live'])
  assert.equal(sections.running[0].live, true)
  assert.equal(sections.running[0].current?.progress, 40)
  assert.equal(sections.running[0].inputImage, 'C:/in/cat.png')
  assert.deepEqual(ids(sections.history), ['d1'])
})

test('a finished live run shows once in history: the record wins, the live copy stands in until it is listed', () => {
  const ended = live({ status: 'done', endedAt: 560, current: null, outputPath: 'Workflows/a.glb' })
  const listed = buildQueueSections(ended, [record('live', { started_at: 500, ended_at: 561 }), record('d1')])
  assert.deepEqual(ids(listed.history), ['live', 'd1'])
  assert.equal(listed.history[0].live, false)
  assert.equal(listed.running.length, 0)

  const notYetListed = buildQueueSections(ended, [record('d1')])
  assert.deepEqual(ids(notYetListed.history), ['live', 'd1'])
  assert.equal(notYetListed.history[0].live, true)
})

test('child runs never show at the top level', () => {
  const sections = buildQueueSections(null, [record('child', { kind: 'generation', parent_run_id: 'p' }), record('p')])
  assert.deepEqual(ids(sections.history), ['p'])
})

test('a running record without live progress still names its open step', () => {
  const { running } = buildQueueSections(null, [record('g', {
    kind: 'generation', status: 'running', ended_at: null, model_id: 'triposg',
    steps: [{ name: 'Load', status: 'done', started_at: 1, ended_at: 2 }, { name: 'Mesh', status: 'running', started_at: 2 }],
  })])
  assert.equal(running[0].current?.name, 'Mesh')
  assert.equal(formatStepLabel(running[0].current!), 'Step 2 · Mesh')
})

test('display names', () => {
  const resolve = modelNameResolver([{ id: 'hunyuan', name: 'Hunyuan3D', nodes: [{ id: 'mini', name: 'Hunyuan3D Mini' }] }])
  assert.equal(runDisplayName(record('w'), resolve), 'wf w')
  assert.equal(runDisplayName(record('w', { workflow_name: ' ' })), 'Untitled workflow')
  assert.equal(runDisplayName(record('g', { kind: 'generation', model_id: 'hunyuan/mini' }), resolve), 'Hunyuan3D Mini')
  assert.equal(runDisplayName(record('g', { kind: 'generation', model_id: 'hunyuan' }), resolve), 'Hunyuan3D')
  assert.equal(runDisplayName(record('g', { kind: 'generation', model_id: 'trip_osr' }), resolve), 'Trip osr')
  assert.equal(runDisplayName(record('m', { kind: 'mesh_op', op_id: 'decimate' })), 'Decimate')
})

test('input image paths are absolute files only', () => {
  assert.equal(inputImagePath({ image: 'C:\\in\\a.png' }), 'C:\\in\\a.png')
  assert.equal(inputImagePath({ image: '/home/u/a.png' }), '/home/u/a.png')
  assert.equal(inputImagePath({ image: 'a.png' }), null)
  assert.equal(inputImagePath({ image: '(attached image)' }), null)
  assert.equal(inputImagePath({}), null)
})

test('elapsed and duration formatting', () => {
  assert.equal(runElapsedSeconds({ startedAt: 100, endedAt: null }, 142.5), 42.5)
  assert.equal(runElapsedSeconds({ startedAt: 100, endedAt: 160 }, 999), 60)
  assert.equal(runElapsedSeconds({ startedAt: null, endedAt: null }, 999), null)
  assert.equal(formatDuration(42.9), '42s')
  assert.equal(formatDuration(185), '3m 05s')
  assert.equal(formatDuration(3720), '1h 02m')
  assert.equal(formatDuration(null), '—')
  assert.equal(formatStepLabel({ index: 2, total: 4, name: 'Generate Mesh' }), 'Step 2/4 · Generate Mesh')
})

test('open targets: finished workspace meshes only', () => {
  assert.deepEqual(runOpenTarget({ status: 'done', outputPath: 'Workflows/run/a.glb' }), {
    openable: true, workspacePath: 'Workflows/run/a.glb', url: '/workspace/Workflows/run/a.glb',
  })
  assert.equal(runOpenTarget({ status: 'running', outputPath: 'a.glb' }).openable, false)
  assert.equal(runOpenTarget({ status: 'done', outputPath: null }).openable, false)
  assert.equal(runOpenTarget({ status: 'done', outputPath: 'C:/out/a.glb' }).openable, false)
  assert.equal(runOpenTarget({ status: 'done', outputPath: '../a.glb' }).openable, false)
  assert.equal(runOpenTarget({ status: 'done', outputPath: 'Workflows/voice.wav' }).openable, false)
  assert.equal(runOpenTarget({ status: 'done', outputPath: 'Scenes/s/scene.json' }).openable, false)
  assert.equal(runOpenTarget({ status: 'done', outputPath: 'Workflows/a.obj' }).openable, false)
})

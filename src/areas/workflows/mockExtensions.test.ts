import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildAllWorkflowExtensions } from './mockExtensions'
import type { ModelExtension, ProcessExtension } from '@shared/stores/extensionsStore'

const node = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  input: 'mesh' as const,
  output: 'mesh' as const,
  paramsSchema: [],
  ...extra,
})

const processExt = (extra: Record<string, unknown>): ProcessExtension => ({
  type: 'process',
  id: 'ext',
  name: 'Ext',
  trusted: true,
  builtin: false,
  entry: 'processor.js',
  nodes: [],
  ...extra,
} as ProcessExtension)

// The description is what the agent reads to tell two nodes with the same
// signature apart, so which one wins per node is worth pinning down.
test('a node without its own description inherits the extension one', () => {
  const [built] = buildAllWorkflowExtensions([], [processExt({
    description: 'Extension level.',
    nodes: [node('a')],
  })])
  assert.equal(built.description, 'Extension level.')
})

test('a node description wins over the extension one', () => {
  const built = buildAllWorkflowExtensions([], [processExt({
    description: 'Extension level.',
    nodes: [node('a', { description: 'Node level.' }), node('b')],
  })])
  assert.deepEqual(built.map((e) => e.description), ['Node level.', 'Extension level.'])
})

test('missing descriptions stay an empty string, never undefined', () => {
  const [built] = buildAllWorkflowExtensions([], [processExt({ nodes: [node('a')] })])
  assert.equal(built.description, '')
})

test('model extensions follow the same rule', () => {
  const built = buildAllWorkflowExtensions([{
    type: 'model',
    id: 'gen',
    name: 'Gen',
    trusted: true,
    builtin: false,
    description: 'Extension level.',
    nodes: [node('one', { description: 'Node level.' }), node('two')],
  } as unknown as ModelExtension], [])
  assert.deepEqual(built.map((e) => e.description), ['Node level.', 'Extension level.'])
})

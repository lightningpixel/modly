import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// nodeBehaviors.ts only type-imports from electron.d, so esbuild erases it.
function loadModule() {
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-nodebehaviors-test-')), 'nodeBehaviors.cjs')
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve('src/areas/workflows/nodeBehaviors.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return require(outfile)
}

const {
  isPassthrough, isBranchStarter, isSceneOutput, isBranchConsumer,
  resolveDataSource, nearestUpstreamWaits, reachesSceneOutput, edgeSlot,
} = loadModule()

// ─── Fixtures ────────────────────────────────────────────────────────────────

const node = (id, type) => ({ id, type, position: { x: 0, y: 0 }, data: {} })
const edge = (source, target) => ({ id: `${source}->${target}`, source, target })
const mapOf = (...nodes) => new Map(nodes.map((n) => [n.id, n]))

// ─── Behavior predicates ───────────────────────────────────────────────────────

test('predicates read the behavior table and tolerate unknown/undefined types', () => {
  assert.equal(isPassthrough('waitNode'), true)
  assert.equal(isBranchStarter('waitNode'), true)
  assert.equal(isSceneOutput('outputNode'), true)
  assert.equal(isBranchConsumer('outputNode'), true)
  assert.equal(isBranchConsumer('extensionNode'), true)

  assert.equal(isPassthrough('extensionNode'), false)
  assert.equal(isSceneOutput('waitNode'), false)
  assert.equal(isPassthrough(undefined), false)
  assert.equal(isBranchStarter('ghostNode'), false)
})

// ─── resolveDataSource ─────────────────────────────────────────────────────────

test('resolveDataSource walks back through passthrough nodes to the real source', () => {
  const nodes = mapOf(node('img', 'imageNode'), node('wait', 'waitNode'), node('proc', 'extensionNode'))
  const edges = [edge('img', 'wait'), edge('wait', 'proc')]

  assert.equal(resolveDataSource('wait', edges, nodes), 'img') // hop over the Wait
  assert.equal(resolveDataSource('img', edges, nodes), 'img')  // non-passthrough returns itself
})

test('resolveDataSource returns undefined when a passthrough has no incoming edge', () => {
  const nodes = mapOf(node('wait', 'waitNode'))
  assert.equal(resolveDataSource('wait', [], nodes), undefined)
})

test('resolveDataSource terminates on a passthrough cycle (no infinite loop)', () => {
  const nodes = mapOf(node('w1', 'waitNode'), node('w2', 'waitNode'))
  const edges = [edge('w2', 'w1'), edge('w1', 'w2')]
  assert.equal(resolveDataSource('w1', edges, nodes), 'w1')
})

// ─── nearestUpstreamWaits ──────────────────────────────────────────────────────

test('nearestUpstreamWaits finds the first Wait on each incoming path', () => {
  const nodes = mapOf(node('img', 'imageNode'), node('wait', 'waitNode'), node('proc', 'extensionNode'), node('out', 'outputNode'))
  const edges = [edge('img', 'wait'), edge('wait', 'proc'), edge('proc', 'out')]
  assert.deepEqual([...nearestUpstreamWaits('out', edges, nodes)], ['wait'])
})

test('nearestUpstreamWaits reports >1 when a node merges two branches', () => {
  const nodes = mapOf(node('wa', 'waitNode'), node('wb', 'waitNode'), node('merge', 'outputNode'))
  const edges = [edge('wa', 'merge'), edge('wb', 'merge')]
  assert.equal(nearestUpstreamWaits('merge', edges, nodes).size, 2)
})

test('nearestUpstreamWaits is empty with no upstream Wait', () => {
  const nodes = mapOf(node('img', 'imageNode'), node('proc', 'extensionNode'))
  const edges = [edge('img', 'proc')]
  assert.equal(nearestUpstreamWaits('proc', edges, nodes).size, 0)
})

// ─── reachesSceneOutput ────────────────────────────────────────────────────────

test('reachesSceneOutput follows forward paths to a scene output', () => {
  const nodes = mapOf(node('proc', 'extensionNode'), node('out', 'outputNode'))
  const edges = [edge('proc', 'out')]
  assert.equal(reachesSceneOutput('proc', edges, nodes), true)
})

test('reachesSceneOutput stops at a Wait boundary (output gated behind a branch)', () => {
  const nodes = mapOf(node('proc', 'extensionNode'), node('wait', 'waitNode'), node('out', 'outputNode'))
  const edges = [edge('proc', 'wait'), edge('wait', 'out')]
  assert.equal(reachesSceneOutput('proc', edges, nodes), false)
})

test('reachesSceneOutput is false when no path reaches an output', () => {
  const nodes = mapOf(node('proc', 'extensionNode'), node('img', 'imageNode'))
  const edges = [edge('proc', 'img')]
  assert.equal(reachesSceneOutput('proc', edges, nodes), false)
})

// ─── Input slots ─────────────────────────────────────────────────────────────

test('edgeSlot reads the handle a multi-input edge lands on', () => {
  assert.equal(edgeSlot('input-0'), 0)
  assert.equal(edgeSlot('input-1'), 1)
  assert.equal(edgeSlot('input-12'), 12)
})

test('an edge with no handle lands on slot 0', () => {
  // Every workflow saved before multi-input existed, and every chain the agent
  // builds, wires without a targetHandle. The runner's own copy of this rule
  // left that case out: on a ['text','text'] node the positive prompt never
  // reached texts[0] and the negative one drove the generator.
  assert.equal(edgeSlot(undefined), 0)
  assert.equal(edgeSlot(null), 0)
  assert.equal(edgeSlot(''), 0)
})

test('a handle that is not an input slot lands nowhere', () => {
  assert.equal(edgeSlot('input-'), undefined)
  assert.equal(edgeSlot('input-x'), undefined)
})

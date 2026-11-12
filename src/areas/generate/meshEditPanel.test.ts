import assert from 'node:assert/strict'
import test from 'node:test'

import {
  apiErrorMessage,
  defaultParamValues,
  fromSliderPosition,
  groupMeshOps,
  inspectionBadges,
  isMeshUpdate,
  meshPathFromUrl,
  paramControl,
  requiresConfirmation,
  summarizeDetails,
  toSliderPosition,
  type MeshOpDescriptor,
} from './meshEditPanel.ts'

function op(id: string, category: string, extra: Partial<MeshOpDescriptor> = {}): MeshOpDescriptor {
  return { id, label: id, params_schema: [], destructive: false, undoable: true, category, ...extra }
}

// ─── Schema → control ────────────────────────────────────────────────────────

test('a bounded int becomes an integer slider with its default', () => {
  const control = paramControl({ id: 'iterations', label: 'Iterations', type: 'int', default: 5, min: 1, max: 50 })
  assert.equal(control.kind, 'slider')
  assert.ok(control.kind === 'slider')
  assert.equal(control.integer, true)
  assert.equal(control.step, 1)
  assert.equal(control.min, 1)
  assert.equal(control.max, 50)
  assert.equal(control.scale, 'linear')
  assert.equal(control.defaultValue, 5)
})

test('a bounded float keeps its declared step', () => {
  const control = paramControl({ id: 'lambda_', label: 'Strength', type: 'float', default: 0.5, min: 0.1, max: 1, step: 0.05 })
  assert.ok(control.kind === 'slider')
  assert.equal(control.integer, false)
  assert.equal(control.step, 0.05)
})

test('a range spanning three orders of magnitude uses a log slider', () => {
  const faces = paramControl({ id: 'target_faces', type: 'int', default: 10000, min: 100, max: 1000000 })
  assert.ok(faces.kind === 'slider')
  assert.equal(faces.scale, 'log')
  const size = paramControl({ id: 'size', type: 'float', default: 1, min: 0.001, max: 100000, step: 0.1 })
  assert.ok(size.kind === 'slider')
  assert.equal(size.scale, 'log')
})

test('a numeric param missing a bound is a plain number input', () => {
  const control = paramControl({ id: 'n', type: 'int', default: 3, min: 0 })
  assert.equal(control.kind, 'number')
  assert.ok(control.kind === 'number')
  assert.equal(control.min, 0)
  assert.equal(control.max, undefined)
})

test('boolean, select and string params map to toggle, dropdown and text', () => {
  assert.equal(paramControl({ id: 'b', type: 'boolean', default: true }).kind, 'toggle')
  const select = paramControl({
    id: 'mode', type: 'select', default: 'taubin',
    options: [{ value: 'taubin', label: 'Taubin' }, { value: 'laplacian', label: 'Laplacian' }],
  })
  assert.ok(select.kind === 'select')
  assert.deepEqual(select.options.map((o) => o.value), ['taubin', 'laplacian'])
  assert.equal(paramControl({ id: 's', type: 'string', default: 'x' }).kind, 'text')
})

test('the label falls back to a humanized id', () => {
  assert.equal(paramControl({ id: 'max_hole_size', type: 'int', default: 1 }).label, 'Max hole size')
})

test('defaults fall back per type when the schema omits them', () => {
  assert.equal(paramControl({ id: 'b', type: 'boolean' }).defaultValue, false)
  assert.equal(paramControl({ id: 'n', type: 'int', min: 4, max: 9 }).defaultValue, 4)
  assert.equal(
    paramControl({ id: 'm', type: 'select', options: [{ value: 'a', label: 'A' }] }).defaultValue,
    'a',
  )
})

test('defaultParamValues collects every default by id', () => {
  assert.deepEqual(
    defaultParamValues([
      { id: 'iterations', type: 'int', default: 5, min: 1, max: 50 },
      { id: 'mode', type: 'select', default: 'taubin', options: [{ value: 'taubin', label: 'T' }] },
      { id: 'fill', type: 'boolean', default: true },
    ]),
    { iterations: 5, mode: 'taubin', fill: true },
  )
})

// ─── Slider scale ────────────────────────────────────────────────────────────

test('linear slider positions map straight through', () => {
  const control = paramControl({ id: 'i', type: 'int', default: 5, min: 1, max: 50 })
  assert.ok(control.kind === 'slider')
  assert.equal(toSliderPosition(control, 20), 20)
  assert.equal(fromSliderPosition(control, 20), 20)
})

test('log slider positions round-trip and stay within bounds', () => {
  const control = paramControl({ id: 'target_faces', type: 'int', default: 10000, min: 100, max: 1000000 })
  assert.ok(control.kind === 'slider')
  assert.equal(fromSliderPosition(control, toSliderPosition(control, 100)), 100)
  assert.equal(fromSliderPosition(control, toSliderPosition(control, 1000000)), 1000000)
  assert.equal(fromSliderPosition(control, toSliderPosition(control, 10000)), 10000)
  // Integers stay integers.
  assert.ok(Number.isInteger(fromSliderPosition(control, 0.37)))
})

// ─── Grouping ────────────────────────────────────────────────────────────────

test('ops are grouped in the canonical category order with labels', () => {
  const groups = groupMeshOps([
    op('decimate', 'topology'),
    op('prepare_for_printing', 'presets'),
    op('recenter', 'transform'),
    op('repair', 'repair'),
  ])
  assert.deepEqual(groups.map((g) => g.category), ['repair', 'transform', 'topology', 'presets'])
  assert.deepEqual(groups.map((g) => g.label), ['Repair', 'Transform', 'Topology', 'Presets'])
})

test('ops keep registry order within a group', () => {
  const groups = groupMeshOps([op('repair', 'repair'), op('recenter', 'transform'), op('repair_mesh', 'repair')])
  assert.deepEqual(groups[0].ops.map((o) => o.id), ['repair', 'repair_mesh'])
})

test('unknown categories still appear, after the known ones, alphabetically', () => {
  const groups = groupMeshOps([
    op('z', 'zeta_tools'),
    op('a', 'alpha_tools'),
    op('repair', 'repair'),
  ])
  assert.deepEqual(groups.map((g) => g.category), ['repair', 'alpha_tools', 'zeta_tools'])
  assert.equal(groups[1].label, 'Alpha tools')
})

test('inspect_mesh is left out of the groups: it has its own report panel', () => {
  const groups = groupMeshOps([op('inspect_mesh', 'analysis'), op('suggest_fixes', 'analysis')])
  assert.deepEqual(groups.map((g) => g.ops.map((o) => o.id)), [['suggest_fixes']])
})

test('the registry optimization category sits next to topology as Optimize', () => {
  const groups = groupMeshOps([op('smooth', 'optimization'), op('remesh', 'topology'), op('repair', 'repair')])
  assert.deepEqual(groups.map((g) => g.label), ['Repair', 'Topology', 'Optimize'])
})

test('an op without a category falls into Other', () => {
  const groups = groupMeshOps([{ ...op('x', ''), category: undefined as unknown as string }])
  assert.equal(groups[0].label, 'Other')
})

// ─── Confirmation / results ──────────────────────────────────────────────────

test('destructive or non-undoable ops need an in-panel confirmation', () => {
  assert.equal(requiresConfirmation(op('a', 'repair')), false)
  assert.equal(requiresConfirmation(op('a', 'repair', { destructive: true })), true)
  assert.equal(requiresConfirmation(op('a', 'repair', { undoable: false })), true)
})

test('a response with a url is a mesh update; a report is not', () => {
  assert.equal(isMeshUpdate({ url: '/workspace/a.glb', face_count: 3 }), true)
  assert.equal(isMeshUpdate({ is_watertight: true }), false)
  assert.equal(isMeshUpdate({ path: 'C:/outside.glb' }), false)
})

test('inspection badges read the report flags, null meaning unknown', () => {
  const badges = inspectionBadges({
    is_watertight: true,
    is_manifold: false,
    is_winding_consistent: true,
    is_inside_out: false,
    printable: null,
  })
  const byLabel = Object.fromEntries(badges.map((b) => [b.label, b.state]))
  assert.equal(byLabel.Watertight, 'ok')
  assert.equal(byLabel.Manifold, 'bad')
  assert.equal(byLabel['Consistent winding'], 'ok')
  // Inside-out is a problem flag: false is good.
  assert.equal(byLabel['Normals outward'], 'ok')
  assert.equal(byLabel.Printable, 'unknown')
})

test('summarizeDetails lists scalar fields and hides paths', () => {
  const rows = summarizeDetails({
    url: '/workspace/a.glb',
    path: 'a.glb',
    face_count: 12000,
    repaired: true,
    steps: ['fill holes', 'fix normals'],
    nested: { a: 1 },
  })
  assert.deepEqual(rows, [
    ['Face count', '12,000'],
    ['Repaired', 'yes'],
    ['Steps', 'fill holes, fix normals'],
  ])
})

// ─── Misc ────────────────────────────────────────────────────────────────────

test('meshPathFromUrl strips the workspace prefix and decodes serve-file urls', () => {
  assert.equal(meshPathFromUrl('/workspace/col/a.glb'), 'col/a.glb')
  assert.equal(meshPathFromUrl('/optimize/serve-file?path=C%3A%2Fm%2Fa.glb'), 'C:/m/a.glb')
  assert.equal(meshPathFromUrl('col/a.glb'), 'col/a.glb')
})

test('apiErrorMessage prefers the FastAPI detail', () => {
  assert.equal(apiErrorMessage({ response: { data: { detail: 'Unknown mesh operation: x' } }, message: 'Request failed' }), 'Unknown mesh operation: x')
  assert.equal(apiErrorMessage(new Error('Network Error')), 'Network Error')
  assert.equal(apiErrorMessage('boom'), 'boom')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Bundle mockExtensions.ts into CJS. Its only imports are type-only
// (@shared/*), so esbuild erases them and no path-alias resolution is
// required.
function loadModule() {
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-mockExtensions-test-')), 'mockExtensions.cjs')
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve('src/areas/workflows/mockExtensions.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return require(outfile)
}

function processExt(node) {
  return {
    type: 'process',
    id: 'pack',
    name: 'Pack',
    author: 'tester',
    trusted: true,
    builtin: false,
    entry: 'entry.py',
    nodes: [node],
  }
}

test('object-shaped manifest inputs are normalized to plain type strings', () => {
  const { buildAllWorkflowExtensions } = loadModule()
  // Mirrors a real-world extension manifest that declared four named image
  // slots as objects instead of the documented plain-string shape.
  const ext = processExt({
    id: 'image-to-image',
    name: 'Image to Image',
    input: 'image',
    inputs: [
      { name: 'front', label: 'Primary image', type: 'image', required: true },
      { name: 'left', label: 'Image 2', type: 'image', required: false },
      { name: 'back', label: 'Image 3', type: 'image', required: false },
      { name: 'right', label: 'Image 4', type: 'image', required: false },
    ],
    output: 'image',
    paramsSchema: [],
  })

  const [built] = buildAllWorkflowExtensions([], [ext])
  assert.deepEqual(built.inputs, ['image', 'image', 'image', 'image'])
})

test('already plain-string manifest inputs pass through unchanged', () => {
  const { buildAllWorkflowExtensions } = loadModule()
  const ext = processExt({
    id: 'sketch-to-photo',
    name: 'Sketch to Photo',
    input: 'image',
    inputs: ['image', 'text'],
    inputLabels: ['Your sketch', 'Look description'],
    output: 'image',
    paramsSchema: [],
  })

  const [built] = buildAllWorkflowExtensions([], [ext])
  assert.deepEqual(built.inputs, ['image', 'text'])
  assert.deepEqual(built.inputLabels, ['Your sketch', 'Look description'])
})

test('nodes without a multi-input array are left with inputs undefined', () => {
  const { buildAllWorkflowExtensions } = loadModule()
  const ext = processExt({
    id: 'process-node',
    name: 'Process Node',
    input: 'mesh',
    output: 'mesh',
    paramsSchema: [],
  })

  const [built] = buildAllWorkflowExtensions([], [ext])
  assert.equal(built.inputs, undefined)
})

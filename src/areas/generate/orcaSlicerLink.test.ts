import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SLICER_FORMAT,
  canOpenInOrcaSlicer,
  orcaSlicerDeepLink,
  orcaSlicerSourcePath,
} from './orcaSlicerLink.ts'

// A url_path as returned by GET /export/slicer-link (token = signed source path).
const URL_PATH = '/export/slicer/stl/V29ya2Zsb3dzL2hlcm8uZ2xi.c2lnbmF0dXJl/model.stl'

test('builds an orcaslicer://open deeplink whose file= is a percent-encoded, query-less URL ending in model.stl', () => {
  const link = orcaSlicerDeepLink('http://localhost:8765', URL_PATH)
  assert.ok(link.startsWith('orcaslicer://open?file='))
  const modelUrl = decodeURIComponent(link.slice('orcaslicer://open?file='.length))
  // OrcaSlicer derives the import format from the URL's final path segment, so
  // it must end in the real extension and carry no query string.
  assert.ok(!modelUrl.includes('?'), 'model URL must not contain a query string')
  assert.ok(modelUrl.endsWith('/model.stl'), 'model URL must end in model.stl')
  assert.equal(modelUrl, `http://localhost:8765${URL_PATH}`)
})

test('strips a trailing slash from the api origin and tolerates a path without a leading slash', () => {
  const a = decodeURIComponent(orcaSlicerDeepLink('http://localhost:8765/', URL_PATH).slice('orcaslicer://open?file='.length))
  const b = decodeURIComponent(orcaSlicerDeepLink('http://localhost:8765', URL_PATH.slice(1)).slice('orcaslicer://open?file='.length))
  assert.equal(a, `http://localhost:8765${URL_PATH}`)
  assert.equal(b, `http://localhost:8765${URL_PATH}`)
})

test('orcaSlicerSourcePath: workspace meshes give their workspace-relative path', () => {
  assert.equal(orcaSlicerSourcePath('/workspace/Workflows/checkpoints/hero.glb'), 'Workflows/checkpoints/hero.glb')
  assert.equal(orcaSlicerSourcePath('/workspace/Foo/scan.splat'), undefined)
  assert.equal(orcaSlicerSourcePath(undefined), undefined)
})

test('orcaSlicerSourcePath: an imported mesh gives its decoded absolute path', () => {
  const absolute = String.raw`C:\Users\Me\Downloads\mage_v2.glb`
  assert.equal(orcaSlicerSourcePath(`/optimize/serve-file?path=${encodeURIComponent(absolute)}`), absolute)
})

test('canOpenInOrcaSlicer accepts sliceable workspace meshes and rejects splats and empty', () => {
  assert.equal(canOpenInOrcaSlicer('/workspace/Foo/hero.glb'), true)
  assert.equal(canOpenInOrcaSlicer('/workspace/Foo/part.stl'), true)
  assert.equal(canOpenInOrcaSlicer('/workspace/Foo/part.obj'), true)
  // Gaussian splats are point clouds, not printable meshes.
  assert.equal(canOpenInOrcaSlicer('/workspace/Foo/scan.ply'), false)
  assert.equal(canOpenInOrcaSlicer('/workspace/Foo/scan.splat'), false)
  // A format the slicer route cannot convert.
  assert.equal(canOpenInOrcaSlicer('/workspace/Foo/rig.fbx'), false)
  assert.equal(canOpenInOrcaSlicer(undefined), false)
  assert.equal(canOpenInOrcaSlicer(''), false)
})

test('canOpenInOrcaSlicer accepts an imported mesh served from outside the workspace', () => {
  // `Import` serves user-picked files through /optimize/serve-file, never from
  // the workspace — excluding those made the action invisible for the most
  // direct "I have a model, slice it" path.
  assert.equal(canOpenInOrcaSlicer('/optimize/serve-file?path=%2Ftmp%2Fx.glb'), true)
  assert.equal(canOpenInOrcaSlicer('/optimize/serve-file?path=C%3A%5CUsers%5CMe%5Cmage.glb'), true)
  assert.equal(canOpenInOrcaSlicer('/optimize/serve-file?path=%2Ftmp%2Fscan.splat'), false)
})

test('SLICER_FORMAT is a format OrcaSlicer can import', () => {
  assert.equal(SLICER_FORMAT, 'stl')
})

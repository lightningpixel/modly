import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SLICER_FORMAT,
  buildOrcaSlicerDeepLink,
  canOpenInOrcaSlicer,
  encodeWorkspacePathToken,
} from './orcaSlicerLink.ts'

test('builds an orcaslicer://open deeplink whose file= is a percent-encoded, query-less URL ending in model.stl', () => {
  const link = buildOrcaSlicerDeepLink('http://localhost:8765', '/workspace/Workflows/checkpoints/hero.glb')
  assert.ok(link.startsWith('orcaslicer://open?file='))
  const modelUrl = decodeURIComponent(link.slice('orcaslicer://open?file='.length))
  // OrcaSlicer derives the import format from the URL's final path segment, so
  // it must end in the real extension and carry no query string.
  assert.ok(!modelUrl.includes('?'), 'model URL must not contain a query string')
  assert.ok(modelUrl.endsWith('/model.stl'), 'model URL must end in model.stl')
  assert.equal(
    modelUrl,
    `http://localhost:8765/export/slicer/stl/${encodeWorkspacePathToken('Workflows/checkpoints/hero.glb')}/model.stl`,
  )
})

test('token round-trips a workspace path through url-safe base64 (matches the API decode)', () => {
  const path = 'Workflows/checkpoints/hero model (v2).glb'
  const token = encodeWorkspacePathToken(path)
  assert.ok(!/[+/=]/.test(token), 'token must be url-safe with no padding')
  // Decode the way the Python API does: restore padding, then urlsafe-decode.
  const padded = token + '='.repeat((4 - (token.length % 4)) % 4)
  const decoded = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')
  assert.equal(decoded, path)
})

test('strips a trailing slash from the api origin', () => {
  const link = buildOrcaSlicerDeepLink('http://localhost:8765/', '/workspace/a.glb')
  const modelUrl = decodeURIComponent(link.slice('orcaslicer://open?file='.length))
  assert.equal(modelUrl, `http://localhost:8765/export/slicer/stl/${encodeWorkspacePathToken('a.glb')}/model.stl`)
})

test('canOpenInOrcaSlicer accepts workspace meshes and rejects splats, imports, and empty', () => {
  assert.equal(canOpenInOrcaSlicer('/workspace/Foo/hero.glb'), true)
  assert.equal(canOpenInOrcaSlicer('/workspace/Foo/scan.ply'), false)
  assert.equal(canOpenInOrcaSlicer('/workspace/Foo/scan.splat'), false)
  assert.equal(canOpenInOrcaSlicer('/optimize/serve-file?path=/tmp/x.glb'), false)
  assert.equal(canOpenInOrcaSlicer(undefined), false)
})

test('SLICER_FORMAT is a format OrcaSlicer can import', () => {
  assert.equal(SLICER_FORMAT, 'stl')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

function loadModule() {
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-contain-test-')), 'path-containment.cjs')
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve('electron/main/path-containment.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return require(outfile)
}

const { isPathInside, containingRoot } = loadModule()
const ROOT = resolve('/data/modly/workspace')

test('a child of the root is inside it', () => {
  assert.equal(isPathInside(ROOT, join(ROOT, 'Workflows', 'mesh.glb')), true)
})

test('the root itself is not a thing to delete', () => {
  assert.equal(isPathInside(ROOT, ROOT), false)
})

test('a sibling that merely shares the prefix is outside', () => {
  // `resolved.startsWith(root)` accepted this one, and it is a recursive delete.
  assert.equal(isPathInside(ROOT, ROOT + '_backup'), false)
  assert.equal(isPathInside(ROOT, ROOT + '-old'), false)
})

test('traversal out of the root is outside', () => {
  assert.equal(isPathInside(ROOT, join(ROOT, '..', '..', 'Windows')), false)
})

test('an empty root matches nothing', () => {
  // A settings field that came back blank used to make every path allowed.
  assert.equal(isPathInside('', join(ROOT, 'anything')), false)
  assert.equal(containingRoot(['', undefined], join(ROOT, 'anything')), undefined)
})

test('containingRoot picks the root that actually contains the path', () => {
  const models = resolve('/data/modly/models')
  assert.equal(containingRoot([models, ROOT], join(ROOT, 'Default')), ROOT)
  assert.equal(containingRoot([models, ROOT], resolve('/somewhere/else')), undefined)
})

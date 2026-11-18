import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const compiled = buildSync({
  entryPoints: [fileURLToPath(new URL('./nodes/mesh-exporter/processor.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  packages: 'external',
}).outputFiles[0].text

function loadProcessor(doc = {}) {
  // Exercise the real destination creation and file writing without needing
  // glTF dependencies or a generated mesh for these export-path regressions.
  class NodeIO {
    registerExtensions() { return this }
    async read() { return doc }
    async write(filePath) { writeFileSync(filePath, 'exported mesh') }
  }
  const module = { exports: {} }
  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    require: (name) => {
      if (name === '@gltf-transform/core') return { NodeIO }
      if (name === '@gltf-transform/extensions') return { ALL_EXTENSIONS: [] }
      return require(name)
    },
    Buffer,
  })
  return module.exports
}

for (const scenario of [
  { name: 'empty destination uses workspace Exports', destination: '  ', folder: 'Exports' },
  { name: 'relative directory uses workspace', destination: 'models', folder: 'models' },
  { name: 'relative filename stays a file in workspace', destination: 'Android_Female_Proportions.glb', file: 'Android_Female_Proportions.glb' },
  { name: 'nested filename creates parent directories', destination: 'models/character.glb', file: 'models/character.glb' },
  { name: 'absolute directory is preserved', absolute: true, destination: 'custom-exports', folder: 'custom-exports' },
  { name: 'absolute filename is preserved', absolute: true, destination: 'custom/character.glb', file: 'custom/character.glb' },
  { name: 'existing directory ending in glb remains a directory', destination: 'collection.glb', folder: 'collection.glb', existing: true },
  { name: 'trailing separator explicitly identifies a directory', destination: 'collection.glb/', folder: 'collection.glb' },
]) {
  test(scenario.name, async () => {
    const root = mkdtempSync(join(tmpdir(), 'modly-export-'))
    const workspaceDir = join(root, 'workspace')
    const base = scenario.absolute ? root : workspaceDir
    const destination = scenario.absolute ? join(root, scenario.destination) : scenario.destination
    if (scenario.existing) mkdirSync(join(base, scenario.folder), { recursive: true })
    try {
      const result = await loadProcessor()(
        { filePath: join(root, 'input.glb') },
        { output_path: destination },
        { workspaceDir, log() {}, progress() {} },
      )
      if (scenario.file) {
        assert.equal(result.filePath, join(base, scenario.file))
      } else {
        assert.equal(dirname(result.filePath), join(base, scenario.folder))
        assert.match(result.filePath, /export-\d+\.glb$/)
      }
      assert.equal(readFileSync(result.filePath, 'utf8'), 'exported mesh')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}

test('a filename cannot silently use a different export format', async () => {
  const root = mkdtempSync(join(tmpdir(), 'modly-export-'))
  try {
    await assert.rejects(
      loadProcessor()(
        { filePath: join(root, 'input.glb') },
        { output_path: 'character.stl', export_format: 'glb' },
        { workspaceDir: join(root, 'workspace'), log() {}, progress() {} },
      ),
      /output file extension must be \.glb/,
    )
    assert.equal(existsSync(join(root, 'workspace')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// One triangle, 0.1 m along X and 0.2 m along Y, with or without the real-size marker.
// With `texture`, it also has UVs and a base color texture of that MIME type.
function triangleDoc(extras, texture) {
  const attributes = {
    POSITION:   new Float32Array([0, 0, 0, 0.1, 0, 0, 0, 0.2, 0]),
    TEXCOORD_0: texture ? new Float32Array([0, 0, 1, 0, 0, 1]) : undefined,
  }
  const baseColor = texture && { getImage: () => new Uint8Array([1, 2, 3]), getMimeType: () => texture }
  const prim = {
    getAttribute: (name) => (attributes[name] ? { getArray: () => attributes[name] } : null),
    getIndices: () => null,
    getMaterial: () => (baseColor ? { getBaseColorTexture: () => baseColor } : null),
  }
  return {
    getRoot: () => ({
      listMeshes: () => [{ listPrimitives: () => [prim] }],
      getDefaultScene: () => ({ getExtras: () => extras }),
    }),
  }
}

function objVertices(text) {
  return text.split('\n').filter((line) => line.startsWith('v ')).map((line) => line.split(' ').slice(1).map(Number))
}

for (const scenario of [
  { name: 'a real-size asset is written in millimetres', extras: { modly: { real_scale: { unit: 'm' } } }, factor: 1000 },
  { name: 'an asset without a real size keeps its units', extras: {}, factor: 1 },
]) {
  test(scenario.name, async () => {
    const root = mkdtempSync(join(tmpdir(), 'modly-export-'))
    try {
      const context = { workspaceDir: join(root, 'workspace'), log() {}, progress() {} }
      const obj = await loadProcessor(triangleDoc(scenario.extras))(
        { filePath: join(root, 'input.glb') }, { export_format: 'obj', output_path: 'part.obj' }, context,
      )
      const vertices = objVertices(readFileSync(obj.filePath, 'utf8'))
      assert.deepEqual(vertices[1].map((v) => Number(v.toFixed(3))), [0.1 * scenario.factor, 0, 0].map((v) => Number(v.toFixed(3))))
      assert.equal(Number(vertices[2][1].toFixed(3)), Number((0.2 * scenario.factor).toFixed(3)))

      const stl = await loadProcessor(triangleDoc(scenario.extras))(
        { filePath: join(root, 'input.glb') }, { export_format: 'stl', output_path: 'part.stl' }, context,
      )
      const data = readFileSync(stl.filePath)
      // Binary STL: 84-byte header, then normal (12 bytes) and three vertices.
      assert.ok(Math.abs(data.readFloatLE(84 + 12 + 12) - 0.1 * scenario.factor) < 1e-3)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}
test('a textured OBJ gets its material and texture next to it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'modly-export-'))
  try {
    const context = { workspaceDir: join(root, 'workspace'), log() {}, progress() {} }
    const result = await loadProcessor(triangleDoc({}, 'image/png'))(
      { filePath: join(root, 'input.glb') }, { export_format: 'obj', output_path: 'models/part.obj' }, context,
    )
    const dir = join(context.workspaceDir, 'models')
    assert.equal(result.filePath, join(dir, 'part.obj'))
    const obj = readFileSync(result.filePath, 'utf8').split('\n')
    assert.ok(obj.includes('mtllib part.mtl'))
    assert.ok(obj.includes('vt 1.000000 1.000000'))
    assert.ok(readFileSync(join(dir, 'part.mtl'), 'utf8').split('\n').includes('map_Kd part_texture.png'))
    assert.deepEqual([...readFileSync(join(dir, 'part_texture.png'))], [1, 2, 3])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

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

function loadProcessor() {
  // Exercise the real destination creation and file writing without needing
  // glTF dependencies or a generated mesh for these export-path regressions.
  class NodeIO {
    registerExtensions() { return this }
    async read() { return {} }
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

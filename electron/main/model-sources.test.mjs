import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

function loadModule() {
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-model-sources-module-')), 'model-sources.cjs')
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve('electron/main/model-sources.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return require(outfile)
}

const validNode = () => ({
  model_sources: [
    {
      id: 'primary',
      provider: 'huggingface',
      repo_id: 'org/main',
      destination: '.',
      checks: ['pipeline.json'],
    },
    {
      id: 'encoder',
      provider: 'huggingface',
      repo_id: 'org/encoder',
      revision: 'refs/pr/1',
      destination: 'auxiliary/encoder',
      include_prefixes: ['config.json', 'weights/'],
      skip_prefixes: ['README.md'],
      checks: ['config.json', 'model.safetensors'],
    },
  ],
})

test('validates the new model_sources contract without reinterpreting legacy fields', () => {
  const { normalizeModelSources } = loadModule()
  const sources = normalizeModelSources(validNode())
  assert.equal(sources.length, 2)
  assert.equal(sources[1].destination, 'auxiliary/encoder')

  assert.equal(normalizeModelSources({
    hf_repo: 'legacy/repo',
    download_check: '../generate/model.safetensors',
    hf_skip_prefixes: ['weights/**'],
  }), undefined)
})

test('rejects unsafe destinations, unsupported providers, and non-portable source aliases', () => {
  const { normalizeModelSources } = loadModule()
  const source = validNode().model_sources[0]
  for (const destination of ['../outside', 'aux/CON', 'aux/name.', 'C:/models']) {
    assert.throws(
      () => normalizeModelSources({ model_sources: [{ ...source, destination }] }),
      /destination|unsafe/i,
    )
  }
  assert.throws(
    () => normalizeModelSources({ model_sources: [{ ...source, provider: 'url' }] }),
    /provider.*huggingface/i,
  )
  assert.throws(
    () => normalizeModelSources({ model_sources: [source, { ...source, id: 'PRIMARY' }] }),
    /portable-unique/i,
  )
  assert.throws(
    () => normalizeModelSources({ model_sources: [{ ...source, checks: [] }] }),
    /checks.*non-empty/i,
  )
})

test('requires every declared check and rejects symlinked extension-root ancestry', (t) => {
  const { areModelSourcesDownloaded, normalizeModelSources } = loadModule()
  const root = mkdtempSync(join(tmpdir(), 'modly-model-readiness-'))
  const models = join(root, 'models')
  const modelRoot = join(models, 'pixal3d', 'generate')
  const sources = normalizeModelSources(validNode())
  mkdirSync(join(modelRoot, 'auxiliary', 'encoder'), { recursive: true })
  writeFileSync(join(modelRoot, 'pipeline.json'), '{}')
  writeFileSync(join(modelRoot, 'auxiliary', 'encoder', 'config.json'), '{}')

  try {
    assert.equal(areModelSourcesDownloaded(models, 'pixal3d/generate', sources), false)
    writeFileSync(join(modelRoot, 'auxiliary', 'encoder', 'model.safetensors'), 'x')
    assert.equal(areModelSourcesDownloaded(models, 'pixal3d/generate', sources), true)

    writeFileSync(join(modelRoot, 'auxiliary', 'encoder', 'model.safetensors'), '')
    assert.equal(areModelSourcesDownloaded(models, 'pixal3d/generate', sources), false)
    rmSync(join(modelRoot, 'auxiliary', 'encoder', 'model.safetensors'))
    mkdirSync(join(modelRoot, 'auxiliary', 'encoder', 'model.safetensors'))
    assert.equal(areModelSourcesDownloaded(models, 'pixal3d/generate', sources), false)

    rmSync(join(models, 'pixal3d'), { recursive: true, force: true })
    const outside = join(root, 'outside')
    mkdirSync(join(outside, 'generate'), { recursive: true })
    try {
      symlinkSync(outside, join(models, 'pixal3d'), 'dir')
    } catch (error) {
      t.skip(`Symlinks unavailable: ${error}`)
      return
    }
    assert.equal(areModelSourcesDownloaded(models, 'pixal3d/generate', sources), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('validates extension-scoped groups and canonicalizes sibling references', () => {
  const { normalizeWeightGroups, normalizeWeightGroupReferences } = loadModule()
  const groups = normalizeWeightGroups({
    weight_groups: [{
      id: 'Base-Weights',
      model_sources: validNode().model_sources,
    }],
  })
  assert.deepEqual(
    normalizeWeightGroupReferences({ weight_groups: ['base-weights'] }, groups),
    ['Base-Weights'],
  )
  assert.throws(
    () => normalizeWeightGroupReferences({ weight_groups: ['missing'] }, groups),
    /unknown weight group/i,
  )
  assert.throws(
    () => normalizeWeightGroups({
      weight_groups: [
        { id: 'base', model_sources: validNode().model_sources },
        { id: 'BASE', model_sources: validNode().model_sources },
      ],
    }),
    /portable-unique/i,
  )
})

test('stores and checks shared weights under the reserved extension root', () => {
  const {
    areWeightGroupSourcesDownloaded,
    normalizeWeightGroups,
    resolveModelRoot,
    resolveWeightGroupRoot,
    resolveWeightStorageRoot,
  } = loadModule()
  const root = mkdtempSync(join(tmpdir(), 'modly-shared-readiness-'))
  const models = join(root, 'models')
  const [group] = normalizeWeightGroups({
    weight_groups: [{
      id: 'base',
      model_sources: [{
        id: 'primary', provider: 'huggingface', repo_id: 'org/base',
        destination: '.', checks: ['model.bin'],
      }],
    }],
  })
  const groupRoot = join(models, 'demo', '_shared', 'base')
  try {
    assert.equal(resolveWeightGroupRoot(models, 'demo', 'base'), groupRoot)
    assert.equal(resolveWeightStorageRoot(models, 'demo/_shared/base'), groupRoot)
    assert.throws(() => resolveModelRoot(models, 'demo/_shared'), /reserved/i)
    assert.equal(areWeightGroupSourcesDownloaded(models, 'demo', group), false)
    mkdirSync(groupRoot, { recursive: true })
    writeFileSync(join(groupRoot, 'model.bin'), 'weights')
    assert.equal(areWeightGroupSourcesDownloaded(models, 'demo', group), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

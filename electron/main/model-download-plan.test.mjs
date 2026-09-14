import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

function loadModule() {
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-model-plan-module-')), 'model-plan.cjs')
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve('electron/main/model-download-plan.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return require(outfile)
}

function setupExtension(manifest) {
  const root = mkdtempSync(join(tmpdir(), 'modly-action-plan-'))
  const user = join(root, 'user')
  const builtin = join(root, 'builtin')
  const extension = join(user, manifest.id)
  mkdirSync(extension, { recursive: true })
  mkdirSync(builtin)
  const manifestPath = join(extension, 'manifest.json')
  writeFileSync(manifestPath, JSON.stringify(manifest))
  return { root, user, builtin, manifestPath }
}

test('re-reads the installed manifest for each action and resolves only node-owned sources', async () => {
  const { resolveInstalledModelDownloadPlan } = loadModule()
  const manifest = {
    id: 'pixal3d',
    type: 'model',
    nodes: [{
      id: 'generate',
      model_sources: [{
        id: 'primary', provider: 'huggingface', repo_id: 'org/old',
        destination: '.', checks: ['model.safetensors'],
      }],
    }],
  }
  const fixture = setupExtension(manifest)
  const args = {
    modelId: 'pixal3d/generate',
    userExtensionsDir: fixture.user,
    builtinExtensionsDir: fixture.builtin,
  }
  try {
    const first = await resolveInstalledModelDownloadPlan(args)
    assert.equal(first.kind, 'multi-source')
    assert.equal(first.sources[0].repo_id, 'org/old')

    manifest.nodes[0].model_sources[0].repo_id = 'org/new'
    writeFileSync(fixture.manifestPath, JSON.stringify(manifest))
    const second = await resolveInstalledModelDownloadPlan(args)
    assert.equal(second.sources[0].repo_id, 'org/new')
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('keeps legacy sibling checks and wildcard filters unchanged', async () => {
  const { resolveInstalledModelDownloadPlan } = loadModule()
  const fixture = setupExtension({
    id: 'triposplat',
    type: 'model',
    nodes: [{
      id: 'projection',
      hf_repo: 'VAST-AI/TripoSplat',
      download_check: '../generate/diffusion_models/triposplat_fp16.safetensors',
      hf_skip_prefixes: ['weights/**', 'assets/*'],
    }],
  })
  try {
    const plan = await resolveInstalledModelDownloadPlan({
      modelId: 'triposplat/projection',
      userExtensionsDir: fixture.user,
      builtinExtensionsDir: fixture.builtin,
    })
    assert.equal(plan.kind, 'legacy')
    assert.equal(plan.downloadCheck, '../generate/diffusion_models/triposplat_fp16.safetensors')
    assert.deepEqual(plan.skipPrefixes, ['weights/**', 'assets/*'])
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('composes shared base groups with private node sources and dependency metadata', async () => {
  const {
    resolveInstalledExtensionSharedWeightGroups,
    resolveInstalledModelDownloadPlan,
  } = loadModule()
  const fixture = setupExtension({
    id: 'pixal3d',
    type: 'model',
    weight_groups: [{
      id: 'base',
      model_sources: [{
        id: 'base-model', provider: 'huggingface', repo_id: 'org/base',
        destination: '.', checks: ['pipeline.json'],
      }],
    }],
    nodes: [
      { id: 'generate', weight_groups: ['base'] },
      {
        id: 'worldsculpt',
        weight_groups: ['base'],
        model_sources: [{
          id: 'adapter', provider: 'huggingface', repo_id: 'org/adapter',
          destination: '.', checks: ['adapter.bin'],
        }],
      },
    ],
  })
  try {
    const plan = await resolveInstalledModelDownloadPlan({
      modelId: 'pixal3d/worldsculpt',
      userExtensionsDir: fixture.user,
      builtinExtensionsDir: fixture.builtin,
    })
    assert.equal(plan.kind, 'multi-source')
    assert.equal(plan.sources[0].repo_id, 'org/adapter')
    assert.equal(plan.sharedGroups[0].targetId, 'pixal3d/_shared/base')
    assert.deepEqual(plan.sharedGroups[0].dependentModelIds, [
      'pixal3d/generate',
      'pixal3d/worldsculpt',
    ])

    const groups = await resolveInstalledExtensionSharedWeightGroups({
      extensionId: 'pixal3d',
      userExtensionsDir: fixture.user,
      builtinExtensionsDir: fixture.builtin,
    })
    assert.equal(groups.length, 1)
    assert.equal(groups[0].sources[0].repo_id, 'org/base')
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('rejects unknown groups, reserved node ids, and legacy private aliases', async () => {
  const { resolveInstalledModelDownloadPlan } = loadModule()
  for (const manifest of [
    {
      id: 'unknown-group', type: 'model', nodes: [{ id: 'generate', weight_groups: ['missing'] }],
    },
    {
      id: 'reserved-node', type: 'model', nodes: [{ id: '_shared', hf_repo: 'org/model' }],
    },
    {
      id: 'legacy-private', type: 'model',
      weight_groups: [{
        id: 'base',
        model_sources: [{
          id: 'base', provider: 'huggingface', repo_id: 'org/base',
          destination: '.', checks: ['base.bin'],
        }],
      }],
      nodes: [{ id: 'generate', weight_groups: ['base'], hf_repo: 'org/private' }],
    },
  ]) {
    const fixture = setupExtension(manifest)
    const nodeId = manifest.nodes[0].id
    try {
      await assert.rejects(
        resolveInstalledModelDownloadPlan({
          modelId: `${manifest.id}/${nodeId}`,
          userExtensionsDir: fixture.user,
          builtinExtensionsDir: fixture.builtin,
        }),
        /unknown weight group|reserved|must use model_sources/i,
      )
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  }
})

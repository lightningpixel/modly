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

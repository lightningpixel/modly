/**
 * The agent's folder (local LLM engine, GGUF models, logs) sits beside the
 * other data folders. Installs set up before it existed have models/,
 * extensions/, … under the base they picked at first run, so an unsaved
 * agentDir must land next to those, not in userData.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import vm from 'node:vm'

function loadModule() {
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve('electron/main/settings-store.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  const module = { exports: {} }
  vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, require })
  return module.exports
}

const { getSettings, setSettings, ensureAgentDir } = loadModule()

test('a fresh install puts the agent folder in userData beside the others', () => {
  const userData = mkdtempSync(join(tmpdir(), 'modly-settings-'))
  const s = getSettings(userData)
  assert.equal(s.agentDir, join(userData, 'agent'))
  assert.equal(s.modelsDir, join(userData, 'models'))
})

test('an existing install gets the agent folder beside its chosen data folders', () => {
  const userData = mkdtempSync(join(tmpdir(), 'modly-settings-'))
  const base = join(userData, 'Documents', 'Modly')
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({
    modelsDir:     join(base, 'models'),
    workspaceDir:  join(base, 'workspace'),
    extensionsDir: join(base, 'extensions'),
  }))
  assert.equal(getSettings(userData).agentDir, join(base, 'agent'))
})

test('a saved agent folder is kept, and persists once any setting is written', () => {
  const userData = mkdtempSync(join(tmpdir(), 'modly-settings-'))
  const custom = join(userData, 'elsewhere', 'agent')
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ agentDir: custom }))
  assert.equal(getSettings(userData).agentDir, custom)

  setSettings(userData, { workflowsDir: join(userData, 'wf') })
  assert.equal(JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf-8')).agentDir, custom)
})

test('an existing install gets its agent folder created and pinned at startup', () => {
  const userData = mkdtempSync(join(tmpdir(), 'modly-settings-'))
  const base = join(userData, 'Documents', 'Modly')
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ modelsDir: join(base, 'models') }))

  assert.equal(ensureAgentDir(userData), join(base, 'agent'))
  assert.equal(existsSync(join(base, 'agent')), true)
  assert.equal(JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf-8')).agentDir, join(base, 'agent'))

  // Pinned: moving the models folder afterwards leaves the agent folder where it is.
  setSettings(userData, { modelsDir: join(userData, 'other-drive', 'models') })
  assert.equal(getSettings(userData).agentDir, join(base, 'agent'))
})

test('a fresh install gets its agent folder without settings.json being written', () => {
  const userData = mkdtempSync(join(tmpdir(), 'modly-settings-'))
  assert.equal(ensureAgentDir(userData), join(userData, 'agent'))
  assert.equal(existsSync(join(userData, 'agent')), true)
  assert.equal(existsSync(join(userData, 'settings.json')), false)
})

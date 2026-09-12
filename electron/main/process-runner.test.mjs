/**
 * Process-extension runners are cached per extension id and reused across
 * workflow runs. The cache must not hand back a runner that was built for
 * different arguments: the workspace folder is baked into each runner, so after
 * the user moves the workspace in Settings (which updates the backend at
 * runtime, without a restart) a stale runner keeps writing node output into the
 * old folder, where the viewer can no longer find it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

function loadModule() {
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-runner-test-')), 'process-runner.cjs')
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve('electron/main/process-runner.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return require(outfile)
}

// A JS process extension that reports the workspace it was given, plus how many
// runs this worker has served (module state survives only while it is reused).
function makeJsExtension(root) {
  const extDir = join(root, 'js-ext')
  mkdirSync(extDir, { recursive: true })
  writeFileSync(join(extDir, 'processor.js'), [
    'let runs = 0',
    'module.exports = async (input, params, context) => {',
    '  runs += 1',
    '  return { filePath: context.workspaceDir, text: String(runs) }',
    '}',
    '',
  ].join('\n'))
  return extDir
}

// A "Python" process extension driven through the same stdin/stdout protocol.
// Node stands in for the interpreter so the test needs no Python install.
function makeStdioExtension(root) {
  const extDir = join(root, 'py-ext')
  mkdirSync(extDir, { recursive: true })
  writeFileSync(join(extDir, 'processor.cjs'), [
    "let raw = ''",
    "process.stdin.on('data', (chunk) => { raw += chunk })",
    "process.stdin.on('end', () => {",
    '  const data = JSON.parse(raw)',
    "  process.stdout.write(JSON.stringify({ type: 'done', result: { filePath: data.workspaceDir } }) + '\\n')",
    '})',
    '',
  ].join('\n'))
  return extDir
}

test('a JS process runner follows the workspace after it moves', async () => {
  const { getProcessRunner, terminateAllProcessRunners } = loadModule()
  const root = mkdtempSync(join(tmpdir(), 'modly-runner-js-'))
  const extDir = makeJsExtension(root)
  const oldWorkspace = join(root, 'workspace-old')
  const newWorkspace = join(root, 'workspace-new')
  try {
    const before = await getProcessRunner('js-ext', extDir, 'processor.js', oldWorkspace, root).run({}, {})
    assert.equal(before.filePath, oldWorkspace)

    const after = await getProcessRunner('js-ext', extDir, 'processor.js', newWorkspace, root).run({}, {})
    assert.equal(after.filePath, newWorkspace)
  } finally {
    terminateAllProcessRunners()
  }
})

test('a Python process runner follows the workspace after it moves', async () => {
  const { getPythonProcessRunner, terminateAllProcessRunners } = loadModule()
  const root = mkdtempSync(join(tmpdir(), 'modly-runner-py-'))
  const extDir = makeStdioExtension(root)
  const oldWorkspace = join(root, 'workspace-old')
  const newWorkspace = join(root, 'workspace-new')
  try {
    const before = await getPythonProcessRunner('py-ext', process.execPath, extDir, 'processor.cjs', oldWorkspace, root).run({}, {})
    assert.equal(before.filePath, oldWorkspace)

    const after = await getPythonProcessRunner('py-ext', process.execPath, extDir, 'processor.cjs', newWorkspace, root).run({}, {})
    assert.equal(after.filePath, newWorkspace)
  } finally {
    terminateAllProcessRunners()
  }
})

test('unchanged arguments keep reusing the same warm runner', async () => {
  const { getProcessRunner, terminateAllProcessRunners } = loadModule()
  const root = mkdtempSync(join(tmpdir(), 'modly-runner-reuse-'))
  const extDir = makeJsExtension(root)
  const workspace = join(root, 'workspace')
  try {
    const first = getProcessRunner('js-ext', extDir, 'processor.js', workspace, root)
    assert.equal((await first.run({}, {})).text, '1')

    const second = getProcessRunner('js-ext', extDir, 'processor.js', workspace, root)
    assert.equal(second, first)
    // Same worker thread: its module state carried over instead of reloading.
    assert.equal((await second.run({}, {})).text, '2')
  } finally {
    terminateAllProcessRunners()
  }
})

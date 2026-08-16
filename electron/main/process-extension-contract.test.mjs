import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

function loadModule(entry) {
  const name = entry.split('/').at(-1).replace(/\.ts$/, '.cjs')
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-process-contract-test-')), name)
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve(entry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return require(outfile)
}

test('Python PROCESS setup payload adds only the configured Windows models directory', () => {
  const { buildExtensionSetupPayload } = loadModule('electron/main/process-extension-contract.ts')

  const payload = buildExtensionSetupPayload({
    pythonExe: 'C:\\Program Files\\Modly\\python.exe',
    extDir: 'C:\\Users\\Jane Doe\\Modly Extensions\\voice',
    gpuSm: 86,
    cudaVersion: 124,
    accelerator: 'cuda',
    platform: 'win32',
    arch: 'x64',
    modelsDir: 'C:\\Users\\Jane Doe\\Modly Models',
  })

  assert.deepEqual(payload, {
    python_exe: 'C:\\Program Files\\Modly\\python.exe',
    ext_dir: 'C:\\Users\\Jane Doe\\Modly Extensions\\voice',
    gpu_sm: 86,
    cuda_version: 124,
    accelerator: 'cuda',
    platform: 'win32',
    arch: 'x64',
    models_dir: 'C:\\Users\\Jane Doe\\Modly Models',
  })
  assert.deepEqual(
    Object.keys(payload),
    ['python_exe', 'ext_dir', 'gpu_sm', 'cuda_version', 'accelerator', 'platform', 'arch', 'models_dir'],
  )
  for (const forbidden of ['hfToken', 'HF_TOKEN', 'token', 'secret', 'settings', 'profile', 'userData']) {
    assert.equal(Object.hasOwn(payload, forbidden), false)
  }
})

test('setup payload without modelsDir preserves the legacy shape', () => {
  const { buildExtensionSetupPayload } = loadModule('electron/main/process-extension-contract.ts')

  assert.deepEqual(buildExtensionSetupPayload({
    pythonExe: '/opt/modly/python',
    extDir: '/home/jane doe/extensions/model',
    gpuSm: 0,
    cudaVersion: 0,
    accelerator: 'cpu',
    platform: 'linux',
    arch: 'x64',
  }), {
    python_exe: '/opt/modly/python',
    ext_dir: '/home/jane doe/extensions/model',
    gpu_sm: 0,
    cuda_version: 0,
    accelerator: 'cpu',
    platform: 'linux',
    arch: 'x64',
  })
})

test('host advertises Repair only for supported setup.py routes', () => {
  const { isSupportedExtensionSetup } = loadModule('electron/main/process-extension-contract.ts')

  assert.equal(isSupportedExtensionSetup('model', 'generator.py', true), true)
  assert.equal(isSupportedExtensionSetup('process', 'processor.py', true), true)
  assert.equal(isSupportedExtensionSetup('process', 'processor.py', false), false)
  assert.equal(isSupportedExtensionSetup('process', 'processor.js', true), false)
})

test('NVIDIA driver boundaries select CUDA 13.0 only for R580 and newer', () => {
  const { cudaVersionForDriverVersion } = loadModule('electron/main/process-extension-contract.ts')

  assert.equal(cudaVersionForDriverVersion('579.99'), 128)
  assert.equal(cudaVersionForDriverVersion('580.00'), 130)
  assert.equal(cudaVersionForDriverVersion('570.26'), 128)
  assert.equal(cudaVersionForDriverVersion('569.99'), 126)
  assert.equal(cudaVersionForDriverVersion('not-a-version'), 118)
})

test('R580 CUDA 13.0 metadata reaches the Python setup JSON payload', () => {
  const { buildExtensionSetupPayload, cudaVersionForDriverVersion } = loadModule('electron/main/process-extension-contract.ts')

  const payload = buildExtensionSetupPayload({
    pythonExe: '/opt/modly/python',
    extDir: '/home/jane/extensions/python-process',
    gpuSm: 90,
    cudaVersion: cudaVersionForDriverVersion('580.65.06'),
    accelerator: 'cuda',
    platform: 'linux',
    arch: 'x64',
    modelsDir: '/home/jane/Modly Models',
  })

  assert.equal(payload.cuda_version, 130)
  assert.equal(payload.models_dir, '/home/jane/Modly Models')
})

test('configured native paths are absolute, normalized, and preserve spaces and backslashes', () => {
  const { normalizeConfiguredDirectoryPath } = loadModule('electron/main/process-extension-contract.ts')

  assert.equal(
    normalizeConfiguredDirectoryPath('C:\\Users\\Jane Doe\\Modly Models\\..\\Models Library', 'modelsDir', 'win32'),
    'C:\\Users\\Jane Doe\\Models Library',
  )
  assert.equal(
    normalizeConfiguredDirectoryPath('/home/jane doe/Modly Models/../models', 'modelsDir', 'linux'),
    '/home/jane doe/models',
  )
  assert.throws(
    () => normalizeConfiguredDirectoryPath('relative/models', 'modelsDir', 'linux'),
    /modelsDir.*absolute/i,
  )
  assert.throws(
    () => normalizeConfiguredDirectoryPath('models\\relative', 'modelsDir', 'win32'),
    /modelsDir.*absolute/i,
  )
  assert.throws(
    () => normalizeConfiguredDirectoryPath('\\Models', 'modelsDir', 'win32'),
    /modelsDir.*absolute/i,
  )
  assert.throws(
    () => normalizeConfiguredDirectoryPath('/Models', 'modelsDir', 'win32'),
    /modelsDir.*absolute/i,
  )
  assert.throws(
    () => normalizeConfiguredDirectoryPath('/tmp/models\0private', 'modelsDir', 'linux'),
    /modelsDir.*null/i,
  )
})

test('Python PROCESS runtime normalizes modelsDir without changing legacy paths', () => {
  const { buildPythonProcessPayload } = loadModule('electron/main/process-extension-contract.ts')

  const payload = buildPythonProcessPayload(
    { text: 'hello', nodeId: 'node-7' },
    { voice: 'Ryan' },
    {
      modelsDir: 'C:\\Modly Data\\models dir\\..\\models library',
      workspaceDir: 'C:\\Modly Data\\workspace dir\\..\\legacy workspace',
      tempDir: 'C:\\Users\\Jane Doe\\AppData\\Local\\Temp',
    },
    'win32',
  )

  assert.deepEqual(payload, {
    input: { text: 'hello', nodeId: 'node-7' },
    params: { voice: 'Ryan' },
    nodeId: 'node-7',
    modelsDir: 'C:\\Modly Data\\models library',
    workspaceDir: 'C:\\Modly Data\\workspace dir\\..\\legacy workspace',
    tempDir: 'C:\\Users\\Jane Doe\\AppData\\Local\\Temp',
  })
  for (const forbidden of ['hfToken', 'HF_TOKEN', 'token', 'secret', 'settings', 'profile', 'userData', 'gpu', 'hardware']) {
    assert.equal(Object.hasOwn(payload, forbidden), false)
  }
})

test('PythonProcessRunner sends modelsDir on stdin and preserves NDJSON result semantics', async () => {
  const { PythonProcessRunner } = loadModule('electron/main/process-runner.ts')
  const extDir = mkdtempSync(join(tmpdir(), 'modly-python-process-test-'))
  const entry = 'echo.py'
  writeFileSync(join(extDir, entry), `
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { input += chunk })
process.stdin.on('end', () => {
  const payload = JSON.parse(input.trim())
  process.stdout.write(JSON.stringify({ type: 'done', result: { text: JSON.stringify(payload) } }) + '\\n')
})
`, 'utf8')

  const runner = new PythonProcessRunner(
    process.execPath,
    extDir,
    entry,
    '/home/jane doe/Modly Models',
    '/home/jane doe/Modly Workspace',
    '/tmp/Modly Runtime',
  )
  const result = await runner.run(
    { text: 'hello', nodeId: 'node-9' },
    { speed: 1.1 },
  )
  const payload = JSON.parse(result.text)

  assert.deepEqual(payload, {
    input: { text: 'hello', nodeId: 'node-9' },
    params: { speed: 1.1 },
    nodeId: 'node-9',
    modelsDir: '/home/jane doe/Modly Models',
    workspaceDir: '/home/jane doe/Modly Workspace',
    tempDir: '/tmp/Modly Runtime',
  })
  assert.equal(Object.hasOwn(payload, 'settings'), false)
  assert.equal(Object.hasOwn(payload, 'hfToken'), false)
})

test('cached Python runner refreshes its executable, entry, and configured storage paths before each run', async () => {
  const { getPythonProcessRunner, terminateProcessRunner } = loadModule('electron/main/process-runner.ts')
  const oldExtDir = mkdtempSync(join(tmpdir(), 'modly-python-process-cache-old-test-'))
  const newExtDir = mkdtempSync(join(tmpdir(), 'modly-python-process-cache-new-test-'))
  const oldEntry = 'old.py'
  const newEntry = 'new.py'
  const extensionId = `process-path-refresh-${Date.now()}`
  writeFileSync(join(oldExtDir, oldEntry), `
process.stdout.write(JSON.stringify({ type: 'error', message: 'stale runner configuration' }) + '\\n')
`, 'utf8')
  writeFileSync(join(newExtDir, newEntry), `
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { input += chunk })
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'done', result: { text: input.trim() } }) + '\\n')
})
`, 'utf8')

  try {
    const first = getPythonProcessRunner(
      extensionId,
      '/definitely/missing/python',
      oldExtDir,
      oldEntry,
      '/home/jane doe/Old Models',
      '/home/jane doe/Old Workspace',
      '/tmp/Old Runtime',
    )
    const second = getPythonProcessRunner(
      extensionId,
      process.execPath,
      newExtDir,
      newEntry,
      '/home/jane doe/New Models',
      '/home/jane doe/New Workspace',
      '/tmp/New Runtime',
    )

    assert.equal(second, first)
    const payload = JSON.parse((await second.run({ nodeId: 'node-refresh' }, {})).text)
    assert.equal(payload.modelsDir, '/home/jane doe/New Models')
    assert.equal(payload.workspaceDir, '/home/jane doe/New Workspace')
    assert.equal(payload.tempDir, '/tmp/New Runtime')
  } finally {
    terminateProcessRunner(extensionId)
  }
})

test('JavaScript ProcessRunner context remains unchanged and excludes modelsDir', async () => {
  const { ProcessRunner } = loadModule('electron/main/process-runner.ts')
  const extDir = mkdtempSync(join(tmpdir(), 'modly-js-process-test-'))
  const entry = 'processor.cjs'
  writeFileSync(join(extDir, entry), `
module.exports = async (input, params, context) => ({
  text: JSON.stringify({
    input,
    params,
    contextKeys: Object.keys(context).sort(),
    workspaceDir: context.workspaceDir,
    tempDir: context.tempDir,
    nodeId: context.nodeId,
    hasModelsDir: Object.hasOwn(context, 'modelsDir'),
  }),
})
`, 'utf8')

  const runner = new ProcessRunner(
    extDir,
    entry,
    '/home/jane doe/Modly Workspace',
    '/tmp/Modly Runtime',
  )
  try {
    const result = await runner.run({ text: 'hello', nodeId: 'node-js' }, { quality: 'high' })
    assert.deepEqual(JSON.parse(result.text), {
      input: { text: 'hello', nodeId: 'node-js' },
      params: { quality: 'high' },
      contextKeys: ['log', 'nodeId', 'progress', 'tempDir', 'workspaceDir'],
      workspaceDir: '/home/jane doe/Modly Workspace',
      tempDir: '/tmp/Modly Runtime',
      nodeId: 'node-js',
      hasModelsDir: false,
    })
  } finally {
    runner.terminate()
  }
})

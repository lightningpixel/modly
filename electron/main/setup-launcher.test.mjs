/**
 * Runs the setup launcher for real, with a stub standing in for pip, and checks
 * what the extension's pip invocation was rewritten into.
 *
 * The commands exercised below are copied from the official extensions'
 * setup.py, so a change that breaks AMD installs fails here rather than after a
 * multi-gigabyte download on a user's machine.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

function loadModule() {
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-launcher-test-')), 'setup-launcher.cjs')
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve('electron/main/setup-launcher.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return require(outfile)
}

const { SETUP_LAUNCHER_SOURCE } = loadModule()

function findPython() {
  for (const candidate of ['python3', 'python']) {
    const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore' })
    if (probe.status === 0) return candidate
  }
  return null
}

const PYTHON = findPython()

// The launcher's _is_pip_command looks for "pip" in the first three tokens, so
// the stub is named pip.py — matching how extensions invoke "<venv>/bin/pip".
const FAKE_PIP = `
import json, sys
with open(sys.argv[1], "w") as handle:
    json.dump(sys.argv[2:], handle)
`

/**
 * Runs a pip command through the launcher and returns the argv the stub
 * actually received, i.e. the command after every rewrite.
 */
function runThroughLauncher(pipArgs, env = {}) {
  const dir     = mkdtempSync(join(tmpdir(), 'modly-launcher-run-'))
  const fakePip = join(dir, 'pip.py')
  const capture = join(dir, 'captured.json')
  writeFileSync(fakePip, FAKE_PIP, 'utf8')

  // Stands in for the extension's setup.py: issues one pip call, exactly as the
  // real ones do, and lets the launcher's patched subprocess handle it.
  const setupPy = join(dir, 'setup.py')
  writeFileSync(setupPy, [
    'import subprocess, sys',
    `PIP = ${JSON.stringify([fakePip, capture])}`,
    `subprocess.run([sys.executable] + PIP + ${JSON.stringify(pipArgs)}, check=True)`,
  ].join('\n'), 'utf8')

  const result = spawnSync(PYTHON, ['-c', SETUP_LAUNCHER_SOURCE, setupPy, '{}'], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  assert.equal(result.status, 0, `launcher failed:\n${result.stderr}`)
  assert.ok(existsSync(capture), `pip stub was never invoked:\n${result.stderr}`)

  // Drop the stub's own two arguments; keep the pip command itself.
  return { argv: JSON.parse(readFileSync(capture, 'utf8')), stderr: result.stderr }
}

const ROCM_ENV = {
  MODLY_TORCH_FLAVOR:    'rocm',
  MODLY_TORCH_INDEX_URL: 'https://download.pytorch.org/whl/rocm7.2',
  MODLY_TORCH_SPECS:     JSON.stringify(['torch', 'torchvision']),
}

test('ROCm shim redirects a CUDA-pinned install (triposg / trellis2 shape)', { skip: !PYTHON }, () => {
  const { argv, stderr } = runThroughLauncher(
    ['install', 'torch==2.6.0', 'torchvision==0.21.0', '--index-url', 'https://download.pytorch.org/whl/cu124'],
    ROCM_ENV,
  )

  assert.deepEqual(argv, [
    'install',
    '--index-url', 'https://download.pytorch.org/whl/rocm7.2',
    'torch', 'torchvision',
  ])
  assert.match(stderr, /Redirected PyTorch to ROCm wheels/)
})

test('ROCm shim rescues the CPU fallback hunyuan3d-mini forces on Windows', { skip: !PYTHON }, () => {
  // That setup.py hardcodes the CPU index when torch_flavor is rocm on Windows;
  // without this rewrite an AMD Windows user would silently get CPU-only torch.
  const { argv } = runThroughLauncher(
    ['install', 'torch==2.6.0', 'torchvision==0.21.0', '--index-url', 'https://download.pytorch.org/whl/cpu'],
    {
      ...ROCM_ENV,
      MODLY_TORCH_INDEX_URL: 'https://repo.amd.com/rocm/whl-multi-arch/',
      MODLY_TORCH_SPECS: JSON.stringify([
        'torch[device-gfx1200]==2.11.0+rocm7.14.0',
        'torchvision[device-gfx1200]==0.26.0+rocm7.14.0',
      ]),
    },
  )

  assert.deepEqual(argv, [
    'install',
    '--index-url', 'https://repo.amd.com/rocm/whl-multi-arch/',
    'torch[device-gfx1200]==2.11.0+rocm7.14.0',
    'torchvision[device-gfx1200]==0.26.0+rocm7.14.0',
  ])
})

test('ROCm shim leaves an extension that already chose ROCm alone', { skip: !PYTHON }, () => {
  // hunyuan3d-mini's own rocm branch on Linux. Its index is kept; only the
  // requirements are normalised to what Modly resolved.
  const { argv } = runThroughLauncher(
    ['install', 'torch', 'torchvision', '--index-url', 'https://download.pytorch.org/whl/rocm7.2'],
    ROCM_ENV,
  )

  assert.deepEqual(argv, [
    'install',
    'torch', 'torchvision',
    '--index-url', 'https://download.pytorch.org/whl/rocm7.2',
  ])
})

test('ROCm shim replaces the pinned direct wheel URLs of the ARM64 path', { skip: !PYTHON }, () => {
  const { argv } = runThroughLauncher(
    [
      'install', '--retries', '10',
      '--extra-index-url', 'https://download.pytorch.org/whl/cu128',
      'https://download-r2.pytorch.org/whl/cu128/torch-2.7.0%2Bcu128-cp311-cp311-manylinux_2_28_aarch64.whl',
      'https://download-r2.pytorch.org/whl/cu128/torchvision-0.22.0-cp311-cp311-manylinux_2_28_aarch64.whl',
    ],
    ROCM_ENV,
  )

  assert.deepEqual(argv, [
    'install', '--retries', '10',
    '--index-url', 'https://download.pytorch.org/whl/rocm7.2',
    'torch', 'torchvision',
  ])
})

test('ROCm shim handles the --index-url=VALUE spelling', { skip: !PYTHON }, () => {
  const { argv } = runThroughLauncher(
    ['install', '--index-url=https://download.pytorch.org/whl/cu124', 'torch==2.6.0'],
    ROCM_ENV,
  )

  assert.deepEqual(argv, [
    'install',
    '--index-url', 'https://download.pytorch.org/whl/rocm7.2',
    'torch', 'torchvision',
  ])
})

test('ROCm shim leaves non-torch installs untouched', { skip: !PYTHON }, () => {
  // The bulk of every setup.py: core deps, rembg, etc. Nothing here is ours to
  // rewrite, and an extra --index-url would send them to the ROCm index.
  const original = ['install', 'Pillow', 'numpy', 'trimesh', 'rembg', 'onnxruntime']
  const { argv } = runThroughLauncher(original, ROCM_ENV)
  assert.deepEqual(argv, original)
})

test('ROCm shim keeps PyPI reachable when torch is mixed with other packages', { skip: !PYTHON }, () => {
  // The ROCm index mirrors torch's dependency closure only: asking it for
  // trimesh returns 403, so a mixed install would hard-fail without this.
  const { argv } = runThroughLauncher(
    ['install', 'torch==2.6.0', 'trimesh', 'diffusers', '--index-url', 'https://download.pytorch.org/whl/cu124'],
    ROCM_ENV,
  )

  assert.deepEqual(argv, [
    'install',
    '--index-url', 'https://download.pytorch.org/whl/rocm7.2',
    '--extra-index-url', 'https://pypi.org/simple',
    'torch', 'torchvision',
    'trimesh', 'diffusers',
  ])
})

test('ROCm shim does not add PyPI for a torch-only install', { skip: !PYTHON }, () => {
  // Keeping PyPI out of a pure torch install avoids pip ever preferring a
  // plain CUDA wheel over the ROCm one.
  const { argv } = runThroughLauncher(
    ['install', '--retries', '10', 'torch==2.6.0', '--index-url', 'https://download.pytorch.org/whl/cu124'],
    ROCM_ENV,
  )
  assert.ok(!argv.includes('--extra-index-url'))
})

test('shim is inert on a CUDA machine', { skip: !PYTHON }, () => {
  const original = ['install', 'torch==2.6.0', '--index-url', 'https://download.pytorch.org/whl/cu124']
  const { argv } = runThroughLauncher(original, {
    MODLY_TORCH_FLAVOR: 'cuda',
    MODLY_TORCH_INDEX_URL: '',
    MODLY_TORCH_SPECS: '[]',
  })
  assert.deepEqual(argv, original)
})

test('--no-cache-dir is still stripped alongside the ROCm rewrite', { skip: !PYTHON }, () => {
  const { argv } = runThroughLauncher(
    ['install', '--no-cache-dir', 'torch==2.6.0', '--index-url', 'https://download.pytorch.org/whl/cu124'],
    ROCM_ENV,
  )

  assert.ok(!argv.includes('--no-cache-dir'))
  assert.ok(argv.includes('https://download.pytorch.org/whl/rocm7.2'))
})

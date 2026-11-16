import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

function loadModule() {
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-gpu-test-')), 'gpu-detect.cjs')
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve('electron/main/gpu-detect.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return require(outfile)
}

const mod = loadModule()

// ─── KFD topology parsing ─────────────────────────────────────────────────────

test('formatGfxTarget decodes gfx_target_version across GPU generations', () => {
  // Encoding is major*10000 + minor*100 + step, minor and step read as hex
  // digits. 120000 is the value this machine's RX 9060 XT actually reports.
  assert.equal(mod.formatGfxTarget(120000), 'gfx1200')  // Navi 44 / RX 9060 XT
  assert.equal(mod.formatGfxTarget(120001), 'gfx1201')  // Navi 48
  assert.equal(mod.formatGfxTarget(110000), 'gfx1100')  // Navi 31
  assert.equal(mod.formatGfxTarget(110002), 'gfx1102')  // Navi 33
  assert.equal(mod.formatGfxTarget(100300), 'gfx1030')  // Navi 21
  assert.equal(mod.formatGfxTarget(90402),  'gfx942')   // MI300, hex step
  assert.equal(mod.formatGfxTarget(90010),  'gfx90a')   // MI200, hex step
})

test('formatGfxTarget rejects the "no GPU" and malformed encodings', () => {
  assert.equal(mod.formatGfxTarget(0), null)
  assert.equal(mod.formatGfxTarget(-1), null)
  assert.equal(mod.formatGfxTarget(1.5), null)
})

test('parseKfdGfxTarget skips the CPU node and reads the first GPU', () => {
  // Verbatim shape of /sys/class/kfd/kfd/topology/nodes/*/properties
  const cpuNode = 'cpu_cores_count 32\nsimd_count 0\ngfx_target_version 0\n'
  const gpuNode = 'cpu_cores_count 0\nsimd_count 64\ngfx_target_version 120000\n'

  assert.equal(mod.parseKfdGfxTarget([cpuNode, gpuNode]), 'gfx1200')
})

test('parseKfdGfxTarget prefers the discrete GPU over an APU', () => {
  // Ryzen 7840 (gfx1103, 24 SIMDs) + RX 7900 XTX (gfx1100, 384 SIMDs): the APU
  // gets the lower node number, but gfx1103 has no published wheels — the card
  // with more SIMDs is the one the user bought for this.
  const cpuNode = 'cpu_cores_count 16\nsimd_count 0\ngfx_target_version 0\n'
  const apuNode = 'cpu_cores_count 0\nsimd_count 24\ngfx_target_version 110003\n'
  const dgpuNode = 'cpu_cores_count 0\nsimd_count 384\ngfx_target_version 110000\n'

  assert.equal(mod.parseKfdGfxTarget([cpuNode, apuNode, dgpuNode]), 'gfx1100')
  // Order must not matter
  assert.equal(mod.parseKfdGfxTarget([cpuNode, dgpuNode, apuNode]), 'gfx1100')
})

test('parseKfdGfxTarget returns null without a usable GPU node', () => {
  assert.equal(mod.parseKfdGfxTarget([]), null)
  assert.equal(mod.parseKfdGfxTarget(['simd_count 0\ngfx_target_version 0\n']), null)
  // A node advertising SIMDs but no compute target is not something we can target
  assert.equal(mod.parseKfdGfxTarget(['simd_count 64\ngfx_target_version 0\n']), null)
})

test('parseKfdGfxTarget does not confuse a key with its prefix', () => {
  // simd_count must not be satisfied by e.g. "max_simd_count"
  const node = 'max_simd_count 999\nsimd_count 64\ngfx_target_version 110002\n'
  assert.equal(mod.parseKfdGfxTarget([node]), 'gfx1102')
})

// ─── nvidia-smi parsing (non-regression) ──────────────────────────────────────

test('parseNvidiaSmi maps compute cap and driver version to CUDA version', () => {
  assert.deepEqual(mod.parseNvidiaSmi('8.6, 551.61\n'), { sm: 86, cudaVersion: 124 })
  assert.deepEqual(mod.parseNvidiaSmi('12.0, 572.16\n'), { sm: 120, cudaVersion: 128 })
  assert.deepEqual(mod.parseNvidiaSmi('6.1, 470.82\n'), { sm: 61, cudaVersion: 118 })
})

test('parseNvidiaSmi falls back to sm 86 on an unparseable compute cap', () => {
  assert.deepEqual(mod.parseNvidiaSmi('N/A, 551.61\n'), { sm: 86, cudaVersion: 124 })
})

test('parseNvidiaSmi returns null on empty output', () => {
  assert.equal(mod.parseNvidiaSmi(''), null)
  assert.equal(mod.parseNvidiaSmi('   \n'), null)
})

// ─── Windows adapter mapping ──────────────────────────────────────────────────

test('parseWindowsVideoControllers accepts both the object and array JSON shapes', () => {
  const single = mod.parseWindowsVideoControllers(
    '{"Name":"AMD Radeon RX 9060 XT","PNPDeviceID":"PCI\\\\VEN_1002&DEV_7590&SUBSYS_06391043&REV_C0\\\\4&1"}',
  )
  assert.deepEqual(single, [
    { name: 'AMD Radeon RX 9060 XT', pnpDeviceId: 'PCI\\VEN_1002&DEV_7590&SUBSYS_06391043&REV_C0\\4&1' },
  ])

  const many = mod.parseWindowsVideoControllers(
    '[{"Name":"A","PNPDeviceID":"PCI\\\\VEN_1002&DEV_7550"},{"Name":"B","PNPDeviceID":"PCI\\\\VEN_8086&DEV_1234"}]',
  )
  assert.equal(many.length, 2)
})

test('parseWindowsVideoControllers survives malformed PowerShell output', () => {
  assert.deepEqual(mod.parseWindowsVideoControllers('not json'), [])
  assert.deepEqual(mod.parseWindowsVideoControllers('{"Name":"No id"}'), [])
})

test('parseAmdPciDeviceId only matches AMD vendor ids', () => {
  assert.equal(mod.parseAmdPciDeviceId('PCI\\VEN_1002&DEV_7590&SUBSYS_0'), '7590')
  assert.equal(mod.parseAmdPciDeviceId('PCI\\VEN_10DE&DEV_2684'), null)
})

test('resolveWindowsGfxTarget maps device ids by silicon, not by marketing range', () => {
  const target = (deviceId) =>
    mod.resolveWindowsGfxTarget([{ name: 'x', pnpDeviceId: `PCI\\VEN_1002&DEV_${deviceId}` }]).gfxTarget

  assert.equal(target('7590'), 'gfx1200')  // Navi 44
  assert.equal(target('7550'), 'gfx1201')  // Navi 48
  assert.equal(target('744C'), 'gfx1100')  // Navi 31, uppercase from WMI
  assert.equal(target('747e'), 'gfx1101')  // Navi 32
  // 0x73f0 sells as "RX 7600M XT" but is Navi 33 — it must not land with its
  // 0x73xx RDNA2 neighbours.
  assert.equal(target('73f0'), 'gfx1102')
  assert.equal(target('73bf'), 'gfx1030')  // Navi 21
})

test('resolveWindowsGfxTarget reports unmapped AMD cards instead of guessing', () => {
  const result = mod.resolveWindowsGfxTarget([
    { name: 'AMD Radeon RX 9999', pnpDeviceId: 'PCI\\VEN_1002&DEV_FFFF' },
  ])
  assert.equal(result.gfxTarget, null)
  assert.deepEqual(result.amdAdapters, ['AMD Radeon RX 9999'])
})

test('resolveWindowsGfxTarget ignores non-AMD adapters', () => {
  const result = mod.resolveWindowsGfxTarget([
    { name: 'NVIDIA RTX 4090', pnpDeviceId: 'PCI\\VEN_10DE&DEV_2684' },
  ])
  assert.equal(result.gfxTarget, null)
  assert.deepEqual(result.amdAdapters, [])
})

// ─── ROCm wheel source resolution ─────────────────────────────────────────────

test('resolveRocmTorchSpec uses the unpinned pytorch.org index on Linux', () => {
  const { indexUrl, specs } = mod.resolveRocmTorchSpec('linux', 'gfx1200', {})
  assert.equal(indexUrl, 'https://download.pytorch.org/whl/rocm7.2')
  assert.deepEqual(specs, ['torch', 'torchvision'])
})

test('resolveRocmTorchSpec uses AMD\'s index with a device extra on Windows', () => {
  // download.pytorch.org publishes no ROCm wheels for Windows at all.
  const { indexUrl, specs } = mod.resolveRocmTorchSpec('win32', 'gfx1200', {})
  assert.equal(indexUrl, 'https://repo.amd.com/rocm/whl-multi-arch/')
  assert.deepEqual(specs, [
    'torch[device-gfx1200]==2.11.0+rocm7.14.0',
    'torchvision[device-gfx1200]==0.26.0+rocm7.14.0',
  ])
})

test('resolveRocmTorchSpec honours MODLY_ROCM_INDEX and MODLY_ROCM_TORCH_SPEC', () => {
  const rolledBack = mod.resolveRocmTorchSpec('linux', 'gfx1200', {
    MODLY_ROCM_INDEX: 'https://download.pytorch.org/whl/rocm6.4',
    MODLY_ROCM_TORCH_SPEC: 'torch==2.8.0 torchvision==0.23.0',
  })
  assert.equal(rolledBack.indexUrl, 'https://download.pytorch.org/whl/rocm6.4')
  assert.deepEqual(rolledBack.specs, ['torch==2.8.0', 'torchvision==0.23.0'])
})

test('resolveRocmTorchSpec stays unpinned on Windows without a compute target', () => {
  // No target means no device extra to ask for; better an install that fails
  // loudly than one silently pinned to the wrong architecture.
  const { specs } = mod.resolveRocmTorchSpec('win32', null, {})
  assert.deepEqual(specs, ['torch', 'torchvision'])
})

test('torchFlavorFor maps accelerators to the setup.py argument', () => {
  assert.equal(mod.torchFlavorFor('rocm'), 'rocm')
  assert.equal(mod.torchFlavorFor('cuda'), 'cuda')
  assert.equal(mod.torchFlavorFor('cpu'), 'cpu')
  assert.equal(mod.torchFlavorFor('mps'), 'cpu')
})

// ─── Detection precedence ─────────────────────────────────────────────────────

test('detectGpuInfo keeps Apple Silicon on MPS', async () => {
  const info = await mod.detectGpuInfo({ env: {}, platform: 'darwin', arch: 'arm64' })
  assert.equal(info.accelerator, 'mps')
})

test('detectGpuInfo forced to rocm resolves wheels without probing hardware', async () => {
  const info = await mod.detectGpuInfo({
    env: { MODLY_TORCH_FLAVOR: 'rocm', MODLY_ROCM_GFX: 'gfx1201' },
    platform: 'linux',
    arch: 'x64',
  })
  assert.equal(info.accelerator, 'rocm')
  assert.equal(info.gfxTarget, 'gfx1201')
  assert.equal(info.torchIndexUrl, 'https://download.pytorch.org/whl/rocm7.2')
  // sm/cudaVersion stay at 0 so CUDA-era extensions take their most
  // conservative branch (and keep off rembg[gpu], which is CUDA-only).
  assert.equal(info.sm, 0)
  assert.equal(info.cudaVersion, 0)
})

test('detectGpuInfo forced to rocm overrides MPS on Apple Silicon', async () => {
  const info = await mod.detectGpuInfo({
    env: { MODLY_TORCH_FLAVOR: 'rocm', MODLY_ROCM_GFX: 'gfx1200' },
    platform: 'darwin',
    arch: 'arm64',
  })
  assert.equal(info.accelerator, 'rocm')
})

test('detectGpuInfo forced to cuda overrides MPS on Apple Silicon', async () => {
  // The override has to beat every probe, the darwin/arm64 default included.
  const info = await mod.detectGpuInfo({
    env: { MODLY_TORCH_FLAVOR: 'cuda' },
    platform: 'darwin',
    arch: 'arm64',
  })
  assert.equal(info.accelerator, 'cuda')
})

test('detectGpuInfo forced to cpu short-circuits everything', async () => {
  const info = await mod.detectGpuInfo({
    env: { MODLY_TORCH_FLAVOR: 'cpu', MODLY_ROCM_GFX: 'gfx1200' },
    platform: 'linux',
    arch: 'x64',
  })
  assert.deepEqual(info, { sm: 0, cudaVersion: 0, accelerator: 'cpu' })
})

test('detectGpuInfo falls back to CPU when forced to rocm on Windows with no target', async () => {
  const logs = []
  const info = await mod.detectGpuInfo({
    env: { MODLY_TORCH_FLAVOR: 'rocm' },
    platform: 'win32',
    arch: 'x64',
    onLog: (line) => logs.push(line),
  })
  assert.equal(info.accelerator, 'cpu')
  assert.ok(logs.some((l) => l.includes('MODLY_ROCM_GFX')))
})

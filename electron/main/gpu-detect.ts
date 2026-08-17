/**
 * GPU detection and PyTorch flavour resolution.
 *
 * Deliberately free of electron imports: the parsing and resolution helpers are
 * pure and get unit-tested by bundling this file directly (gpu-detect.test.mjs).
 *
 * Modly never installs PyTorch itself — each extension's setup.py does, from an
 * index it picks on its own. What we produce here is the information that lets
 * that choice land on the right wheels: the accelerator, and for AMD the ROCm
 * compute target plus the pip index/requirements the setup must end up using.
 */

import { spawn } from 'child_process'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'

export type Accelerator = 'cuda' | 'rocm' | 'mps' | 'cpu'
export type TorchFlavor = 'cuda' | 'rocm' | 'cpu'

export interface GpuInfo {
  sm:             number
  cudaVersion:    number
  accelerator:    Accelerator
  /** ROCm compute target ("gfx1200"). Only set when accelerator is 'rocm'. */
  gfxTarget?:     string
  /** pip --index-url the torch install has to come from (ROCm only). */
  torchIndexUrl?: string
  /** pip requirements replacing whatever torch pins an extension hardcodes. */
  torchSpecs?:    string[]
}

// ─── ROCm wheel sources ───────────────────────────────────────────────────────
//
// Linux and Windows need different indexes. download.pytorch.org publishes no
// ROCm wheels for Windows at all, so Windows has to go through AMD's multi-arch
// index, where the compute target is selected by a pip extra
// (torch[device-gfx1200]) instead of by the index URL.

const ROCM_LINUX_INDEX   = 'https://download.pytorch.org/whl/rocm7.2'
const ROCM_WINDOWS_INDEX = 'https://repo.amd.com/rocm/whl-multi-arch/'

// Pinned because AMD's index carries several ROCm builds side by side; this is
// the newest pair published for cp311 (Modly's embedded Python) on Windows.
const ROCM_WINDOWS_TORCH       = '2.11.0+rocm7.14.0'
const ROCM_WINDOWS_TORCHVISION = '0.26.0+rocm7.14.0'

const KFD_TOPOLOGY_DIR = '/sys/class/kfd/kfd/topology/nodes'

/**
 * AMD PCI device id → ROCm compute target, for Windows where there is no KFD
 * topology to read. Keyed by silicon rather than by marketing name: 0x73f0 is
 * sold as an "RX 7600M XT" but is Navi 33, so it belongs with gfx1102, not with
 * its 0x73xx neighbours. Device ids come from the pci.ids database.
 */
const WINDOWS_PCI_GFX_TARGETS: Record<string, string> = {
  // Navi 21 (RDNA 2)
  '73a1': 'gfx1030', '73a2': 'gfx1030', '73a3': 'gfx1030', '73a5': 'gfx1030',
  '73ab': 'gfx1030', '73ae': 'gfx1030', '73af': 'gfx1030', '73bf': 'gfx1030',
  // Navi 22 (RDNA 2)
  '73c3': 'gfx1031', '73ce': 'gfx1031', '73df': 'gfx1031',
  // Navi 23 (RDNA 2)
  '73e0': 'gfx1032', '73e1': 'gfx1032', '73e3': 'gfx1032', '73ef': 'gfx1032',
  '73ff': 'gfx1032',
  // Navi 24 (RDNA 2)
  '7421': 'gfx1034', '7422': 'gfx1034', '7423': 'gfx1034', '7424': 'gfx1034',
  '743f': 'gfx1034',
  // Navi 31 (RDNA 3)
  '7448': 'gfx1100', '7449': 'gfx1100', '744a': 'gfx1100', '744b': 'gfx1100',
  '744c': 'gfx1100', '745e': 'gfx1100',
  // Navi 32 (RDNA 3)
  '7460': 'gfx1101', '7461': 'gfx1101', '7470': 'gfx1101', '747e': 'gfx1101',
  // Navi 33 (RDNA 3)
  '73f0': 'gfx1102', '7480': 'gfx1102', '7481': 'gfx1102', '7483': 'gfx1102',
  '7487': 'gfx1102', '7489': 'gfx1102', '748b': 'gfx1102', '7499': 'gfx1102',
  '749f': 'gfx1102',
  // Navi 44 / Navi 48 (RDNA 4)
  '7590': 'gfx1200',
  '7550': 'gfx1201', '7551': 'gfx1201',
}

// ─── Pure parsing helpers ─────────────────────────────────────────────────────

/**
 * Parses `nvidia-smi --query-gpu=compute_cap,driver_version --format=csv,noheader`.
 * Returns null when the output carries no usable line.
 */
export function parseNvidiaSmi(stdout: string): { sm: number; cudaVersion: number } | null {
  const line = stdout.trim().split('\n')[0]?.trim()    // e.g. "8.6, 551.61"
  if (!line) return null

  const parts = line.split(',').map((s) => s.trim())
  const sm    = Math.round(parseFloat(parts[0] ?? '') * 10)   // → 86

  // Derive max supported CUDA version from driver version
  // Driver ≥ 520 → CUDA 11.8, ≥ 525 → 12.0, ≥ 530 → 12.1, ≥ 535 → 12.2,
  // ≥ 545 → 12.3, ≥ 550 → 12.4, ≥ 555 → 12.5, ≥ 560 → 12.6
  const driverMajor = parseInt((parts[1] ?? '').split('.')[0] ?? '0', 10)
  let cudaVersion = 118  // safe minimum
  if      (driverMajor >= 570) cudaVersion = 128  // Blackwell (RTX 50xx, sm_120)
  else if (driverMajor >= 560) cudaVersion = 126
  else if (driverMajor >= 555) cudaVersion = 125
  else if (driverMajor >= 550) cudaVersion = 124
  else if (driverMajor >= 545) cudaVersion = 123
  else if (driverMajor >= 535) cudaVersion = 122
  else if (driverMajor >= 530) cudaVersion = 121
  else if (driverMajor >= 525) cudaVersion = 120
  else if (driverMajor >= 520) cudaVersion = 118

  return { sm: isNaN(sm) ? 86 : sm, cudaVersion }
}

/**
 * Decodes the KFD `gfx_target_version` integer (major*10000 + minor*100 + step,
 * with minor and step read as hex digits) into a compute target name:
 * 120000 → gfx1200, 90402 → gfx942, 90010 → gfx90a.
 */
export function formatGfxTarget(version: number): string | null {
  if (!Number.isInteger(version) || version <= 0) return null
  const major = Math.floor(version / 10000)
  const minor = Math.floor((version % 10000) / 100)
  const step  = version % 100
  if (major <= 0 || minor > 15 || step > 15) return null
  return `gfx${major}${minor.toString(16)}${step.toString(16)}`
}

/**
 * Picks the compute target out of the KFD topology node `properties` files.
 * Node 0 is the CPU node (simd_count 0) and is skipped; the first real GPU wins.
 */
export function parseKfdGfxTarget(nodeProperties: string[]): string | null {
  for (const text of nodeProperties) {
    if (readKfdProperty(text, 'simd_count') <= 0) continue
    const target = formatGfxTarget(readKfdProperty(text, 'gfx_target_version'))
    if (target) return target
  }
  return null
}

function readKfdProperty(text: string, key: string): number {
  const match = new RegExp(`^${key}\\s+(\\d+)\\s*$`, 'm').exec(text)
  return match ? parseInt(match[1], 10) : 0
}

export interface VideoController {
  name:        string
  pnpDeviceId: string
}

/**
 * Parses the JSON emitted by `Get-CimInstance Win32_VideoController | ConvertTo-Json`.
 * PowerShell emits a bare object rather than an array when there is one adapter.
 */
export function parseWindowsVideoControllers(stdout: string): VideoController[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return []
  }
  const list = Array.isArray(parsed) ? parsed : [parsed]
  return list
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
    .map((entry) => ({
      name:        typeof entry['Name'] === 'string' ? entry['Name'] : '',
      pnpDeviceId: typeof entry['PNPDeviceID'] === 'string' ? entry['PNPDeviceID'] : '',
    }))
    .filter((c) => c.pnpDeviceId !== '')
}

/** Extracts the PCI device id from a PNPDeviceID, e.g. `PCI\VEN_1002&DEV_7590&…` → "7590". */
export function parseAmdPciDeviceId(pnpDeviceId: string): string | null {
  const match = /VEN_1002&DEV_([0-9A-F]{4})/i.exec(pnpDeviceId)
  return match ? match[1].toLowerCase() : null
}

/**
 * Resolves a compute target from the installed display adapters. Returns the
 * AMD adapters it saw as well, so an unmapped card can be reported by name
 * instead of silently falling back to CPU.
 */
export function resolveWindowsGfxTarget(
  controllers: VideoController[],
): { gfxTarget: string | null; amdAdapters: string[] } {
  const amdAdapters: string[] = []
  let gfxTarget: string | null = null

  for (const controller of controllers) {
    const deviceId = parseAmdPciDeviceId(controller.pnpDeviceId)
    if (!deviceId) continue
    amdAdapters.push(controller.name || `PCI 1002:${deviceId}`)
    gfxTarget ??= WINDOWS_PCI_GFX_TARGETS[deviceId] ?? null
  }

  return { gfxTarget, amdAdapters }
}

/**
 * The pip index and requirements an extension's torch install has to end up
 * using on this platform. `MODLY_ROCM_INDEX` and `MODLY_ROCM_TORCH_SPEC`
 * (space-separated requirements) override either half — the escape hatch when a
 * newer torch breaks an extension and you need to drop back to, say, rocm6.4.
 */
export function resolveRocmTorchSpec(
  platform: string,
  gfxTarget: string | null,
  env: NodeJS.ProcessEnv = process.env,
): { indexUrl: string; specs: string[] } {
  const indexOverride = env['MODLY_ROCM_INDEX']?.trim()
  const specOverride  = env['MODLY_ROCM_TORCH_SPEC']?.trim()

  const isWindows = platform === 'win32'
  const indexUrl  = indexOverride || (isWindows ? ROCM_WINDOWS_INDEX : ROCM_LINUX_INDEX)

  if (specOverride) return { indexUrl, specs: specOverride.split(/\s+/).filter(Boolean) }

  // AMD's multi-arch index ships one torch per compute target, selected by a
  // pip extra. The pytorch.org ROCm index bakes the targets into a single
  // wheel, so there is nothing to select and nothing to pin.
  if (isWindows && gfxTarget) {
    return {
      indexUrl,
      specs: [
        `torch[device-${gfxTarget}]==${ROCM_WINDOWS_TORCH}`,
        `torchvision[device-${gfxTarget}]==${ROCM_WINDOWS_TORCHVISION}`,
      ],
    }
  }
  return { indexUrl, specs: ['torch', 'torchvision'] }
}

/** The `torch_flavor` value extension setup.py scripts branch on. */
export function torchFlavorFor(accelerator: Accelerator): TorchFlavor {
  if (accelerator === 'rocm') return 'rocm'
  if (accelerator === 'cuda') return 'cuda'
  return 'cpu'
}

export function describeGpuInfo(info: GpuInfo): string {
  const bits = [`accelerator=${info.accelerator}`]
  if (info.accelerator === 'cuda') bits.push(`sm=${info.sm}`, `cuda=${info.cudaVersion}`)
  if (info.gfxTarget)     bits.push(`gfx=${info.gfxTarget}`)
  if (info.torchIndexUrl) bits.push(`torch_index=${info.torchIndexUrl}`)
  return bits.join(' ')
}

// ─── Detection ────────────────────────────────────────────────────────────────

function cpuInfo(): GpuInfo {
  return { sm: 0, cudaVersion: 0, accelerator: 'cpu' }
}

/**
 * AMD keeps sm/cudaVersion at 0 on purpose. Extensions that predate `torch_flavor`
 * branch on those two numbers, and 0 sends them down their most conservative
 * path — which also keeps them off `rembg[gpu]`, whose onnxruntime-gpu is
 * CUDA-only. Their torch install is then corrected by the ROCm setup shim.
 */
function rocmInfo(
  gfxTarget: string | null,
  platform:  string,
  env:       NodeJS.ProcessEnv,
): GpuInfo {
  const { indexUrl, specs } = resolveRocmTorchSpec(platform, gfxTarget, env)
  return {
    sm:            0,
    cudaVersion:   0,
    accelerator:   'rocm',
    ...(gfxTarget ? { gfxTarget } : {}),
    torchIndexUrl: indexUrl,
    torchSpecs:    specs,
  }
}

function readFlavorOverride(env: NodeJS.ProcessEnv): TorchFlavor | null {
  const raw = env['MODLY_TORCH_FLAVOR']?.trim().toLowerCase()
  return raw === 'cuda' || raw === 'rocm' || raw === 'cpu' ? raw : null
}

function queryNvidiaSmi(): Promise<{ sm: number; cudaVersion: number } | null> {
  return new Promise((resolve) => {
    // Query compute cap + driver version in one call
    const proc = spawn('nvidia-smi', ['--query-gpu=compute_cap,driver_version', '--format=csv,noheader'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let out = ''
    proc.stdout?.on('data', (d: Buffer) => { out += d.toString() })
    proc.on('close', (code) => resolve(code === 0 ? parseNvidiaSmi(out) : null))
    proc.on('error', () => resolve(null))
  })
}

/**
 * Reads the compute target straight out of the kernel's KFD topology. This
 * needs no ROCm installation and no external binary — the amdgpu driver alone
 * publishes it, which is exactly the state of a machine that has only ever run
 * PyTorch ROCm wheels (they bundle their own runtime).
 */
function readKfdGfxTarget(): string | null {
  if (!existsSync('/dev/kfd')) return null
  try {
    const nodes = readdirSync(KFD_TOPOLOGY_DIR).sort((a, b) => Number(a) - Number(b))
    const properties = nodes.map((node) => {
      try {
        return readFileSync(join(KFD_TOPOLOGY_DIR, node, 'properties'), 'utf-8')
      } catch {
        return ''
      }
    })
    return parseKfdGfxTarget(properties)
  } catch {
    return null
  }
}

function queryWindowsVideoControllers(): Promise<VideoController[]> {
  return new Promise((resolve) => {
    const proc = spawn('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_VideoController | Select-Object Name,PNPDeviceID | ConvertTo-Json -Compress',
    ], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    proc.stdout?.on('data', (d: Buffer) => { out += d.toString() })
    proc.on('close', (code) => resolve(code === 0 ? parseWindowsVideoControllers(out) : []))
    proc.on('error', () => resolve([]))
  })
}

export interface DetectOptions {
  env?:      NodeJS.ProcessEnv
  platform?: string
  arch?:     string
  onLog?:    (line: string) => void
}

export async function detectGpuInfo(options: DetectOptions = {}): Promise<GpuInfo> {
  const env      = options.env      ?? process.env
  const platform = options.platform ?? process.platform
  const arch     = options.arch     ?? process.arch
  const log      = options.onLog    ?? (() => {})

  const forced = readFlavorOverride(env)
  if (forced) log(`[gpu-detect] MODLY_TORCH_FLAVOR=${forced} — skipping auto-detection`)

  if (forced === 'cpu') return cpuInfo()

  if (forced === 'rocm') {
    const gfxTarget = await resolveGfxTarget(env, platform)
    if (!gfxTarget && platform === 'win32') {
      log('[gpu-detect] ROCm forced on Windows but no compute target found — set MODLY_ROCM_GFX (e.g. gfx1200)')
      return cpuInfo()
    }
    return rocmInfo(gfxTarget, platform, env)
  }

  if (platform === 'darwin' && arch === 'arm64') {
    return { sm: 0, cudaVersion: 0, accelerator: 'mps' }
  }

  // NVIDIA keeps priority: on a machine with both, nothing about the existing
  // CUDA behaviour changes.
  const nvidia = await queryNvidiaSmi()
  if (nvidia) return { ...nvidia, accelerator: 'cuda' }
  if (forced === 'cuda') return { sm: 0, cudaVersion: 0, accelerator: 'cuda' }

  const gfxTarget = await resolveGfxTarget(env, platform)
  if (gfxTarget) {
    log(`[gpu-detect] AMD GPU detected — compute target ${gfxTarget}`)
    return rocmInfo(gfxTarget, platform, env)
  }

  if (platform === 'win32') {
    const { amdAdapters } = resolveWindowsGfxTarget(await queryWindowsVideoControllers())
    if (amdAdapters.length > 0) {
      log(
        `[gpu-detect] AMD GPU found (${amdAdapters.join(', ')}) but its ROCm compute target is unknown. ` +
        'Falling back to CPU — set MODLY_ROCM_GFX (e.g. gfx1201) to force one.',
      )
    }
  }

  return cpuInfo()
}

async function resolveGfxTarget(env: NodeJS.ProcessEnv, platform: string): Promise<string | null> {
  const override = env['MODLY_ROCM_GFX']?.trim()
  if (override) return override
  if (platform === 'linux') return readKfdGfxTarget()
  if (platform === 'win32') return resolveWindowsGfxTarget(await queryWindowsVideoControllers()).gfxTarget
  return null
}

/**
 * VRAM sampling for the status-bar indicator (NVIDIA only, via nvidia-smi).
 *
 * The renderer polls this every couple of seconds, so the sampler:
 *   - never runs two nvidia-smi processes at once (concurrent calls share one),
 *   - kills a stalled nvidia-smi after a timeout (the driver can hang while a
 *     model is generating) and reports null for that sample,
 *   - stops spawning for the rest of the session once nvidia-smi turns out not
 *     to exist (AMD / Intel / no GPU), and
 *   - returns null on macOS without spawning anything.
 */

import { spawn } from 'child_process'

export interface NvidiaGpu {
  index:    number
  name:     string
  totalMiB: number
  usedMiB:  number
}

/** Bytes. Mirrors the `system:gpuMemory` IPC contract. */
export interface GpuMemory {
  total:     number
  used:      number
  available: number
  name:      string
}

const MIB = 1024 * 1024

export const NVIDIA_SMI_ARGS = [
  '--query-gpu=index,name,memory.total,memory.used',
  '--format=csv,noheader,nounits',
]

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Parses `nvidia-smi --query-gpu=index,name,memory.total,memory.used
 * --format=csv,noheader,nounits`, e.g. "0, NVIDIA GeForce RTX 4090, 24564, 1234".
 * The name sits between the index and the two numbers, so a name that itself
 * contains commas is rebuilt from the middle fields. Lines that do not parse
 * (blank, "[N/A]", error text) are skipped.
 */
export function parseNvidiaSmiGpus(stdout: string): NvidiaGpu[] {
  const gpus: NvidiaGpu[] = []
  for (const raw of stdout.split(/\r?\n/)) {
    const parts = raw.split(',').map((s) => s.trim())
    if (parts.length < 4) continue
    const index    = Number(parts[0])
    const totalMiB = Number(parts[parts.length - 2])
    const usedMiB  = Number(parts[parts.length - 1])
    const name     = parts.slice(1, -2).join(', ').replace(/\s+/g, ' ').trim()
    if (parts[0] === '' || !Number.isInteger(index)) continue
    if (!Number.isFinite(totalMiB) || !Number.isFinite(usedMiB)) continue
    if (totalMiB <= 0 || usedMiB < 0) continue
    gpus.push({ index, name, totalMiB, usedMiB })
  }
  return gpus
}

/** The GPU with the most memory (where heavy models end up); first one wins ties. */
export function pickGpu(gpus: NvidiaGpu[]): NvidiaGpu | null {
  let best: NvidiaGpu | null = null
  for (const gpu of gpus) {
    if (!best || gpu.totalMiB > best.totalMiB) best = gpu
  }
  return best
}

export function toGpuMemory(gpu: NvidiaGpu): GpuMemory {
  const total = gpu.totalMiB * MIB
  const used  = Math.min(gpu.usedMiB * MIB, total)
  return { total, used, available: total - used, name: gpu.name || `GPU ${gpu.index}` }
}

// ─── Sampler ──────────────────────────────────────────────────────────────────

/**
 * Outcome of one nvidia-smi run. `missing` means the binary is not there and
 * never will be this session; `failed` covers timeouts and non-zero exits,
 * which may clear up on the next sample.
 */
export type NvidiaSmiResult =
  | { kind: 'ok'; stdout: string }
  | { kind: 'missing' }
  | { kind: 'failed' }

export type NvidiaSmiRunner = (args: string[], timeoutMs: number) => Promise<NvidiaSmiResult>

export const runNvidiaSmi: NvidiaSmiRunner = (args, timeoutMs) =>
  new Promise((resolve) => {
    let settled = false
    const finish = (result: NvidiaSmiResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const proc = spawn('nvidia-smi', args, {
      stdio:       ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    const timer = setTimeout(() => {
      proc.kill()
      finish({ kind: 'failed' })
    }, timeoutMs)

    let out = ''
    proc.stdout?.on('data', (d: Buffer) => { out += d.toString() })
    proc.on('close', (code) => finish(code === 0 ? { kind: 'ok', stdout: out } : { kind: 'failed' }))
    proc.on('error', (err: NodeJS.ErrnoException) =>
      finish(err.code === 'ENOENT' ? { kind: 'missing' } : { kind: 'failed' }))
  })

export interface GpuMemorySamplerOptions {
  run?:       NvidiaSmiRunner
  platform?:  NodeJS.Platform
  timeoutMs?: number
}

export function createGpuMemorySampler(options: GpuMemorySamplerOptions = {}): () => Promise<GpuMemory | null> {
  const run       = options.run ?? runNvidiaSmi
  const platform  = options.platform ?? process.platform
  const timeoutMs = options.timeoutMs ?? 3000

  let unavailable = platform === 'darwin'
  let inFlight: Promise<GpuMemory | null> | null = null

  const sampleOnce = async (): Promise<GpuMemory | null> => {
    try {
      const result = await run(NVIDIA_SMI_ARGS, timeoutMs)
      if (result.kind === 'missing') {
        unavailable = true
        return null
      }
      if (result.kind !== 'ok') return null
      const gpu = pickGpu(parseNvidiaSmiGpus(result.stdout))
      return gpu ? toGpuMemory(gpu) : null
    } catch {
      return null
    }
  }

  return () => {
    if (unavailable) return Promise.resolve(null)
    if (!inFlight) {
      inFlight = sampleOnce().finally(() => { inFlight = null })
    }
    return inFlight
  }
}

/** Session-wide sampler used by the `system:gpuMemory` IPC handler. */
export const sampleGpuMemory = createGpuMemorySampler()

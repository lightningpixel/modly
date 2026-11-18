import assert from 'node:assert/strict'
import test from 'node:test'

async function load() {
  return import(new URL('./gpu-memory.ts', import.meta.url).href)
}

const MIB = 1024 * 1024

test('parses a single GPU and converts MiB to bytes', async () => {
  const { parseNvidiaSmiGpus, pickGpu, toGpuMemory } = await load()
  const gpus = parseNvidiaSmiGpus('0, NVIDIA GeForce RTX 4090, 24564, 1234\n')
  assert.deepEqual(gpus, [{ index: 0, name: 'NVIDIA GeForce RTX 4090', totalMiB: 24564, usedMiB: 1234 }])
  assert.deepEqual(toGpuMemory(pickGpu(gpus)), {
    total:     24564 * MIB,
    used:      1234 * MIB,
    available: (24564 - 1234) * MIB,
    name:      'NVIDIA GeForce RTX 4090',
  })
})

test('picks the GPU with the most memory on a multi-GPU machine', async () => {
  const { parseNvidiaSmiGpus, pickGpu } = await load()
  const stdout = [
    '0, NVIDIA GeForce GTX 1650, 4096, 300',
    '1, NVIDIA GeForce RTX 3090, 24576, 9000',
    '2, NVIDIA GeForce RTX 3060, 12288, 100',
  ].join('\r\n')
  const gpus = parseNvidiaSmiGpus(stdout)
  assert.equal(gpus.length, 3)
  assert.equal(pickGpu(gpus).index, 1)
  assert.equal(pickGpu(gpus).name, 'NVIDIA GeForce RTX 3090')
})

test('keeps the first GPU on a tie', async () => {
  const { parseNvidiaSmiGpus, pickGpu } = await load()
  const gpus = parseNvidiaSmiGpus('0, A, 8192, 1\n1, B, 8192, 2\n')
  assert.equal(pickGpu(gpus).index, 0)
})

test('rebuilds names containing commas and collapses extra spaces', async () => {
  const { parseNvidiaSmiGpus } = await load()
  const [gpu] = parseNvidiaSmiGpus('  3 ,  Quadro  RTX,   8000 Rev,B  , 49152 , 0  ')
  assert.deepEqual(gpu, { index: 3, name: 'Quadro RTX, 8000 Rev, B', totalMiB: 49152, usedMiB: 0 })
})

test('skips lines with [N/A] or garbage and keeps the valid ones', async () => {
  const { parseNvidiaSmiGpus, pickGpu } = await load()
  const gpus = parseNvidiaSmiGpus('0, Tesla, [N/A], [N/A]\nnot a gpu\n1, RTX 4070, 12282, 512\n')
  assert.equal(gpus.length, 1)
  assert.equal(pickGpu(gpus).name, 'RTX 4070')
})

test('empty or error output yields no GPU', async () => {
  const { parseNvidiaSmiGpus, pickGpu } = await load()
  for (const stdout of ['', '\n\n', 'NVIDIA-SMI has failed because it couldn\'t communicate with the NVIDIA driver.', ', , ,', '0, X, 0, 0']) {
    assert.equal(pickGpu(parseNvidiaSmiGpus(stdout)), null, JSON.stringify(stdout))
  }
})

test('sampler returns the parsed GPU and passes the timeout', async () => {
  const { createGpuMemorySampler, NVIDIA_SMI_ARGS } = await load()
  const calls: Array<{ args: string[]; timeoutMs: number }> = []
  const sample = createGpuMemorySampler({
    platform: 'win32',
    timeoutMs: 3000,
    run: async (args: string[], timeoutMs: number) => {
      calls.push({ args, timeoutMs })
      return { kind: 'ok', stdout: '0, RTX, 8192, 2048\n' }
    },
  })
  const mem = await sample()
  assert.deepEqual(mem, { total: 8192 * MIB, used: 2048 * MIB, available: 6144 * MIB, name: 'RTX' })
  assert.deepEqual(calls, [{ args: NVIDIA_SMI_ARGS, timeoutMs: 3000 }])
})

test('sampler remembers a missing nvidia-smi and stops spawning', async () => {
  const { createGpuMemorySampler } = await load()
  let runs = 0
  const sample = createGpuMemorySampler({
    platform: 'linux',
    run: async () => { runs++; return { kind: 'missing' } },
  })
  assert.equal(await sample(), null)
  assert.equal(await sample(), null)
  assert.equal(await sample(), null)
  assert.equal(runs, 1)
})

test('sampler retries after a transient failure (timeout / non-zero exit)', async () => {
  const { createGpuMemorySampler } = await load()
  const results = [{ kind: 'failed' }, { kind: 'ok', stdout: '0, RTX, 4096, 0' }]
  let runs = 0
  const sample = createGpuMemorySampler({
    platform: 'linux',
    run: async () => results[runs++],
  })
  assert.equal(await sample(), null)
  assert.equal((await sample())?.name, 'RTX')
  assert.equal(runs, 2)
})

test('sampler shares one in-flight run between concurrent calls', async () => {
  const { createGpuMemorySampler } = await load()
  let runs = 0
  let release: (value: unknown) => void = () => {}
  const sample = createGpuMemorySampler({
    platform: 'win32',
    run: () => {
      runs++
      return new Promise((resolve) => { release = resolve })
    },
  })
  const a = sample()
  const b = sample()
  assert.equal(a, b)
  release({ kind: 'ok', stdout: '0, RTX, 4096, 1024' })
  const [ra, rb] = await Promise.all([a, b])
  assert.equal(runs, 1)
  assert.deepEqual(ra, rb)

  // Once settled, the next call starts a fresh run.
  const c = sample()
  release({ kind: 'failed' })
  assert.equal(await c, null)
  assert.equal(runs, 2)
})

test('sampler never spawns on macOS', async () => {
  const { createGpuMemorySampler } = await load()
  let runs = 0
  const sample = createGpuMemorySampler({
    platform: 'darwin',
    run: async () => { runs++; return { kind: 'ok', stdout: '0, X, 1024, 0' } },
  })
  assert.equal(await sample(), null)
  assert.equal(runs, 0)
})

test('sampler swallows a throwing runner', async () => {
  const { createGpuMemorySampler } = await load()
  const sample = createGpuMemorySampler({
    platform: 'linux',
    run: async () => { throw new Error('boom') },
  })
  assert.equal(await sample(), null)
})


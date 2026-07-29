import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { TextureWatchUpdate } from '../../src/shared/types/liveTexture.ts'
import { readPngInfo, TextureWatchService } from './texture-watch-service.ts'

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

async function waitFor(
  updates: TextureWatchUpdate[],
  predicate: (update: TextureWatchUpdate) => boolean,
  timeoutMs = 3_000,
): Promise<TextureWatchUpdate> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const match = updates.find(predicate)
    if (match) return match
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for texture update. Saw: ${JSON.stringify(updates)}`)
}

test('reads PNG dimensions and rejects a partial save', () => {
  assert.deepEqual(readPngInfo(ONE_PIXEL_PNG), { width: 1, height: 1 })
  assert.throws(
    () => readPngInfo(ONE_PIXEL_PNG.subarray(0, 24)),
    /invalid PNG header|incomplete PNG file/,
  )
})

test('reports a malformed save, keeps watching, and recovers on the next valid save', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'modly-texture-watch-'))
  const filePath = join(dir, 'paint.png')
  const updates: TextureWatchUpdate[] = []
  const service = new TextureWatchService()

  try {
    await writeFile(filePath, ONE_PIXEL_PNG)
    const initial = await service.start(7, filePath, (update) => updates.push(update))
    assert.equal(initial.state, 'ready')
    assert.equal(initial.width, 1)
    assert.equal(initial.height, 1)

    await writeFile(filePath, Buffer.from('not an image'))
    await waitFor(updates, (update) => update.state === 'reading')
    const failed = await waitFor(updates, (update) => update.state === 'error')
    assert.match(failed.message ?? '', /could not be read/)

    await writeFile(filePath, ONE_PIXEL_PNG)
    const recovered = await waitFor(
      updates,
      (update) => update.state === 'ready' && update.revision > failed.revision,
    )
    assert.equal(recovered.width, 1)
    assert.equal(recovered.height, 1)
    assert.match(recovered.dataUrl ?? '', /^data:image\/png;base64,/)
  } finally {
    service.stopAll()
    await rm(dir, { recursive: true, force: true })
  }
})

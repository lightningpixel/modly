import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const {
  MAX_SCENE_MANIFEST_BYTES,
  readLocalFileBase64,
} = await import(new URL('./bounded-file-reader.ts', import.meta.url).href)

test('the authoritative readFileBase64 IPC delegates to the bounded reader', () => {
  const handlers = readFileSync(resolve('electron/main/ipc-handlers.ts'), 'utf8')
  assert.match(
    handlers,
    /ipcMain\.handle\('fs:readFileBase64',[\s\S]*?readLocalFileBase64\(filePath\)/,
  )
})

test('oversized scene manifests are rejected before their bytes are read', async () => {
  let reads = 0
  await assert.rejects(
    readLocalFileBase64('/workspace/room/scene-manifest.json', {
      statFile: async () => ({ size: MAX_SCENE_MANIFEST_BYTES + 1, isFile: () => true }),
      readBytes: async () => { reads++; return new Uint8Array() },
    }),
    /exceeds the 1 MiB limit/,
  )
  assert.equal(reads, 0)
})

test('scene manifests at the bound are read and encoded', async () => {
  const bytes = new TextEncoder().encode('{"schema":"modly.scene-manifest.v1"}')
  const encoded = await readLocalFileBase64('/workspace/room/scene-manifest.json', {
    statFile: async () => ({ size: MAX_SCENE_MANIFEST_BYTES, isFile: () => true }),
    readBytes: async () => bytes,
  })
  assert.equal(encoded, Buffer.from(bytes).toString('base64'))
})

test('a manifest that grows after stat is rejected before base64 transfer', async () => {
  await assert.rejects(
    readLocalFileBase64('/workspace/room/scene-manifest.json', {
      statFile: async () => ({ size: 1, isFile: () => true }),
      readBytes: async () => new Uint8Array(MAX_SCENE_MANIFEST_BYTES + 1),
    }),
    /exceeds the 1 MiB limit/,
  )
})

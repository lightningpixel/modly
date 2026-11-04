import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const outfile = join(mkdtempSync(join(tmpdir(), 'modly-video-import-build-')), 'import.cjs')
writeFileSync(outfile, buildSync({ entryPoints: [resolve('electron/main/video-import.ts')], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text)
const { importVideoToWorkspace } = createRequire(import.meta.url)(outfile)

test('video import creates a durable workspace copy and refuses symlink sources', async () => {
  const root = mkdtempSync(join(tmpdir(), 'modly-video-import-'))
  const source = join(root, 'source clip.mp4')
  const payload = Buffer.from('\x00\x00\x00\x18ftypisom')
  writeFileSync(source, payload)
  const result = await importVideoToWorkspace(source, join(root, 'workspace'))
  assert.match(result.workspacePath, /^Workflows\/Imported Videos\/[0-9a-f-]+-source_clip\.mp4$/)
  assert.deepEqual(readFileSync(result.absolutePath), payload)
  const link = join(root, 'linked.mp4')
  symlinkSync(source, link)
  await assert.rejects(importVideoToWorkspace(link, join(root, 'workspace')), /regular file/)
})

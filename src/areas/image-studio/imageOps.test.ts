import test from 'node:test'
import assert from 'node:assert/strict'
import {
  HIDDEN_CARD,
  applyPrepareEvent,
  approxSize,
  cardForStatus,
  createRunLock,
  failInstall,
  modelViewCaption,
  notReadyMissing,
  opCopy,
  runInputFor,
  setupMessage,
  startInstall,
  stepLabel,
  type SetupCard,
} from './imageOps'
import type { StudioImage } from './imageStudioStore'

const image = (id: string, extra: Partial<StudioImage> = {}): StudioImage => ({
  id, path: `C:\\work\\${id}.png`, previewUrl: `blob:${id}`, name: `${id}.png`, createdAt: 0, ...extra,
})

const OP = 'remove_background'

// ─── runInputFor ──────────────────────────────────────────────────────────────

test('runInputFor runs on the selected image when it is an original', () => {
  const photo = image('photo')
  assert.equal(runInputFor([photo], photo, OP), photo)
})

test('runInputFor re-runs on the source when the selected image is a result of the same op', () => {
  const photo = image('photo')
  const cut = image('cut', { sourceId: 'photo', op: OP })
  assert.equal(runInputFor([cut, photo], cut, OP), photo)
})

test('runInputFor keeps a result of another op as the input', () => {
  const photo = image('photo')
  const upscaled = image('up', { sourceId: 'photo', op: 'upscale' })
  assert.equal(runInputFor([upscaled, photo], upscaled, OP), upscaled)
})

test('runInputFor falls back to the selected image when its source left the history', () => {
  const cut = image('cut', { sourceId: 'gone', op: OP })
  assert.equal(runInputFor([cut], cut, OP), cut)
})

// ─── Status → card ────────────────────────────────────────────────────────────

test('cardForStatus hides the card when the op is ready', () => {
  assert.deepEqual(cardForStatus({ ready: true, missing: [], download_bytes: null }), HIDDEN_CARD)
})

test('cardForStatus offers the download with the missing steps in install order', () => {
  assert.deepEqual(
    cardForStatus({ ready: false, missing: ['model', 'runtime'], download_bytes: 176_000_000 }),
    { phase: 'confirm', missing: ['runtime', 'model'], downloadBytes: 176_000_000 },
  )
})

test('cardForStatus ignores unknown steps and a missing size', () => {
  assert.deepEqual(
    cardForStatus({ ready: false, missing: ['model', 'gpu' as never], download_bytes: null }),
    { phase: 'confirm', missing: ['model'], downloadBytes: null },
  )
})

test('setupMessage states the size and the CPU note for background removal', () => {
  assert.equal(
    setupMessage({ id: OP, label: 'Remove background' }, 176_000_000),
    'Background removal needs a one-time download (~180 MB). It runs on your CPU, no GPU needed.',
  )
  assert.equal(setupMessage({ id: 'other', label: 'Upscale' }, null), 'Upscale needs a one-time download.')
})

test('approxSize rounds to what a person reads', () => {
  assert.equal(approxSize(null), null)
  assert.equal(approxSize(0), null)
  assert.equal(approxSize(3_200_000), '~3 MB')
  assert.equal(approxSize(204_000_000), '~200 MB')
  assert.equal(approxSize(1_430_000_000), '~1.4 GB')
})

// ─── Prepare stream → card ────────────────────────────────────────────────────

const confirm: SetupCard = { phase: 'confirm', missing: ['runtime', 'model'], downloadBytes: 200_000_000 }

test('startInstall begins on the first missing step at 0%', () => {
  const card = startInstall(confirm)
  assert.equal(card.phase, 'installing')
  assert.equal(stepLabel(card), 'Step 1 of 2 · Installing the runtime')
  assert.equal(card.phase === 'installing' && card.event.percent, 0)
})

test('applyPrepareEvent follows the step the backend reports, and keeps it until the next one', () => {
  let card = startInstall(confirm)
  card = applyPrepareEvent(card, { step: 'model', percent: 12, status: 'Downloading model', bytesDownloaded: 24, totalBytes: 200 })
  assert.equal(stepLabel(card), 'Step 2 of 2 · Downloading the model')
  card = applyPrepareEvent(card, { percent: 50 })
  assert.equal(stepLabel(card), 'Step 2 of 2 · Downloading the model')
  assert.equal(card.phase === 'installing' && card.event.percent, 50)
})

test('a single missing step is labelled without a counter', () => {
  const card = startInstall({ phase: 'confirm', missing: ['model'], downloadBytes: null })
  assert.equal(stepLabel(card), 'Downloading the model')
})

test('an error frame turns the card into an error that keeps the setup for Retry', () => {
  const card = applyPrepareEvent(startInstall(confirm), { error: 'pip failed' })
  assert.deepEqual(card, { phase: 'error', missing: ['runtime', 'model'], downloadBytes: 200_000_000, message: 'pip failed' })
  const retried = startInstall(card)
  assert.equal(retried.phase, 'installing')
  assert.equal(stepLabel(retried), 'Step 1 of 2 · Installing the runtime')
})

test('a cancelled frame and a broken stream are errors too', () => {
  assert.equal(applyPrepareEvent(startInstall(confirm), { cancelled: true }).phase, 'error')
  const failed = failInstall(startInstall(confirm), 'HTTP 500')
  assert.equal(failed.phase === 'error' && failed.message, 'HTTP 500')
})

// ─── 409 not_ready ────────────────────────────────────────────────────────────

test('notReadyMissing reads the missing steps of a 409 not_ready', () => {
  const err = { response: { status: 409, data: { detail: { code: 'not_ready', missing: ['model'] } } } }
  assert.deepEqual(notReadyMissing(err), ['model'])
})

test('notReadyMissing ignores other errors', () => {
  assert.equal(notReadyMissing(new Error('boom')), null)
  assert.equal(notReadyMissing({ response: { status: 409, data: { detail: 'busy' } } }), null)
  assert.equal(notReadyMissing({ response: { status: 500, data: { detail: { code: 'not_ready' } } } }), null)
})

// ─── Crop / auto-frame ────────────────────────────────────────────────────────

test('re-running auto-frame or crop on its own result starts again from its source', () => {
  const cut = image('cut', { sourceId: 'photo', op: OP })
  const framed = image('framed', { sourceId: 'cut', op: 'auto_frame' })
  assert.equal(runInputFor([framed, cut], framed, 'auto_frame'), cut)
  assert.equal(runInputFor([framed, cut], cut, 'auto_frame'), cut)
  const cropped = image('cropped', { sourceId: 'cut', op: 'crop' })
  assert.equal(runInputFor([cropped, cut], cropped, 'crop'), cut)
})

test('crop and auto-frame have their own running label', () => {
  assert.equal(opCopy({ id: 'crop', label: 'Crop' }).running, 'Cropping…')
  assert.equal(opCopy({ id: 'auto_frame', label: 'Auto-frame' }).running, 'Framing…')
})

test('modelViewCaption states the size sent, and warns when it is not square', () => {
  assert.equal(modelViewCaption(1024, 1024), '1024 × 1024 px · sent to Generate as is')
  assert.match(modelViewCaption(800, 600), /^800 × 600 px · not square/)
})

// ─── Run lock ─────────────────────────────────────────────────────────────────

test('one op at a time: a second op cannot run, nor free the lock of the first', () => {
  const changes: (string | null)[] = []
  const lock = createRunLock((holder) => changes.push(holder))
  assert.equal(lock.claim(OP), true)
  assert.equal(lock.claim('crop'), false)
  lock.release('crop')
  assert.equal(lock.holder(), OP)
  lock.release(OP)
  assert.equal(lock.holder(), null)
  assert.equal(lock.claim('crop'), true)
  assert.deepEqual(changes, [OP, null, 'crop'])
})

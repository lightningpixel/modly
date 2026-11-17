import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CUSTOM_PRINTER_ID,
  DEFAULT_PRINTER_CHOICE,
  MAX_VOLUME_MM,
  MIN_VOLUME_MM,
  checkFit,
  createLatestGuard,
  describeOverflow,
  errorForModel,
  formatVolume,
  isCalibrated,
  isGlbUrl,
  modelSizeMm,
  parsePrinterChoice,
  resolveBuildVolume,
} from './printBed'

const PLATE_256 = { width: 256, depth: 256, height: 256 }

test('the default printer is a 256 mm cube', () => {
  assert.deepEqual(resolveBuildVolume(DEFAULT_PRINTER_CHOICE), PLATE_256)
  assert.deepEqual(resolveBuildVolume(parsePrinterChoice(null)), PLATE_256)
})

test('a calibrated asset is shown at its real size and fits the plate', () => {
  // A 30 cm × 15 cm × 7.5 cm GLB (metres, Y up): 300 wide, 75 deep, 150 tall.
  const size = modelSizeMm({ x: 0.3, y: 0.15, z: 0.075 })
  assert.deepEqual(size, { width: 300, depth: 75, height: 150 })

  const small = modelSizeMm({ x: 0.2, y: 0.25, z: 0.1 })
  assert.deepEqual(checkFit(small, PLATE_256), { fits: true, over: [] })
})

test('a model larger than the build volume is flagged, side by side', () => {
  const size = modelSizeMm({ x: 0.3, y: 0.3, z: 0.1 })
  const fit = checkFit(size, PLATE_256)
  assert.deepEqual(fit, { fits: false, over: ['width', 'height'] })
  assert.equal(
    describeOverflow(size, PLATE_256, fit.over),
    'Too large for this printer: 300 mm wide (max 256), 300 mm tall (max 256).',
  )
})

test('a model sized exactly to the plate fits despite float noise', () => {
  const size = modelSizeMm({ x: 0.256, y: 0.256, z: 0.256 })
  assert.ok(checkFit(size, PLATE_256).fits)
})

test('the calibration marker is read from the scene userData', () => {
  assert.ok(isCalibrated({ modly: { real_scale: { unit: 'm' } } }))
  assert.ok(!isCalibrated({}))
  assert.ok(!isCalibrated(null))
  assert.ok(!isCalibrated({ modly: { real_scale: { unit: 'cm' } } }))
})

test('a stored custom printer is restored and clamped', () => {
  const choice = parsePrinterChoice(JSON.stringify({
    presetId: CUSTOM_PRINTER_ID,
    custom: { width: 5, depth: 300, height: 99999 },
  }))
  assert.deepEqual(resolveBuildVolume(choice), { width: MIN_VOLUME_MM, depth: 300, height: MAX_VOLUME_MM })
})

test('an unknown or unreadable stored printer falls back to the default', () => {
  assert.deepEqual(resolveBuildVolume(parsePrinterChoice('{"presetId":"gone"}')), PLATE_256)
  assert.deepEqual(resolveBuildVolume(parsePrinterChoice('not json')), PLATE_256)
})

test('presets and formatting', () => {
  assert.deepEqual(resolveBuildVolume({ ...DEFAULT_PRINTER_CHOICE, presetId: 'prusa-mk4' }), { width: 250, depth: 210, height: 220 })
  assert.equal(formatVolume({ width: 256, depth: 42.25, height: 7.5 }), '256 × 42.3 × 7.50 mm')
})

test('a load error disappears once another model is shown', () => {
  const error = { modelUrl: 'http://api/workspace/a.glb', message: 'The model could not be loaded.' }
  assert.equal(errorForModel(error, 'http://api/workspace/a.glb'), 'The model could not be loaded.')
  assert.equal(errorForModel(error, 'http://api/workspace/b.glb'), null)
  assert.equal(errorForModel(error, null), null)
  assert.equal(errorForModel(null, 'http://api/workspace/a.glb'), null)
})

test('a slow source choice never overrides a newer one', async () => {
  const guard = createLatestGuard()
  let shown = 'current'
  const choose = async (name: string, delay: number) => {
    const ticket = guard.take()
    await new Promise((resolve) => setTimeout(resolve, delay))
    if (guard.isLatest(ticket)) shown = name
  }
  // The first library asset answers after the user picked a second one.
  await Promise.all([choose('slow', 30), choose('fast', 0)])
  assert.equal(shown, 'fast')
})

test('only GLB meshes are shown on the plate', () => {
  assert.ok(isGlbUrl('/workspace/Workflows/a.glb'))
  assert.ok(isGlbUrl('/optimize/serve-file?path=C%3A%5Cmodels%5Cpart.glb'))
  assert.ok(!isGlbUrl('/workspace/Workflows/splat.ply'))
  assert.ok(!isGlbUrl('/optimize/serve-file?path=%2Ftmp%2Fsplat.splat'))
})

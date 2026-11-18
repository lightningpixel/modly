import test from 'node:test'
import assert from 'node:assert/strict'
import { FLIGHT_MS, flightPose, trailSample } from './logoLoaderMotion'

test('a piece rests before and after its flight', () => {
  for (const t of [-10, 0, FLIGHT_MS, FLIGHT_MS + 500, Number.NaN]) {
    const p = flightPose(t)
    assert.equal(p.offset, 0)
    assert.equal(p.scale, 1)
    assert.equal(p.inFlight, t === 0)
  }
})

test('the flight goes out, holds, comes back and snaps in', () => {
  assert.ok(flightPose(200).offset > 0.5, 'leaves fast')
  assert.ok(flightPose(600).offset >= 1, 'holds at the far point')
  const back = [850, 950, 1050, 1150, 1240].map((t) => flightPose(t).offset)
  for (let i = 1; i < back.length; i++) assert.ok(back[i]! < back[i - 1]!, 'returns monotonically')
  const snap = flightPose(1350)
  assert.equal(snap.offset, 0)
  assert.ok(snap.scale > 1 && snap.flash > 0 && snap.inFlight)
})

test('the offset curve is continuous at phase boundaries', () => {
  for (const edge of [450, 800, 1250]) {
    const jump = Math.abs(flightPose(edge - 0.01).offset - flightPose(edge).offset)
    assert.ok(jump < 0.01, `continuous at ${edge} ms (jump ${jump})`)
  }
})

test('trail particles only show while the piece travels', () => {
  assert.ok(trailSample(200, 60).alpha > 0, 'visible on the way out')
  assert.ok(trailSample(200, 60).offset < flightPose(200).offset, 'lags behind the piece')
  assert.ok(trailSample(1150, 60).alpha > 0, 'visible on the way back')
  assert.ok(trailSample(625, 30).alpha < 0.05, 'nearly gone while hovering')
  assert.equal(trailSample(FLIGHT_MS + 100, 60).alpha, 0)
  assert.equal(trailSample(1400, 60).alpha, 0, 'gone once snapped back')
})

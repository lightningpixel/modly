/**
 * Pure animation curves for the generation logo loader: where a clicked
 * piece is, as a function of the time since the click.
 */

/** Total length of one click flight. */
export const FLIGHT_MS = 1500
const OUT_END = 450
const HOLD_END = 800
const RETURN_END = 1250

export interface FlightPose {
  /** 0 at rest, 1 at the farthest point outward. */
  offset: number
  /** Tilt amount, 0..1 (the caller maps it to an angle). */
  tilt: number
  /** Uniform scale of the piece. */
  scale: number
  /** Brightness kick when the piece snaps back, 0..1. */
  flash: number
  /** Whether the piece is still busy (clicks are ignored meanwhile). */
  inFlight: boolean
}

const REST: FlightPose = { offset: 0, tilt: 0, scale: 1, flash: 0, inFlight: false }

export const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3
export const easeInCubic = (t: number): number => t ** 3
const clamp01 = (t: number): number => Math.min(1, Math.max(0, t))

/**
 * Pose of a piece `elapsedMs` after it was clicked: shoots out, hovers with a
 * small bob, falls back faster and faster, then snaps in with a little pulse.
 */
export function flightPose(elapsedMs: number): FlightPose {
  if (!(elapsedMs >= 0) || elapsedMs >= FLIGHT_MS) return REST
  const t = elapsedMs
  if (t < OUT_END) {
    const o = easeOutCubic(t / OUT_END)
    return { offset: o, tilt: o, scale: 1 + 0.04 * o, flash: 0, inFlight: true }
  }
  if (t < HOLD_END) {
    const o = 1 + 0.04 * Math.sin((Math.PI * (t - OUT_END)) / (HOLD_END - OUT_END))
    return { offset: o, tilt: 1, scale: 1.04, flash: 0, inFlight: true }
  }
  if (t < RETURN_END) {
    const o = 1 - easeInCubic((t - HOLD_END) / (RETURN_END - HOLD_END))
    return { offset: o, tilt: o, scale: 1 + 0.04 * o, flash: 0, inFlight: true }
  }
  const p = (t - RETURN_END) / (FLIGHT_MS - RETURN_END)
  return { offset: 0, tilt: 0, scale: 1 + 0.07 * Math.sin(Math.PI * p), flash: 1 - p, inFlight: true }
}

/**
 * A trail particle shows where the piece was `lagMs` ago. Its opacity follows
 * how far the piece has moved since then, so the trail is only visible while
 * the piece travels and vanishes while it hovers or rests.
 */
export function trailSample(elapsedMs: number, lagMs: number): { offset: number, alpha: number } {
  const past = flightPose(Math.max(0, elapsedMs - lagMs)).offset
  const now = flightPose(elapsedMs).offset
  const moving = elapsedMs - lagMs < RETURN_END ? Math.abs(now - past) : 0
  return { offset: past, alpha: clamp01(moving * 3) }
}

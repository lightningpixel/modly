// Pure glue between the sculpt core (SculptMesh), the viewer and the edit
// panel: availability guard, brush radius conversion, stroke history, the
// commit payload encoding and the sculpt-mode shortcuts. No React, no three.js,
// so it can be unit-tested with node --test.

import type { BrushKind } from './types'

// ─── Availability ────────────────────────────────────────────────────────────

/** Above this many triangles the sculpt core would be too slow / too heavy. */
export const SCULPT_MAX_TRIANGLES = 3_000_000

export interface SculptAvailabilityInput {
  /** Mesh URL in the viewer (currentJob.outputUrl when the job is done). */
  meshUrl: string | undefined
  generating: boolean
  /** Triangle count from the viewer; null while the mesh is still loading. */
  triangles: number | null
}

export interface SculptBlock {
  reason: string
  /**
   * True while the mesh is merely loading (e.g. the patched file a commit just
   * produced): sculpt mode can't start, but an active session isn't ended.
   */
  transient: boolean
}

/** Why sculpt mode can't be used right now, or null when it can. */
export function sculptBlock({ meshUrl, generating, triangles }: SculptAvailabilityInput): SculptBlock | null {
  const block = (reason: string, transient = false): SculptBlock => ({ reason, transient })
  if (generating) return block('Generating… sculpting unlocks once the mesh is ready.')
  if (!meshUrl) return block('Generate, import or open a mesh to sculpt it.')
  const ext = meshUrl.split('?')[0]?.split('.').pop()?.toLowerCase()
  if (ext === 'obj') return block('OBJ models can\'t be sculpted: only GLB meshes can.')
  if (ext === 'ply' || ext === 'splat') return block('Gaussian splats can\'t be sculpted.')
  if (triangles === null) return block('Loading the mesh…', true)
  if (triangles > SCULPT_MAX_TRIANGLES) {
    return block(`This mesh has too many triangles to sculpt (${triangles.toLocaleString('en-US')}). Decimate it or use Prepare for Game first.`)
  }
  return null
}

// ─── Brush radius ────────────────────────────────────────────────────────────

/** Radius is stored as a fraction of the model's bounding-box diagonal. */
export const RADIUS_MIN = 0.005
export const RADIUS_MAX = 0.5
export const RADIUS_DEFAULT = 0.05
/** F / Shift+F multiply / divide the radius by this. */
export const RADIUS_STEP = 1.25

export function clampRadius(fraction: number): number {
  if (!Number.isFinite(fraction)) return RADIUS_DEFAULT
  return Math.min(RADIUS_MAX, Math.max(RADIUS_MIN, fraction))
}

export function stepRadius(fraction: number, direction: 1 | -1): number {
  const next = direction > 0 ? fraction * RADIUS_STEP : fraction / RADIUS_STEP
  return clampRadius(Number(next.toPrecision(3)))
}

/** World-space brush radius for a model whose bbox diagonal is `modelDiagonal`. */
export function worldRadius(fraction: number, modelDiagonal: number): number {
  return clampRadius(fraction) * Math.max(modelDiagonal, 0)
}

/**
 * World radius → local radius of one mesh, whose world matrix scales by
 * `maxWorldScale` along its largest axis (Matrix4.getMaxScaleOnAxis).
 */
export function toLocalRadius(radiusWorld: number, maxWorldScale: number): number {
  return maxWorldScale > 1e-12 ? radiusWorld / maxWorldScale : radiusWorld
}

// ─── Stroke history ──────────────────────────────────────────────────────────

/** Strokes kept for local undo; older ones fall off (and the mesh stays dirty). */
export const SCULPT_HISTORY_LIMIT = 64

export interface SculptHistory<T> {
  undo: T[]
  redo: T[]
  /** True once a stroke fell off the bottom: undoing everything no longer restores the source mesh. */
  truncated: boolean
}

export function emptyHistory<T>(): SculptHistory<T> {
  return { undo: [], redo: [], truncated: false }
}

export function pushStroke<T>(h: SculptHistory<T>, entry: T, limit = SCULPT_HISTORY_LIMIT): SculptHistory<T> {
  const undo = [...h.undo, entry]
  const overflow = Math.max(0, undo.length - limit)
  return { undo: undo.slice(overflow), redo: [], truncated: h.truncated || overflow > 0 }
}

/**
 * Undo the latest stroke: `apply` swaps it back into the mesh and returns the
 * entry that redoes it. Returns `h` unchanged when there is nothing to undo; if
 * `apply` throws, the history is left as it was.
 */
export function undoStroke<T>(h: SculptHistory<T>, apply: (entry: T) => T): SculptHistory<T> {
  const entry = h.undo[h.undo.length - 1]
  if (entry === undefined) return h
  const inverse = apply(entry)
  return { ...h, undo: h.undo.slice(0, -1), redo: [...h.redo, inverse] }
}

export function redoStroke<T>(h: SculptHistory<T>, apply: (entry: T) => T): SculptHistory<T> {
  const entry = h.redo[h.redo.length - 1]
  if (entry === undefined) return h
  const inverse = apply(entry)
  return { ...h, undo: [...h.undo, inverse], redo: h.redo.slice(0, -1) }
}

/** Whether the meshes differ from the file on disk (and a commit has work to do). */
export function isHistoryDirty(h: SculptHistory<unknown>): boolean {
  return h.undo.length > 0 || h.truncated
}

// ─── Upload ranges ───────────────────────────────────────────────────────────

export interface IndexRange { min: number; max: number }

/** Union of two vertex index ranges; `region` with min > max (nothing moved) is ignored. */
export function mergeRange(pending: IndexRange | null, region: IndexRange): IndexRange | null {
  if (!(region.min <= region.max)) return pending
  if (!pending) return { min: region.min, max: region.max }
  return { min: Math.min(pending.min, region.min), max: Math.max(pending.max, region.max) }
}

/** Vertex range → BufferAttribute.addUpdateRange(start, count) arguments. */
export function attributeUpdateRange(range: IndexRange, itemSize: number): { start: number; count: number } {
  return { start: range.min * itemSize, count: (range.max - range.min + 1) * itemSize }
}

// ─── Commit payload ──────────────────────────────────────────────────────────

/** Bytes per btoa() call: a multiple of 3 so the chunks concatenate without padding. */
const BASE64_CHUNK = 3 * 10_922

/** Base64 of arbitrary bytes, encoded in slices (no giant binary string, no quadratic concat). */
export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = []
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    const slice = bytes.subarray(i, i + BASE64_CHUNK)
    parts.push(btoa(String.fromCharCode.apply(null, slice as unknown as number[])))
  }
  return parts.join('')
}

/** Base64 of a Float32Array's bytes (little-endian on every platform Modly ships on). */
export function float32ToBase64(values: Float32Array): string {
  return bytesToBase64(new Uint8Array(values.buffer, values.byteOffset, values.byteLength))
}

/** One entry of POST /optimize/patch-vertices. */
export interface VertexPatch {
  mesh: number
  primitive: number
  positions: string
  normals?: string
}

/**
 * Patch for one glTF primitive, from GLTFLoader's parser.associations entry of
 * the sculpted THREE.Mesh. Null when the mesh isn't a glTF primitive.
 */
export function buildVertexPatch(
  association: { meshes?: number; primitives?: number } | undefined,
  positions: Float32Array,
  normals: Float32Array | null,
): VertexPatch | null {
  if (!association || typeof association.meshes !== 'number' || typeof association.primitives !== 'number') return null
  const patch: VertexPatch = { mesh: association.meshes, primitive: association.primitives, positions: float32ToBase64(positions) }
  if (normals) patch.normals = float32ToBase64(normals)
  return patch
}

// ─── Model URL change ────────────────────────────────────────────────────────

/**
 * What to do with uncommitted strokes when the sculpt session of one model
 * goes away: the same mesh still in the viewer (the viewer is unmounting) →
 * save it; another mesh replaced it (undo, agent, workflow…) → the strokes no
 * longer apply to anything and are dropped.
 */
export function sessionEndOutcome(dirty: boolean, sessionUrl: string, currentUrl: string | undefined): 'none' | 'commit' | 'discard' {
  if (!dirty) return 'none'
  return currentUrl === sessionUrl ? 'commit' : 'discard'
}

// ─── Shortcuts ───────────────────────────────────────────────────────────────

export type SculptKeyAction =
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'exit' }
  | { type: 'radius'; direction: 1 | -1 }
  | { type: 'brush'; kind: BrushKind }

const BRUSH_KEYS: Record<string, BrushKind> = { g: 'grab', s: 'smooth', i: 'inflate', t: 'flatten' }

export interface KeyLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/**
 * The sculpt-mode shortcut for a keydown, or null when the key isn't one.
 * Ctrl+Z / Ctrl+Y (and Ctrl+Shift+Z) are the local stroke undo/redo; Escape
 * exits; F / Shift+F grow / shrink the brush; G S I T pick a brush.
 */
export function sculptKeyAction(e: KeyLike): SculptKeyAction | null {
  const key = e.key.toLowerCase()
  if (e.ctrlKey || e.metaKey) {
    if (key === 'z') return e.shiftKey ? { type: 'redo' } : { type: 'undo' }
    if (key === 'y') return { type: 'redo' }
    return null
  }
  if (e.altKey) return null
  if (key === 'escape') return { type: 'exit' }
  if (key === 'f') return { type: 'radius', direction: e.shiftKey ? -1 : 1 }
  if (!e.shiftKey && BRUSH_KEYS[key]) return { type: 'brush', kind: BRUSH_KEYS[key] }
  return null
}

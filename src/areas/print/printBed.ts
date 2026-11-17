// Pure logic behind the Print page: printer volumes, the model's real size and
// whether it fits. Kept free of React and three.js so node --test can load it.

/** A printer's build volume, in millimetres. Height is the printer's Z (up). */
export interface BuildVolume {
  width: number
  depth: number
  height: number
}

export interface PrinterPreset {
  id: string
  label: string
  volume: BuildVolume
}

export const PRINTER_PRESETS: readonly PrinterPreset[] = [
  { id: 'bambu-x1', label: 'Bambu Lab X1 / P1 / A1', volume: { width: 256, depth: 256, height: 256 } },
  { id: 'bambu-a1-mini', label: 'Bambu Lab A1 mini', volume: { width: 180, depth: 180, height: 180 } },
  { id: 'prusa-mk4', label: 'Prusa MK4', volume: { width: 250, depth: 210, height: 220 } },
  { id: 'prusa-mini', label: 'Prusa MINI+', volume: { width: 180, depth: 180, height: 180 } },
  { id: 'ender-3', label: 'Creality Ender-3', volume: { width: 220, depth: 220, height: 250 } },
  { id: 'voron-350', label: 'Voron 2.4 (350)', volume: { width: 350, depth: 350, height: 340 } },
]

export const CUSTOM_PRINTER_ID = 'custom'
export const DEFAULT_PRINTER_ID = 'bambu-x1'

/** Bounds of a custom build volume side, in millimetres. */
export const MIN_VOLUME_MM = 10
export const MAX_VOLUME_MM = 2000

export interface PrinterChoice {
  /** A PRINTER_PRESETS id, or CUSTOM_PRINTER_ID. */
  presetId: string
  /** The custom volume, kept while a preset is selected. */
  custom: BuildVolume
}

export const DEFAULT_PRINTER_CHOICE: PrinterChoice = {
  presetId: DEFAULT_PRINTER_ID,
  custom: { width: 200, depth: 200, height: 200 },
}

function clampSide(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(MAX_VOLUME_MM, Math.max(MIN_VOLUME_MM, value))
}

export function sanitizeVolume(value: unknown, fallback: BuildVolume = DEFAULT_PRINTER_CHOICE.custom): BuildVolume {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<Record<keyof BuildVolume, unknown>>
  return {
    width: clampSide(v.width, fallback.width),
    depth: clampSide(v.depth, fallback.depth),
    height: clampSide(v.height, fallback.height),
  }
}

/** A stored choice (JSON), falling back to the default for anything unreadable. */
export function parsePrinterChoice(raw: string | null): PrinterChoice {
  if (!raw) return DEFAULT_PRINTER_CHOICE
  try {
    const parsed = JSON.parse(raw) as { presetId?: unknown, custom?: unknown }
    const known = parsed.presetId === CUSTOM_PRINTER_ID || PRINTER_PRESETS.some((p) => p.id === parsed.presetId)
    return {
      presetId: known ? String(parsed.presetId) : DEFAULT_PRINTER_ID,
      custom: sanitizeVolume(parsed.custom),
    }
  } catch {
    return DEFAULT_PRINTER_CHOICE
  }
}

export function resolveBuildVolume(choice: PrinterChoice): BuildVolume {
  if (choice.presetId === CUSTOM_PRINTER_ID) return sanitizeVolume(choice.custom)
  return (PRINTER_PRESETS.find((p) => p.id === choice.presetId) ?? PRINTER_PRESETS[0]).volume
}

/** A viewer mesh URL (/workspace/… or /optimize/serve-file?path=…) that points at a GLB. */
export function isGlbUrl(url: string): boolean {
  let path = url
  try { path = decodeURIComponent(url) } catch { /* keep it as is */ }
  return /\.(glb|gltf)$/i.test(path)
}

/** glTF units are metres; the plate is drawn in millimetres. */
export const MM_PER_M = 1000

/** A load error, kept with the model it is about. */
export interface ModelError {
  modelUrl: string | null
  message: string
}

/** The error to show for the model on screen: one about another model is stale. */
export function errorForModel(error: ModelError | null, modelUrl: string | null): string | null {
  return error && error.modelUrl === modelUrl ? error.message : null
}

/**
 * Orders async choices: each one takes a ticket, and only the latest ticket
 * may apply its result, so a slow answer never overrides a newer choice.
 */
export function createLatestGuard(): { take: () => number, isLatest: (ticket: number) => boolean } {
  let latest = 0
  return { take: () => ++latest, isLatest: (ticket) => ticket === latest }
}

/**
 * A model's printed size in millimetres, from its glTF bounding box (Y up).
 * `mmPerUnit` is the backend's print scale (GET /export/print-scale): 1000 for
 * a calibrated asset (metres), and for an uncalibrated one the provisional
 * scale the slicer hand-off applies, so the plate and the slicer agree.
 */
export function modelSizeMm(size: { x: number, y: number, z: number }, mmPerUnit: number = MM_PER_M): BuildVolume {
  return { width: size.x * mmPerUnit, depth: size.z * mmPerUnit, height: size.y * mmPerUnit }
}

/** GET /export/print-scale/{token}: how the slicer hand-off sizes a mesh. */
export interface PrintScale {
  calibrated: boolean
  mmPerUnit: number
}

/** The backend's answer, or null when it is not a usable scale. */
export function parsePrintScale(body: unknown): PrintScale | null {
  const value = body as { calibrated?: unknown, mm_per_unit?: unknown } | null
  if (!value || typeof value.calibrated !== 'boolean') return null
  const mmPerUnit = value.mm_per_unit
  if (typeof mmPerUnit !== 'number' || !Number.isFinite(mmPerUnit) || mmPerUnit <= 0) return null
  return { calibrated: value.calibrated, mmPerUnit }
}

export type VolumeSide = keyof BuildVolume

export interface FitResult {
  fits: boolean
  /** The sides the model is larger than the build volume on. */
  over: VolumeSide[]
}

/** Sub-micron slack, so a model sized exactly to the plate still fits. */
const FIT_EPSILON_MM = 1e-3

export function checkFit(model: BuildVolume, volume: BuildVolume): FitResult {
  const sides: VolumeSide[] = ['width', 'depth', 'height']
  const over = sides.filter((side) => model[side] > volume[side] + FIT_EPSILON_MM)
  return { fits: over.length === 0, over }
}

export function formatMm(value: number): string {
  if (value >= 100) return value.toFixed(0)
  if (value >= 10) return value.toFixed(1)
  return value.toFixed(2)
}

export function formatVolume(volume: BuildVolume): string {
  return `${formatMm(volume.width)} × ${formatMm(volume.depth)} × ${formatMm(volume.height)} mm`
}

/** "Too large: 312 mm wide for a 256 mm plate." */
export function describeOverflow(model: BuildVolume, volume: BuildVolume, over: VolumeSide[]): string {
  const words: Record<VolumeSide, string> = { width: 'wide', depth: 'deep', height: 'tall' }
  const parts = over.map((side) => `${formatMm(model[side])} mm ${words[side]} (max ${formatMm(volume[side])})`)
  return `Too large for this printer: ${parts.join(', ')}.`
}

// Pure logic behind the mesh edit panel: maps the mesh-ops registry
// (GET /optimize/ops) to UI controls and groups, and reads op results.
// Kept free of React so it can be unit-tested with node --test.

/** One entry of an op's params_schema, as served by the backend registry. */
export interface MeshOpParamSchema {
  id: string
  label?: string
  type?: string
  default?: unknown
  min?: number
  max?: number
  step?: number
  options?: { value: string | number; label: string }[]
  tooltip?: string
}

/** MeshOp.describe() on the backend. */
export interface MeshOpDescriptor {
  id: string
  label: string
  params_schema: MeshOpParamSchema[]
  destructive: boolean
  undoable: boolean
  category: string
}

/** POST /optimize/op/{id}: `url` when a mesh was written, otherwise the op's report. */
export type MeshOpResponse = Record<string, unknown>

interface ControlBase {
  id: string
  label: string
  tooltip?: string
}

export type ParamControl =
  | (ControlBase & {
      kind: 'slider'
      min: number
      max: number
      step: number
      integer: boolean
      /** 'log' for ranges spanning several orders of magnitude (face counts, sizes). */
      scale: 'linear' | 'log'
      defaultValue: number
    })
  | (ControlBase & {
      kind: 'number'
      min?: number
      max?: number
      step: number
      integer: boolean
      defaultValue: number
    })
  | (ControlBase & { kind: 'toggle'; defaultValue: boolean })
  | (ControlBase & {
      kind: 'select'
      options: { value: string | number; label: string }[]
      defaultValue: string | number
    })
  | (ControlBase & { kind: 'text'; defaultValue: string })

/** A slider is switched to a log scale above this max/min ratio. */
const LOG_SCALE_RATIO = 1000
/** Resolution of a log slider's underlying <input type="range">. */
export const LOG_SLIDER_STEPS = 1000

export function humanize(id: string): string {
  const words = id.replace(/[_-]+/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : id
}

export function paramControl(schema: MeshOpParamSchema): ParamControl {
  const base: ControlBase = {
    id: schema.id,
    label: schema.label || humanize(schema.id),
    tooltip: schema.tooltip,
  }
  const type = schema.type ?? (typeof schema.default === 'boolean' ? 'boolean' : 'float')

  if (type === 'boolean' || type === 'bool') {
    return { ...base, kind: 'toggle', defaultValue: schema.default === true }
  }

  if (type === 'select') {
    const options = schema.options ?? []
    const fallback = options[0]?.value ?? ''
    const defaultValue = (schema.default as string | number | undefined) ?? fallback
    return { ...base, kind: 'select', options, defaultValue }
  }

  if (type === 'int' || type === 'float' || type === 'number') {
    const integer = type === 'int'
    const step = schema.step ?? (integer ? 1 : 0.01)
    const { min, max } = schema
    const numericDefault =
      typeof schema.default === 'number' ? schema.default : (min ?? 0)
    if (min !== undefined && max !== undefined && max > min) {
      const scale = min > 0 && max / min >= LOG_SCALE_RATIO ? 'log' : 'linear'
      return { ...base, kind: 'slider', min, max, step, integer, scale, defaultValue: numericDefault }
    }
    return { ...base, kind: 'number', min, max, step, integer, defaultValue: numericDefault }
  }

  return { ...base, kind: 'text', defaultValue: schema.default == null ? '' : String(schema.default) }
}

export function defaultParamValues(schemas: MeshOpParamSchema[]): Record<string, unknown> {
  return Object.fromEntries(schemas.map((schema) => [schema.id, paramControl(schema).defaultValue]))
}

// ─── Slider scale ────────────────────────────────────────────────────────────

type SliderControl = Extract<ParamControl, { kind: 'slider' }>

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Value → position of the <input type="range">. */
export function toSliderPosition(control: SliderControl, value: number): number {
  if (control.scale === 'linear') return clamp(value, control.min, control.max)
  const v = clamp(value, control.min, control.max)
  const ratio = Math.log(v / control.min) / Math.log(control.max / control.min)
  return Math.round(ratio * LOG_SLIDER_STEPS)
}

/** Position of the <input type="range"> → value, rounded to something typeable. */
export function fromSliderPosition(control: SliderControl, position: number): number {
  if (control.scale === 'linear') return clamp(position, control.min, control.max)
  if (position <= 0) return control.min
  if (position >= LOG_SLIDER_STEPS) return control.max
  const raw = control.min * Math.pow(control.max / control.min, position / LOG_SLIDER_STEPS)
  // Three significant figures: 12,345 → 12,300, 0.004567 → 0.00457.
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)) - 2)
  const rounded = Math.round(raw / magnitude) * magnitude
  const value = control.integer ? Math.round(rounded) : Number(rounded.toPrecision(3))
  return clamp(value, control.min, control.max)
}

/** Clamp a typed number to the control's bounds (integers rounded). */
export function coerceNumber(control: Extract<ParamControl, { kind: 'slider' | 'number' }>, value: number): number {
  let v = control.integer ? Math.round(value) : value
  if (control.min !== undefined) v = Math.max(control.min, v)
  if (control.max !== undefined) v = Math.min(control.max, v)
  return v
}

// ─── Grouping ────────────────────────────────────────────────────────────────

/** Known categories, in display order. Anything else follows, alphabetically. */
const CATEGORY_ORDER = ['repair', 'transform', 'topology', 'optimization', 'presets', 'analysis']

const CATEGORY_LABELS: Record<string, string> = {
  repair: 'Repair',
  transform: 'Transform',
  topology: 'Topology',
  optimization: 'Optimize',
  presets: 'Presets',
  analysis: 'Analysis',
}

/** Op shown in the dedicated report panel rather than in a group. */
export const INSPECT_OP_ID = 'inspect_mesh'

export interface MeshOpGroup {
  category: string
  label: string
  ops: MeshOpDescriptor[]
}

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? (category ? humanize(category) : 'Other')
}

export function groupMeshOps(ops: MeshOpDescriptor[]): MeshOpGroup[] {
  const byCategory = new Map<string, MeshOpDescriptor[]>()
  for (const op of ops) {
    if (op.id === INSPECT_OP_ID) continue
    const category = op.category || ''
    const list = byCategory.get(category) ?? []
    list.push(op)
    byCategory.set(category, list)
  }

  const rank = (category: string): number => {
    const index = CATEGORY_ORDER.indexOf(category)
    return index === -1 ? CATEGORY_ORDER.length : index
  }

  return [...byCategory.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([category, list]) => ({ category, label: categoryLabel(category), ops: list }))
}

// ─── Results ─────────────────────────────────────────────────────────────────

/** Destructive or non-undoable ops are confirmed in the panel before running. */
export function requiresConfirmation(op: MeshOpDescriptor): boolean {
  return op.destructive || !op.undoable
}

/** True when the op wrote a mesh that should replace the one in the viewer. */
export function isMeshUpdate(response: MeshOpResponse): response is MeshOpResponse & { url: string } {
  return typeof response.url === 'string' && response.url.length > 0
}

export type BadgeState = 'ok' | 'bad' | 'unknown'

export interface InspectionBadge {
  label: string
  state: BadgeState
}

function flag(value: unknown, invert = false): BadgeState {
  if (typeof value !== 'boolean') return 'unknown'
  return value !== invert ? 'ok' : 'bad'
}

/** ✓/✗ badges of an inspect_mesh report. */
export function inspectionBadges(report: Record<string, unknown>): InspectionBadge[] {
  return [
    { label: 'Printable', state: flag(report.printable) },
    { label: 'Watertight', state: flag(report.is_watertight) },
    { label: 'Manifold', state: flag(report.is_manifold) },
    { label: 'Consistent winding', state: flag(report.is_winding_consistent) },
    { label: 'Normals outward', state: flag(report.is_inside_out, true) },
  ]
}

const HIDDEN_DETAIL_KEYS = new Set(['url', 'path'])

function formatScalar(value: unknown): string | null {
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value.toLocaleString('en-US') : value.toPrecision(4).replace(/\.?0+$/, '')
  }
  if (typeof value === 'string') return value
  return null
}

/** Label/value rows for the scalar (and scalar-list) fields of an op result. */
export function summarizeDetails(details: Record<string, unknown>): [string, string][] {
  const rows: [string, string][] = []
  for (const [key, value] of Object.entries(details)) {
    if (HIDDEN_DETAIL_KEYS.has(key) || value == null) continue
    if (Array.isArray(value)) {
      const parts = value.map(formatScalar)
      if (parts.length && parts.every((p) => p !== null)) rows.push([humanize(key), parts.join(', ')])
      continue
    }
    const text = formatScalar(value)
    if (text !== null) rows.push([humanize(key), text])
  }
  return rows
}

// ─── Misc ────────────────────────────────────────────────────────────────────

/** Viewer mesh URL → the `path` the optimize routes expect. */
export function meshPathFromUrl(url: string): string {
  if (url.startsWith('/workspace/')) return url.slice('/workspace/'.length)
  if (url.startsWith('/optimize/serve-file?path=')) {
    return decodeURIComponent(url.split('path=')[1] ?? '')
  }
  return url
}

/** Readable message of a failed API call: FastAPI's `detail` when present. */
export function apiErrorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const detail = (err as { response?: { data?: { detail?: unknown } } }).response?.data?.detail
    if (typeof detail === 'string' && detail) return detail
    const message = (err as { message?: unknown }).message
    if (typeof message === 'string' && message) return message
  }
  return String(err)
}

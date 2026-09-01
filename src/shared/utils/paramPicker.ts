import type { ParamSchema, PickerIntent } from '@shared/types/electron.d'

// Which native dialog the browse button next to a `string` param opens.
// Extension manifests request one with `pickerIntent` (or `picker_intent`) on
// the param; params that don't set it keep the historical folder picker.

export const PICKER_INTENTS = ['folder', 'image', 'mesh', 'text'] as const

/** Accessible name / tooltip for the browse button, per intent. */
export const PICKER_LABELS: Record<PickerIntent, string> = {
  folder: 'Browse for a folder…',
  image:  'Browse for an image file…',
  mesh:   'Browse for a 3D mesh file…',
  text:   'Browse for a text file…',
}

/** Just the members of `window.electron.fs` a param picker can reach for. */
export interface ParamPickerApi {
  selectDirectory: (defaultPath?: string) => Promise<string | null>
  selectImage:     () => Promise<string | null>
  selectMeshFile:  () => Promise<string | null>
  selectTextFile:  () => Promise<string | null>
}

type PickerParam = Pick<ParamSchema, 'pickerIntent' | 'picker_intent'>

/**
 * Intent a param asks for, falling back to 'folder' — the behavior every
 * `string` param had before `pickerIntent` existed — when it is unset or is a
 * value this build doesn't know about.
 */
export function resolvePickerIntent(param: PickerParam | undefined): PickerIntent {
  const requested = param?.pickerIntent ?? param?.picker_intent
  return PICKER_INTENTS.includes(requested as PickerIntent) ? (requested as PickerIntent) : 'folder'
}

/** Opens the dialog the param asked for. Resolves to null when cancelled. */
export function openParamPicker(param: PickerParam | undefined, fs: ParamPickerApi): Promise<string | null> {
  switch (resolvePickerIntent(param)) {
    case 'image': return fs.selectImage()
    case 'mesh':  return fs.selectMeshFile()
    case 'text':  return fs.selectTextFile()
    default:      return fs.selectDirectory()
  }
}

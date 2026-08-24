import type { ModelExtension, ProcessExtension } from '@shared/stores/extensionsStore'
export type { ParamSchema } from '@shared/types/electron.d'
import type { ExtensionNode, ParamSchema } from '@shared/types/electron.d'

export interface WorkflowExtension {
  id:              string   // "ext_id/node_id"
  extensionId:     string   // "ext_id" (for IPC calls)
  extensionName:   string   // display name of the parent extension
  extensionAuthor: string   // author of the parent extension
  nodeId:          string   // "node_id"
  name:            string
  description:     string
  input:           'image' | 'text' | 'mesh' | 'audio'
  inputs?:         ('image' | 'text' | 'mesh' | 'audio')[]   // multi-input; overrides input when set
  inputLabels?:    string[]                                  // display labels per input slot
  output:          'image' | 'text' | 'mesh' | 'audio'
  terminal?:       boolean   // sink node: no output handle (e.g. an exporter)
  /** Declared VRAM cost in GB, when the manifest states one. */
  vramGb?:         number
  params:          ParamSchema[]
  builtin:         boolean
  type:            'model' | 'process'
}

function applyParamDefaults(
  schema:   ParamSchema[],
  defaults: Record<string, number | string> | undefined,
): ParamSchema[] {
  if (!defaults || Object.keys(defaults).length === 0) return schema
  return schema.map((p) =>
    Object.prototype.hasOwnProperty.call(defaults, p.id)
      ? { ...p, default: defaults[p.id]! }
      : p,
  )
}

/** One node of one extension, as the canvas sees it. Model and process
 *  extensions differ only by that `type` — everything else is read the same way,
 *  so it is read in one place. */
function toWorkflowExtension(
  ext:  ModelExtension | ProcessExtension,
  node: ExtensionNode,
  type: 'model' | 'process',
): WorkflowExtension {
  return {
    id:              `${ext.id}/${node.id}`,
    extensionId:     ext.id,
    extensionName:   ext.name,
    extensionAuthor: ext.author ?? '',
    nodeId:          node.id,
    name:            node.name,
    // The author's own sentence, per node then per extension. Measured
    // 2026-08-20: composing it from declared facts instead cost 84% → 73% on
    // the disambiguation evals, because the opening verb — Reduces, Repairs,
    // Smooths — is the signal, and a generated line flattens them all to one.
    description:     node.description ?? ext.description ?? '',
    input:           node.input,
    inputs:          node.inputs,
    inputLabels:     node.inputLabels,
    output:          node.output,
    terminal:        node.terminal,
    vramGb:          node.vramGb,
    params:          applyParamDefaults(node.paramsSchema as ParamSchema[], node.paramDefaults),
    builtin:         ext.builtin,
    type,
  }
}

export function buildAllWorkflowExtensions(
  modelExtensions:   ModelExtension[],
  processExtensions: ProcessExtension[],
): WorkflowExtension[] {
  // A corrupted folder (manifest gone, unparseable, or an install that never
  // finished) still appears in the store so the Extensions page can offer to
  // repair it, but its `nodes` are not to be trusted — it must not put a node
  // on the canvas.
  const usable = <T extends { corrupted?: boolean }>(list: T[]): T[] =>
    list.filter((ext) => !ext.corrupted)

  return [
    ...usable(processExtensions).flatMap((ext) => ext.nodes.map((n) => toWorkflowExtension(ext, n, 'process'))),
    ...usable(modelExtensions).flatMap((ext) => ext.nodes.map((n) => toWorkflowExtension(ext, n, 'model'))),
  ]
}

export function getWorkflowExtension(id: string, all: WorkflowExtension[]): WorkflowExtension | undefined {
  return all.find((e) => e.id === id)
}

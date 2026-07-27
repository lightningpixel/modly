import type { ModelExtension, ProcessExtension } from '@shared/stores/extensionsStore'
export type { ParamSchema } from '@shared/types/electron.d'
import type { ParamSchema } from '@shared/types/electron.d'

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

// Extension manifests are untyped JSON at runtime. `inputs` is documented as
// an array of plain type strings, but some manifests declare it as an array
// of objects instead (e.g. `{ name, label, type, required }` slots). A string
// never equals such an object, so the workflow preflight check silently
// treats every declared input as missing. Normalize once here, at the
// manifest boundary, so everything downstream can trust the documented type.
function normalizeInputs(
  raw: WorkflowExtension['inputs'],
): WorkflowExtension['inputs'] {
  if (!raw) return raw
  return raw.map((entry) =>
    typeof entry === 'string' ? entry : (entry as unknown as { type: WorkflowExtension['input'] }).type,
  )
}

export function buildAllWorkflowExtensions(
  modelExtensions:   ModelExtension[],
  processExtensions: ProcessExtension[],
): WorkflowExtension[] {
  const result: WorkflowExtension[] = []

  for (const ext of processExtensions) {
    for (const node of ext.nodes) {
      result.push({
        id:              `${ext.id}/${node.id}`,
        extensionId:     ext.id,
        extensionName:   ext.name,
        extensionAuthor: ext.author ?? '',
        nodeId:          node.id,
        name:            node.name,
        description:     ext.description ?? '',
        input:           node.input,
        inputs:          normalizeInputs(node.inputs),
        inputLabels:     node.inputLabels,
        output:          node.output,
        params:          applyParamDefaults(node.paramsSchema as ParamSchema[], node.paramDefaults),
        builtin:         ext.builtin,
        type:            'process',
      })
    }
  }

  for (const ext of modelExtensions) {
    for (const node of ext.nodes) {
      result.push({
        id:              `${ext.id}/${node.id}`,
        extensionId:     ext.id,
        extensionName:   ext.name,
        extensionAuthor: ext.author ?? '',
        nodeId:          node.id,
        name:            node.name,
        description:     ext.description ?? '',
        input:           node.input,
        inputs:          normalizeInputs(node.inputs),
        inputLabels:     node.inputLabels,
        output:          node.output,
        params:          applyParamDefaults(node.paramsSchema as ParamSchema[], node.paramDefaults),
        builtin:         ext.builtin,
        type:            'model',
      })
    }
  }

  return result
}

export function getWorkflowExtension(id: string, all: WorkflowExtension[]): WorkflowExtension | undefined {
  return all.find((e) => e.id === id)
}

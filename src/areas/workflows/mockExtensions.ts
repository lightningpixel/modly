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
  terminal?:       boolean   // sink node: no output handle (e.g. an exporter)
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
        description:     node.description ?? ext.description ?? '',
        input:           node.input,
        inputs:          node.inputs,
        inputLabels:     node.inputLabels,
        output:          node.output,
        terminal:        node.terminal,
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
        description:     node.description ?? ext.description ?? '',
        input:           node.input,
        inputs:          node.inputs,
        inputLabels:     node.inputLabels,
        output:          node.output,
        terminal:        node.terminal,
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

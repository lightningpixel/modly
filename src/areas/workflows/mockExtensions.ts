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
  input:           'image' | 'text' | 'mesh'
  inputs?:         ('image' | 'text' | 'mesh')[]   // multi-input; overrides input when set
  output:          'image' | 'text' | 'mesh'
  params:          ParamSchema[]
  builtin:         boolean
  type:            'model' | 'process'
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
        inputs:          node.inputs,
        output:          node.output,
        params:          node.paramsSchema as ParamSchema[],
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
        inputs:          node.inputs,
        output:          node.output,
        params:          node.paramsSchema as ParamSchema[],
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

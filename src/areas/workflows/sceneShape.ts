import type { WorkflowExtension } from './mockExtensions'

/**
 * Scene is model-only and must be the node's single `input` (never inside
 * `inputs`). Mirrors assertSupportedSceneNodeShape on the install side.
 */
export function hasUnsupportedSceneShape(ext: Pick<WorkflowExtension, 'type' | 'input' | 'inputs' | 'output'>): boolean {
  const usesSceneInput = ext.input === 'scene' || ext.inputs?.includes('scene') === true
  if (ext.type === 'process') return usesSceneInput || ext.output === 'scene'
  return usesSceneInput && (ext.inputs !== undefined || ext.input !== 'scene')
}

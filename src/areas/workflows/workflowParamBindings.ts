import type { Workflow } from '../../shared/types/electron.d'

type ReadNodeParams = (nodeId: string) => Record<string, unknown> | undefined

/**
 * Applies declarative cross-node parameter bindings without mutating either
 * node. The target reads the source's freshest live value when it starts, so
 * paused and looping workflows keep the same single source of truth.
 */
export function resolveBoundWorkflowParams(
  workflow: Workflow,
  targetNodeId: string,
  targetParams: Record<string, unknown>,
  readNodeParams: ReadNodeParams,
): Record<string, unknown> {
  const bindings = workflow.paramBindings?.filter((binding) => binding.targetNodeId === targetNodeId) ?? []
  if (bindings.length === 0) return targetParams

  const resolved = { ...targetParams }
  for (const binding of bindings) {
    const sourceParams = readNodeParams(binding.sourceNodeId)
    if (sourceParams && Object.prototype.hasOwnProperty.call(sourceParams, binding.sourceParam)) {
      resolved[binding.targetParam] = sourceParams[binding.sourceParam]
    }
  }
  return resolved
}

/** A fully bound node has no independent questions to show in Generate. */
export function areAllWorkflowNodeParamsBound(
  workflow: Workflow,
  nodeId: string,
  paramIds: string[],
): boolean {
  if (paramIds.length === 0) return false
  const boundParams = new Set(
    (workflow.paramBindings ?? [])
      .filter((binding) => binding.targetNodeId === nodeId)
      .map((binding) => binding.targetParam),
  )
  return paramIds.every((paramId) => boundParams.has(paramId))
}

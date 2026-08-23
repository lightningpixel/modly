import type { WFNode, WFEdge } from '@shared/types/electron.d'

// ─── Node behaviors registry ──────────────────────────────────────────────────
//
// Add a new entry here when you introduce a node type that needs to participate
// in the runner's control-flow logic. The predicates and helpers below derive
// everything they need from this table — no hardcoded type checks anywhere else.
//
// • passthrough   — data flows through this node unchanged. Resolvers (inputs,
//                   preflight typing) walk past it to find the real source.
// • branchStarter — splits the run into a user-driven sub-DAG. The runner
//                   pauses on these nodes and exposes a Continue/Retry button.
// • sceneOutput   — terminal sink that gets pushed to the 3D viewer. Used by
//                   the immediate mesh-push logic during execution.
// • branchConsumer — executes inside a Wait branch and consumes its single mesh
//                   output, so it can't be fed by more than one Wait branch.

export interface NodeBehavior {
  passthrough?:    boolean
  branchStarter?:  boolean
  sceneOutput?:    boolean
  branchConsumer?: boolean
}

const BEHAVIORS: Record<string, NodeBehavior> = {
  waitNode:      { passthrough: true, branchStarter: true },
  outputNode:    { sceneOutput: true, branchConsumer: true },
  extensionNode: { branchConsumer: true },
}

export const isPassthrough    = (type: string | undefined): boolean => !!type && !!BEHAVIORS[type]?.passthrough
export const isBranchStarter  = (type: string | undefined): boolean => !!type && !!BEHAVIORS[type]?.branchStarter
export const isSceneOutput    = (type: string | undefined): boolean => !!type && !!BEHAVIORS[type]?.sceneOutput
export const isBranchConsumer = (type: string | undefined): boolean => !!type && !!BEHAVIORS[type]?.branchConsumer

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Walks `sourceId` backwards through passthrough nodes (following each one's
 * incoming edge) until it hits a non-passthrough node. Returns its id, or
 * undefined if a passthrough has no incoming edge.
 */
export function resolveDataSource(
  sourceId: string,
  edges:    WFEdge[],
  nodeMap:  Map<string, WFNode>,
): string | undefined {
  let cur = sourceId
  const seen = new Set<string>()
  while (isPassthrough(nodeMap.get(cur)?.type) && !seen.has(cur)) {
    seen.add(cur)
    const parent = edges.find((e) => e.target === cur)
    if (!parent) return undefined
    cur = parent.source
  }
  return cur
}

/**
 * Walks backwards from `nodeId` and returns the set of nearest upstream
 * branch-starter (Wait) nodes — the first Wait found on each incoming path,
 * without traversing past it. Empty = no upstream Wait. Size > 1 = the node
 * merges two distinct branches.
 */
export function nearestUpstreamWaits(
  nodeId:  string,
  edges:   WFEdge[],
  nodeMap: Map<string, WFNode>,
): Set<string> {
  const result = new Set<string>()
  const seen   = new Set<string>()
  const stack  = edges.filter((e) => e.target === nodeId).map((e) => e.source)
  while (stack.length > 0) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    if (isBranchStarter(nodeMap.get(id)?.type)) { result.add(id); continue }
    for (const e of edges) if (e.target === id) stack.push(e.source)
  }
  return result
}

/**
 * True if any forward path from `sourceId` reaches a sceneOutput node, walking
 * through passthrough nodes — but stopping at branch-starter (Wait) boundaries.
 * A scene output gated behind a Wait belongs to a branch that runs later, so it
 * must not be treated as immediately reachable (otherwise pre-phase nodes would
 * push their mesh to the viewer before the user clicks Continue).
 */
export function reachesSceneOutput(
  sourceId: string,
  edges:    WFEdge[],
  nodeMap:  Map<string, WFNode>,
): boolean {
  const stack = [sourceId]
  const seen  = new Set<string>()
  while (stack.length > 0) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    for (const e of edges) {
      if (e.source !== id) continue
      const tType = nodeMap.get(e.target)?.type
      if (isSceneOutput(tType))                          return true
      if (isPassthrough(tType) && !isBranchStarter(tType)) stack.push(e.target)
    }
  }
  return false
}

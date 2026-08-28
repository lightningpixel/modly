import type { Workflow, WFNode, WFEdge } from '@shared/types/electron.d'
import { getWorkflowExtension, type WorkflowExtension } from './mockExtensions'
import { isPassthrough, resolveDataSource, edgeSlot } from './nodeBehaviors'
import { getNodeOutputType, nodeLabel, type DataType } from './preflight'

export interface AutoWireResult {
  workflow: Workflow
  /** Human-readable descriptions of each connection added, e.g. "Image → Texture Mesh (image)". */
  added: string[]
}

const SOURCE_NODE_FOR_TYPE: Record<string, { type: string; data: WFNode['data'] }> = {
  image: { type: 'imageNode', data: { enabled: true, params: {}, showInGenerate: true } },
  text:  { type: 'textNode',  data: { enabled: true, params: {} } },
  mesh:  { type: 'meshNode',  data: { enabled: true, params: { source: 'current' } } },
}

function downstreamIds(startId: string, edges: WFEdge[]): Set<string> {
  const seen = new Set<string>([startId])
  const queue = [startId]
  while (queue.length) {
    const id = queue.shift()!
    for (const e of edges) {
      if (e.source === id && !seen.has(e.target)) { seen.add(e.target); queue.push(e.target) }
    }
  }
  return seen
}

/** Hop distance from `targetId` to every node reachable by walking edges
 *  backwards (source-of-source-of…). Used to prefer the closest upstream
 *  producer over an arbitrary one when several candidates match. */
function upstreamDistances(targetId: string, edges: WFEdge[]): Map<string, number> {
  const dist = new Map<string, number>([[targetId, 0]])
  const queue = [targetId]
  while (queue.length) {
    const id = queue.shift()!
    const d = dist.get(id)!
    for (const e of edges) {
      if (e.target === id && !dist.has(e.source)) { dist.set(e.source, d + 1); queue.push(e.source) }
    }
  }
  return dist
}

/**
 * Connect every extension node's missing required inputs by data type — the
 * automated equivalent of dragging the missing edges in the workflow editor.
 *
 * For each missing input type, the source is (in order of preference) the
 * workflow's dedicated input node of that type, any other node producing that
 * type that would not create a cycle, or a brand-new input node. Existing
 * nodes and params are never modified; the one edge removal allowed is
 * replacing a mis-typed edge on a slot we can wire correctly (see below).
 */
export function autoWireWorkflow(workflow: Workflow, allExtensions: WorkflowExtension[]): AutoWireResult {
  const nodes = [...workflow.nodes]
  const edges = [...workflow.edges]
  const added: string[] = []

  const nodeMap = new Map(nodes.map((n) => [n.id, n]))
  // How many source nodes we've created so far for a given consumer, so a
  // node missing several input types doesn't stack its new nodes on top of
  // each other (all at the same `x - 280, y`).
  const createdCountForNode = new Map<string, number>()
  const outputTypes = new Map<string, DataType | undefined>()
  for (const node of nodes) outputTypes.set(node.id, getNodeOutputType(node, allExtensions))
  for (const node of nodes) {
    if (!isPassthrough(node.type)) continue
    const realSourceId = resolveDataSource(node.id, edges, nodeMap)
    if (realSourceId && realSourceId !== node.id) outputTypes.set(node.id, outputTypes.get(realSourceId))
  }

  for (const node of workflow.nodes) {
    if (node.type !== 'extensionNode') continue
    const ext = getWorkflowExtension(node.data.extensionId ?? '', allExtensions)
    if (!ext) continue

    const inputs = (ext.inputs ?? [ext.input]) as DataType[]
    const incoming = () => edges.filter((e) => e.target === node.id)

    // Per SLOT, not per distinct type — the same rule preflight applies. A node
    // declaring ['text','text'] (positive + negative prompt) used to count as
    // wired after one text edge, so auto-wiring could never satisfy preflight
    // and an agent-driven run stayed blocked with nothing left to fix.
    inputs.forEach((requiredType, slot) => {
      const onSlot = () => incoming().filter((e) => edgeSlot(e.targetHandle) === slot)
      const filled = onSlot().some((e) => outputTypes.get(e.source) === requiredType)
      if (filled) return

      // The slot is taken, just by the wrong type — an Image wired straight into
      // a mesh step. That is a missing conversion, not a missing connection:
      // creating a source node here used to bolt a "Load 3D Mesh (current)" onto
      // a graph that already had an image, adding a second error while leaving
      // the first edge in place, and the run stayed blocked forever. Replace the
      // edge when a correctly-typed producer already exists, otherwise leave the
      // graph alone and let preflight report the type error.
      const misTyped = onSlot()
      const replacing = misTyped.length > 0

      // Never wire from the node itself or anything downstream of it (cycle)
      const forbidden = downstreamIds(node.id, edges)
      // Prefer the workflow's dedicated input nodes (Image / Text / Load 3D Mesh)
      // over any other producer; within the same tier, prefer whichever is
      // fewest hops upstream. Ties keep the original array order (stable sort).
      const dedicatedType = SOURCE_NODE_FOR_TYPE[requiredType]?.type
      const distances = upstreamDistances(node.id, edges)
      const pick = (excluded: Set<string>) => nodes
        .filter((n) => !forbidden.has(n.id) && !excluded.has(n.id) && outputTypes.get(n.id) === requiredType)
        .map((n) => ({
          n,
          dedicated: n.type === dedicatedType ? 0 : 1,
          distance: distances.get(n.id) ?? Number.POSITIVE_INFINITY,
        }))
        .sort((a, b) => a.dedicated - b.dedicated || a.distance - b.distance)[0]?.n

      // A producer already feeding another slot of this same node is a poor
      // match for this one: two prompt slots want two prompts, not the same
      // text twice. Falling back to it beats leaving the slot empty, though.
      const spec = SOURCE_NODE_FOR_TYPE[requiredType]
      const usedSources = new Set(incoming().map((e) => e.source))
      let source = pick(usedSources)
      // Nothing fresh, and no source node we know how to create (audio & co):
      // reusing one that already feeds another slot beats leaving it unwired.
      if (!source && !spec) source = pick(new Set())

      if (!source) {
        if (replacing) return // nothing of the right type exists: a type error, not a wiring one
        if (!spec) return // audio & co: no source node to create
        const createdIndex = createdCountForNode.get(node.id) ?? 0
        createdCountForNode.set(node.id, createdIndex + 1)
        source = {
          id: crypto.randomUUID().slice(0, 8),
          type: spec.type,
          position: { x: node.position.x - 280, y: node.position.y + createdIndex * 90 },
          data: { ...spec.data, params: { ...spec.data.params } },
        } as WFNode
        nodes.push(source)
        nodeMap.set(source.id, source)
        outputTypes.set(source.id, requiredType)
      }

      for (const bad of misTyped) {
        const at = edges.indexOf(bad)
        if (at >= 0) edges.splice(at, 1)
      }

      edges.push({
        id: crypto.randomUUID().slice(0, 8),
        type: 'workflowEdge',  // same edge type the editor and the agent's builder create
        source: source.id,
        target: node.id,
        ...(source.type === 'extensionNode' ? { sourceHandle: 'output' } : {}),
        targetHandle: `input-${slot}`,
      })
      const replacedLabels = misTyped
        .map((e) => nodeMap.get(e.source))
        .filter((n): n is WFNode => !!n)
        .map((n) => nodeLabel(n, allExtensions))
      const replaced = replacedLabels.length > 0 ? `, replacing ${replacedLabels.join(' & ')}` : ''
      added.push(`${nodeLabel(source, allExtensions)} → ${nodeLabel(node, allExtensions)} (${requiredType}${replaced})`)
    })
  }

  return { workflow: { ...workflow, nodes, edges }, added }
}

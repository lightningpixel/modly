/**
 * Turning a node's incoming edges into the inputs its extension is called with.
 *
 * This lived inline in `workflowRunStore.executeExtensionNode`, tangled with
 * axios, the Electron bridge and zustand, so the one part of the runner with
 * real branching had no tests at all. It is pure here: edges and a lookup in,
 * resolved inputs out.
 */
import { edgeSlot } from './nodeBehaviors'

/** What an upstream node produced — the shape `nodeOutputs` stores. */
export interface ResolvedSource {
  filePath?: string
  text?:     string
}

/** One incoming edge, narrowed to what slot resolution actually reads. */
export interface IncomingEdge {
  source:        string
  targetHandle?: string | null
}

export interface NodeInputs {
  /** The image (or, on a single-input node, whatever file) driving the run. */
  filePath?: string
  /** Whichever text edge came last — kept for single-input nodes. */
  text?:     string
  /**
   * The mesh driving the run: the LOWEST connected mesh slot, not the last one.
   * A node declaring ['mesh','mesh'] used to overwrite this at every mesh slot,
   * so slot 0 was silently dropped.
   */
  meshPath?: string
  /** Per-slot texts: input-0 → texts[0]. Positive/negative prompts rely on this. */
  texts:     (string | undefined)[]
  /** Every image past the first resolved one. */
  extraImages: string[]
  /**
   * Every resolved mesh slot, in slot order, primary included — the `files`
   * an extension taking several meshes reads. Without it a second mesh node
   * wired in the editor reached nothing: modly-combine 1.1.0 documents this
   * contract and errors with "No secondary meshes provided" when the host
   * does not honour it.
   */
  meshFiles: string[]
}

/**
 * `inputTypes` is the extension's declared `inputs`. Multi-input nodes (two or
 * more declared slots) resolve by target handle; everything else keeps the
 * older last-edge-wins behaviour, which is all a one-slot node can mean.
 */
export function resolveNodeInputs(
  inputTypes:    readonly string[] | undefined,
  incomingEdges: readonly IncomingEdge[],
  resolveSource: (sourceId: string) => ResolvedSource | undefined,
): NodeInputs {
  const texts:       (string | undefined)[] = []
  const extraImages: string[] = []
  const meshFiles:   string[] = []
  let filePath: string | undefined
  let text:     string | undefined
  let meshPath: string | undefined

  if (!inputTypes || inputTypes.length <= 1) {
    for (const edge of incomingEdges) {
      const src = resolveSource(edge.source)
      if (src?.filePath !== undefined) filePath = src.filePath
      if (src?.text !== undefined && src.text.trim().length > 0) text = src.text
    }
    return { filePath, text, meshPath, texts, extraImages, meshFiles }
  }

  // Resolved by target handle first, then typed by that slot's declared input --
  // not by the arrival order of `incomingEdges`, which does not match slot order.
  const paths = new Array<string | undefined>(inputTypes.length).fill(undefined)

  for (const edge of incomingEdges) {
    const src = resolveSource(edge.source)
    if (!src) continue
    // One shared rule for both paths and texts. The runner used to carry its own
    // copy that accepted `input-N` only: an untagged edge — how the agent's
    // builder wires its chain — left texts[0] empty, so on a ['text','text']
    // node the negative prompt auto-wired onto input-1 became the one driving
    // the generator. A handle reading `input-<not a number>` addresses no slot
    // at all and is dropped rather than falling back to slot 0.
    const slot = edgeSlot(edge.targetHandle)
    if (slot === undefined) continue
    if (src.filePath !== undefined && slot < inputTypes.length) paths[slot] = src.filePath
    if (src.text !== undefined && src.text.trim().length > 0) {
      text = src.text
      texts[slot] = src.text
    }
  }

  // The lowest mesh slot drives filePath and every mesh slot is kept in order;
  // the first image drives the image input and any further one rides along in
  // extra_image_paths.
  for (let i = 0; i < inputTypes.length; i++) {
    const fp = paths[i]
    if (!fp) continue
    if (inputTypes[i] === 'mesh') {
      meshFiles.push(fp)
      if (!meshPath) meshPath = fp
    } else if (inputTypes[i] === 'image') {
      if (!filePath) filePath = fp
      else extraImages.push(fp)
    }
  }

  return { filePath, text, meshPath, texts, extraImages, meshFiles }
}

/**
 * The `extra_image_paths` overlay a process extension is called with.
 *
 * A node taking a mesh *and* images sends the mesh as its filePath, so every
 * image — including the first — has to travel in the overlay or the extension
 * never sees it.
 */
export function extraImageParams(inputs: NodeInputs): Record<string, unknown> {
  if (inputs.meshPath && inputs.filePath) {
    return { extra_image_paths: [inputs.filePath, ...inputs.extraImages] }
  }
  if (inputs.extraImages.length > 0) {
    return { extra_image_paths: inputs.extraImages }
  }
  return {}
}

/**
 * The text a model node generates from. On a multi-text node the slots carry
 * meaning — input-0 is the positive prompt, input-1 the negative one — while
 * `text` is just whichever text edge came last in `workflow.edges`.
 */
export function mainText(inputs: NodeInputs): string | undefined {
  return inputs.texts[0] ?? inputs.text
}

/**
 * The connection a process extension is missing, or undefined when it has what
 * it declared. Named for the message the runner throws.
 *
 * A declared `mesh` slot resolves into `meshPath`, not `filePath`, so checking
 * `filePath` alone refused a multi-input node for want of the very connection
 * it had.
 */
export function missingInput(
  declared: string | undefined,
  inputs:   NodeInputs,
): 'mesh' | 'image' | 'audio' | 'text' | undefined {
  if (declared === 'mesh')  return inputs.meshPath || inputs.filePath ? undefined : 'mesh'
  if (declared === 'image') return inputs.filePath ? undefined : 'image'
  if (declared === 'audio') return inputs.filePath ? undefined : 'audio'
  if (declared === 'text')  return inputs.text     ? undefined : 'text'
  return undefined
}

/**
 * The input type an edge landing on `targetHandle` is checked against — the
 * declared slot's type, not the extension's legacy single `input`.
 *
 * The editor's connection validation and the edge gradient each parsed the
 * handle themselves, with `parseInt`, which is laxer than the runner: it read
 * `input-1x` as slot 1 where the runner drops it, and it fell back to `input`
 * for an untagged edge that the runner places on slot 0. Two more copies of the
 * rule edgeSlot exists to hold.
 */
export function slotInputType(
  ext:          { input?: string; inputs?: readonly string[] } | undefined,
  targetHandle: string | null | undefined,
): string | undefined {
  if (!ext?.inputs || ext.inputs.length <= 1) return ext?.input
  const slot = edgeSlot(targetHandle)
  return (slot === undefined ? undefined : ext.inputs[slot]) ?? ext.input
}

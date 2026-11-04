// Multi-input slot → file-path assignment for extension nodes.
//
// `inputTypes` is the node's declared `inputs` (one per handle); `inputPaths` is
// the file path resolved for each slot, indexed the same way (undefined where the
// slot carries text or nothing). Pure so it can be tested without the store.

export type SlotInputType = 'image' | 'text' | 'mesh' | 'audio' | 'video'

export interface SlotFilePaths {
  /** Primary file: what the extension receives as `filePath` when no mesh is present. */
  nodeInputPath?:     string
  /** Mesh slot, if any. Takes precedence as `filePath`; the primary file then rides in params. */
  nodeInputMeshPath?: string
  /** Every image beyond the first resolved image slot. */
  extraImagePaths:    string[]
}

export function assignSlotFilePaths(
  inputTypes: readonly SlotInputType[],
  inputPaths: readonly (string | undefined)[],
): SlotFilePaths {
  const out: SlotFilePaths = { extraImagePaths: [] }
  for (let i = 0; i < inputTypes.length; i++) {
    const fp = inputPaths[i]
    if (!fp) continue
    if (inputTypes[i] === 'mesh') {
      out.nodeInputMeshPath = fp
    } else if (inputTypes[i] === 'image') {
      if (!out.nodeInputPath) out.nodeInputPath = fp
      else out.extraImagePaths.push(fp)
    } else if (inputTypes[i] === 'audio' || inputTypes[i] === 'video') {
      if (!out.nodeInputPath) out.nodeInputPath = fp
    }
  }
  return out
}

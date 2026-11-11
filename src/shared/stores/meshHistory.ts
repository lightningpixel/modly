// Undo/redo stack of mesh states for the model in the viewer.
//
// Each state is a workspace mesh URL. Mesh edits never overwrite their input:
// every op writes a new file next to it, so a previous URL still points at the
// previous mesh and restoring it is enough to undo. Nothing here deletes files.

/** Undo steps kept per model; older states fall off the bottom of the stack. */
export const MESH_HISTORY_LIMIT = 20

export interface MeshHistory {
  /** Mesh URLs, oldest first. */
  entries: string[]
  /** Position of the mesh in the viewer; -1 when empty. */
  index: number
}

export function createMeshHistory(url?: string): MeshHistory {
  return url ? { entries: [url], index: 0 } : { entries: [], index: -1 }
}

export function currentMeshUrl(h: MeshHistory): string | undefined {
  return h.entries[h.index]
}

export function undoDepth(h: MeshHistory): number {
  return Math.max(0, h.index)
}

export function redoDepth(h: MeshHistory): number {
  return h.entries.length - 1 - h.index
}

/** Make `url` the current state, dropping any redo branch. */
export function recordMesh(h: MeshHistory, url: string, limit = MESH_HISTORY_LIMIT): MeshHistory {
  if (currentMeshUrl(h) === url) return h
  const entries = [...h.entries.slice(0, h.index + 1), url].slice(-(limit + 1))
  return { entries, index: entries.length - 1 }
}

/**
 * Record an edit from `fromUrl` to `toUrl`. The source mesh is recorded first
 * when it isn't the current state (a mesh that reached the viewer without being
 * recorded), so the edit can always be undone back to it.
 */
export function recordMeshEdit(
  h: MeshHistory,
  fromUrl: string | undefined,
  toUrl: string,
  limit = MESH_HISTORY_LIMIT,
): MeshHistory {
  const seeded = fromUrl ? recordMesh(h, fromUrl, limit) : h
  return recordMesh(seeded, toUrl, limit)
}

export function stepBack(h: MeshHistory): MeshHistory {
  return h.index > 0 ? { ...h, index: h.index - 1 } : h
}

export function stepForward(h: MeshHistory): MeshHistory {
  return redoDepth(h) > 0 ? { ...h, index: h.index + 1 } : h
}

import { resolve, sep } from 'node:path'

/** Atomic in-process reservations, including ancestor/descendant conflicts.
 * Fold case conservatively so Windows aliases cannot obtain separate leases.
 */
export class ModelWeightOperations {
  private leases = new Map<symbol, { owner: string; roots: string[] }>()

  get busy(): boolean { return this.leases.size > 0 }

  acquire(owner: string, roots: string[]): () => void {
    const canonical = roots.map((root) => resolve(root).normalize('NFC').toLowerCase())
    const contains = (parent: string, child: string) => (
      child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
    )
    for (const lease of this.leases.values()) {
      if (canonical.some((root) => lease.roots.some((other) => contains(root, other) || contains(other, root)))) {
        throw new Error(`Model weights are busy: ${lease.owner}`)
      }
    }
    const token = Symbol(owner)
    this.leases.set(token, { owner, roots: canonical })
    return () => { this.leases.delete(token) }
  }

  async remove<T>(roots: string[], unload: () => Promise<void>, remove: () => Promise<T>): Promise<T> {
    const release = this.acquire('removing model weights', roots)
    try {
      await unload()
      return await remove()
    } finally {
      release()
    }
  }
}

// Uniform dense grid over the welded vertices, for brush sphere queries.
//
// The grid covers the mesh bounding box plus a margin; vertices outside it
// (e.g. dragged far away by grab) are clamped into the border cells, and
// queries clamp their cell range the same way, so a query is always exact
// whatever the radius or how far vertices moved. Cells hold doubly linked
// lists so a moved vertex is re-bucketed in O(1).

const MAX_CELLS = 1 << 21

export class SpatialGrid {
  /** Query results: welded vertex ids and squared distances, valid up to the count returned by query(). */
  resultIds: Int32Array
  resultDist2: Float64Array

  private readonly pos: Float32Array
  private readonly ox: number
  private readonly oy: number
  private readonly oz: number
  private readonly inv: number
  private readonly cell: number
  private readonly nx: number
  private readonly ny: number
  private readonly nz: number
  private readonly head: Int32Array
  private readonly next: Int32Array
  private readonly prev: Int32Array
  private readonly cellOf: Int32Array

  /**
   * @param pos welded positions (xyz per welded vertex), read live by queries.
   * @param cellSize target cell edge; grown if the grid would get too large.
   */
  constructor(pos: Float32Array, count: number, min: readonly number[], max: readonly number[], cellSize: number) {
    this.pos = pos
    const ext = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 0)
    let cell = cellSize > 0 && Number.isFinite(cellSize) ? cellSize : ext > 0 ? ext / 64 : 1
    const margin = Math.max(ext * 0.125, cell)
    const dims = (c: number): [number, number, number] => [
      Math.max(1, Math.ceil((max[0] - min[0] + 2 * margin) / c)),
      Math.max(1, Math.ceil((max[1] - min[1] + 2 * margin) / c)),
      Math.max(1, Math.ceil((max[2] - min[2] + 2 * margin) / c)),
    ]
    let d = dims(cell)
    while (d[0] * d[1] * d[2] > MAX_CELLS) {
      cell *= 1.25
      d = dims(cell)
    }
    this.cell = cell
    this.inv = 1 / cell
    this.ox = min[0] - margin
    this.oy = min[1] - margin
    this.oz = min[2] - margin
    ;[this.nx, this.ny, this.nz] = d
    this.head = new Int32Array(d[0] * d[1] * d[2]).fill(-1)
    this.next = new Int32Array(count)
    this.prev = new Int32Array(count)
    this.cellOf = new Int32Array(count)
    this.resultIds = new Int32Array(1024)
    this.resultDist2 = new Float64Array(1024)
    for (let w = 0; w < count; w++) this.link(w, this.cellAt(pos[w * 3], pos[w * 3 + 1], pos[w * 3 + 2]))
  }

  private axis(v: number, o: number, n: number): number {
    const i = Math.floor((v - o) * this.inv)
    // NaN (degenerate input) lands in cell 0.
    return i > 0 ? (i < n ? i : n - 1) : 0
  }

  private cellAt(x: number, y: number, z: number): number {
    return (this.axis(z, this.oz, this.nz) * this.ny + this.axis(y, this.oy, this.ny)) * this.nx + this.axis(x, this.ox, this.nx)
  }

  private link(w: number, c: number): void {
    const h = this.head[c]
    this.next[w] = h
    this.prev[w] = -1
    if (h !== -1) this.prev[h] = w
    this.head[c] = w
    this.cellOf[w] = c
  }

  /** Re-buckets welded vertex `w` after its position changed. */
  update(w: number): void {
    const c = this.cellAt(this.pos[w * 3], this.pos[w * 3 + 1], this.pos[w * 3 + 2])
    const old = this.cellOf[w]
    if (c === old) return
    const p = this.prev[w]
    const n = this.next[w]
    if (p !== -1) this.next[p] = n
    else this.head[old] = n
    if (n !== -1) this.prev[n] = p
    this.link(w, c)
  }

  /** Collects the welded vertices strictly inside the sphere into resultIds/resultDist2; returns their count. */
  query(x: number, y: number, z: number, radius: number): number {
    if (!(radius > 0)) return 0
    const r2 = radius * radius
    const x0 = this.axis(x - radius, this.ox, this.nx)
    const x1 = this.axis(x + radius, this.ox, this.nx)
    const y0 = this.axis(y - radius, this.oy, this.ny)
    const y1 = this.axis(y + radius, this.oy, this.ny)
    const z0 = this.axis(z - radius, this.oz, this.nz)
    const z1 = this.axis(z + radius, this.oz, this.nz)
    const pos = this.pos
    const head = this.head
    const next = this.next
    let ids = this.resultIds
    let dist = this.resultDist2
    let count = 0
    for (let cz = z0; cz <= z1; cz++) {
      for (let cy = y0; cy <= y1; cy++) {
        const row = (cz * this.ny + cy) * this.nx
        for (let cx = x0; cx <= x1; cx++) {
          for (let w = head[row + cx]; w !== -1; w = next[w]) {
            const dx = pos[w * 3] - x
            const dy = pos[w * 3 + 1] - y
            const dz = pos[w * 3 + 2] - z
            const d2 = dx * dx + dy * dy + dz * dz
            if (d2 >= r2) continue
            if (count === ids.length) {
              const grownIds = new Int32Array(ids.length * 2)
              grownIds.set(ids)
              const grownDist = new Float64Array(ids.length * 2)
              grownDist.set(dist)
              ids = this.resultIds = grownIds
              dist = this.resultDist2 = grownDist
            }
            ids[count] = w
            dist[count] = d2
            count++
          }
        }
      }
    }
    return count
  }

  /** Cell edge length actually used. */
  get cellSize(): number {
    return this.cell
  }
}

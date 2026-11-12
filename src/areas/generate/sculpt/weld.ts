// Weld map: buffer vertices closer than `epsilon` (UV-seam duplicates, or the
// corners of a triangle soup) become one logical "welded" vertex.
//
// Vertices are bucketed in an integer-keyed open-addressing hash grid with
// cells of 4 × epsilon; a vertex only probes the neighbouring cells it is
// within epsilon of, so almost every vertex costs a single probe.

export interface WeldMap {
  /** Number of welded vertices. */
  count: number
  /** Buffer vertex → welded vertex. */
  weldOf: Uint32Array
  /** CSR: buffer vertices of welded vertex w are dupList[dupStart[w] .. dupStart[w + 1]). The first one is its representative. */
  dupStart: Uint32Array
  dupList: Uint32Array
}

function hashCell(x: number, y: number, z: number, mask: number): number {
  return (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & mask
}

export function buildWeldMap(
  positions: Float32Array,
  vertexCount: number,
  epsilon: number,
  origin: readonly [number, number, number],
): WeldMap {
  const n = vertexCount
  const eps = epsilon > 0 && Number.isFinite(epsilon) ? epsilon : 0
  const cell = eps > 0 ? eps * 4 : 1
  const inv = 1 / cell
  const epsCell = eps * inv
  const eps2 = eps * eps
  const [ox, oy, oz] = origin

  let cap = 16
  while (cap < n * 2) cap *= 2
  const mask = cap - 1
  const keyX = new Int32Array(cap)
  const keyY = new Int32Array(cap)
  const keyZ = new Int32Array(cap)
  const head = new Int32Array(cap).fill(-1)
  // Per welded vertex: next welded vertex in the same cell, and its representative buffer vertex.
  const next = new Int32Array(n)
  const rep = new Uint32Array(n)
  const weldOf = new Uint32Array(n)
  let count = 0

  const find = (x: number, y: number, z: number): number => {
    let h = hashCell(x, y, z, mask)
    for (;;) {
      if (head[h] === -1) return -1
      if (keyX[h] === x && keyY[h] === y && keyZ[h] === z) return h
      h = (h + 1) & mask
    }
  }

  for (let i = 0; i < n; i++) {
    const px = positions[i * 3]
    const py = positions[i * 3 + 1]
    const pz = positions[i * 3 + 2]
    const fx = (px - ox) * inv
    const fy = (py - oy) * inv
    const fz = (pz - oz) * inv
    const qx = Math.floor(fx)
    const qy = Math.floor(fy)
    const qz = Math.floor(fz)
    const rx = fx - qx
    const ry = fy - qy
    const rz = fz - qz
    const x0 = rx < epsCell ? qx - 1 : qx
    const x1 = 1 - rx <= epsCell ? qx + 1 : qx
    const y0 = ry < epsCell ? qy - 1 : qy
    const y1 = 1 - ry <= epsCell ? qy + 1 : qy
    const z0 = rz < epsCell ? qz - 1 : qz
    const z1 = 1 - rz <= epsCell ? qz + 1 : qz

    let found = -1
    search: for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        for (let cz = z0; cz <= z1; cz++) {
          const slot = find(cx | 0, cy | 0, cz | 0)
          if (slot < 0) continue
          for (let w = head[slot]; w !== -1; w = next[w]) {
            const r = rep[w] * 3
            const dx = positions[r] - px
            const dy = positions[r + 1] - py
            const dz = positions[r + 2] - pz
            if (dx * dx + dy * dy + dz * dz <= eps2) { found = w; break search }
          }
        }
      }
    }

    if (found >= 0) {
      weldOf[i] = found
      continue
    }
    const w = count++
    rep[w] = i
    weldOf[i] = w
    // Keys wrap to int32 for tiny epsilons; aliased cells only cost extra distance checks.
    const kx = qx | 0
    const ky = qy | 0
    const kz = qz | 0
    let h = hashCell(kx, ky, kz, mask)
    while (head[h] !== -1 && !(keyX[h] === kx && keyY[h] === ky && keyZ[h] === kz)) h = (h + 1) & mask
    if (head[h] === -1) {
      keyX[h] = kx
      keyY[h] = ky
      keyZ[h] = kz
    }
    next[w] = head[h]
    head[h] = w
  }

  const dupStart = new Uint32Array(count + 1)
  for (let i = 0; i < n; i++) dupStart[weldOf[i] + 1]++
  for (let w = 0; w < count; w++) dupStart[w + 1] += dupStart[w]
  const fill = dupStart.slice(0, count)
  const dupList = new Uint32Array(n)
  // Increasing i, so the representative (lowest index) comes first.
  for (let i = 0; i < n; i++) dupList[fill[weldOf[i]]++] = i

  return { count, weldOf, dupStart, dupList }
}

// Connectivity over welded vertices: welded triangles, vertex → faces and
// vertex → neighbours, all as CSR typed arrays.

export interface Csr {
  start: Uint32Array
  list: Uint32Array
}

/** Triangle corners expressed as welded vertex ids. `index` null → consecutive triples (triangle soup). */
export function weldedTriangles(index: Uint32Array | Uint16Array | null, vertexCount: number, weldOf: Uint32Array): Uint32Array {
  if (index) {
    const length = index.length - (index.length % 3)
    const tri = new Uint32Array(length)
    for (let k = 0; k < length; k++) {
      const v = index[k]
      if (v >= vertexCount) throw new RangeError(`SculptMesh: index ${v} out of range (${vertexCount} vertices)`)
      tri[k] = weldOf[v]
    }
    return tri
  }
  const length = vertexCount - (vertexCount % 3)
  const tri = new Uint32Array(length)
  for (let k = 0; k < length; k++) tri[k] = weldOf[k]
  return tri
}

/** Welded vertex → incident triangles. */
export function vertexFaces(tri: Uint32Array, count: number): Csr {
  const start = new Uint32Array(count + 1)
  for (let k = 0; k < tri.length; k++) start[tri[k] + 1]++
  for (let w = 0; w < count; w++) start[w + 1] += start[w]
  const fill = start.slice(0, count)
  const list = new Uint32Array(tri.length)
  for (let k = 0; k < tri.length; k++) list[fill[tri[k]]++] = (k / 3) | 0
  return { start, list }
}

/** Welded vertex → distinct edge neighbours (from the triangles). */
export function vertexNeighbours(tri: Uint32Array, faces: Csr, count: number): Csr {
  const mark = new Int32Array(count).fill(-1)
  const start = new Uint32Array(count + 1)
  // Pass 1: count distinct neighbours.
  for (let w = 0; w < count; w++) {
    let c = 0
    for (let k = faces.start[w]; k < faces.start[w + 1]; k++) {
      const f = faces.list[k] * 3
      for (let j = 0; j < 3; j++) {
        const u = tri[f + j]
        if (u !== w && mark[u] !== w) { mark[u] = w; c++ }
      }
    }
    start[w + 1] = start[w] + c
  }
  mark.fill(-1)
  const list = new Uint32Array(start[count])
  for (let w = 0; w < count; w++) {
    let o = start[w]
    for (let k = faces.start[w]; k < faces.start[w + 1]; k++) {
      const f = faces.list[k] * 3
      for (let j = 0; j < 3; j++) {
        const u = tri[f + j]
        if (u !== w && mark[u] !== w) { mark[u] = w; list[o++] = u }
      }
    }
  }
  return { start, list }
}

// Procedural meshes for the sculpt core tests (not a test file itself).

export interface TestMesh {
  positions: Float32Array
  index: Uint32Array | null
}

/** Unit cube with split vertices per face (24 vertices, 12 triangles), like a UV-mapped GLB. */
export function splitCube(): TestMesh {
  const faces: number[][][] = [
    [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]],
    [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]],
    [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]],
    [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]],
    [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]],
    [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]],
  ]
  const positions = new Float32Array(24 * 3)
  const index = new Uint32Array(36)
  faces.forEach((quad, f) => {
    quad.forEach((p, k) => positions.set(p, (f * 4 + k) * 3))
    index.set([f * 4, f * 4 + 1, f * 4 + 2, f * 4, f * 4 + 2, f * 4 + 3], f * 6)
  })
  return { positions, index }
}

/**
 * Grid in the xy plane over [-1, 1]², z = height(x, y). The triangulation is
 * mirrored across x = 0 so the mesh is exactly symmetric (topology included).
 */
export function grid(n: number, height: (x: number, y: number) => number = () => 0): TestMesh {
  const side = n + 1
  const positions = new Float32Array(side * side * 3)
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      // Build x from the centre outwards so mirrored columns are exact negatives.
      const x = (2 * i - n) / n
      const y = (2 * j - n) / n
      const o = (j * side + i) * 3
      positions[o] = x
      positions[o + 1] = y
      positions[o + 2] = height(x, y)
    }
  }
  const index = new Uint32Array(n * n * 6)
  let t = 0
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * side + i
      const b = a + 1
      const c = a + side
      const d = c + 1
      if (i < n / 2) index.set([a, b, d, a, d, c], t)
      else index.set([a, b, c, b, d, c], t)
      t += 6
    }
  }
  return { positions, index }
}

/** Mirror buffer index of grid vertex `v` across x = 0. */
export function gridMirror(n: number, v: number): number {
  const side = n + 1
  const i = v % side
  const j = (v - i) / side
  return j * side + (n - i)
}

/**
 * UV sphere (radius 1, centred at the origin) whose longitudes are split into
 * `islands` separate vertex sets, so every island border, the 0/2π seam and
 * the poles carry duplicated vertices, like a UV-unwrapped GLB.
 */
export function seamSphere(lat: number, lon: number, islands: number): TestMesh {
  const per = lon / islands
  const islandVerts = (per + 1) * (lat + 1)
  const positions = new Float32Array(islands * islandVerts * 3)
  const index = new Uint32Array(islands * per * lat * 6)
  let t = 0
  for (let k = 0; k < islands; k++) {
    const base = k * islandVerts
    for (let r = 0; r <= lat; r++) {
      const theta = (Math.PI * r) / lat
      const st = Math.sin(theta)
      const ct = Math.cos(theta)
      for (let c = 0; c <= per; c++) {
        const phi = (2 * Math.PI * ((k * per + c) % lon)) / lon
        const o = (base + r * (per + 1) + c) * 3
        positions[o] = r === 0 || r === lat ? 0 : st * Math.cos(phi)
        positions[o + 1] = ct
        positions[o + 2] = r === 0 || r === lat ? 0 : st * Math.sin(phi)
      }
    }
    for (let r = 0; r < lat; r++) {
      for (let c = 0; c < per; c++) {
        const a = base + r * (per + 1) + c
        const b = a + 1
        const d = a + per + 1
        const e = d + 1
        index.set([a, b, d, b, e, d], t)
        t += 6
      }
    }
  }
  return { positions, index }
}

/** Turns an indexed mesh into a triangle soup (non-indexed). */
export function unindex(mesh: TestMesh): TestMesh {
  if (!mesh.index) return mesh
  const out = new Float32Array(mesh.index.length * 3)
  for (let k = 0; k < mesh.index.length; k++) {
    const v = mesh.index[k]
    out[k * 3] = mesh.positions[v * 3]
    out[k * 3 + 1] = mesh.positions[v * 3 + 1]
    out[k * 3 + 2] = mesh.positions[v * 3 + 2]
  }
  return { positions: out, index: null }
}

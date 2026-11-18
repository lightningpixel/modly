/**
 * Pure 2D geometry behind the generation logo loader: turns the Modly SVG
 * paths into evenly triangulated low-poly pieces (no three.js, no DOM).
 */

export interface Vec2 { x: number, y: number }
export type Polygon = Vec2[]
export type Triangle = [number, number, number]

export interface LogoPiece {
  /** Piece centroid in logo space. */
  center: Vec2
  /** Vertices relative to `center`; the first `boundaryCount` are the outline, in order. */
  vertices: Vec2[]
  boundaryCount: number
  /** Counter-clockwise triangles (indices into `vertices`). */
  triangles: Triangle[]
}

// ─── SVG path → polygons ────────────────────────────────────────────────────

const TOKEN = /[MmLlCcZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g

/**
 * Parse the subset of SVG path syntax the logo uses (M, L, C and Z, absolute
 * or relative) into one polygon per subpath, flattening each cubic into
 * `curveSteps` segments. Coordinates stay in path space.
 */
export function pathToPolygons(d: string, curveSteps = 12): Polygon[] {
  const tokens = d.match(TOKEN) ?? []
  const polygons: Polygon[] = []
  let current: Polygon = []
  let cx = 0, cy = 0
  let command = ''
  let i = 0
  const num = (): number => {
    const t = tokens[i++]
    const n = Number(t)
    if (t === undefined || Number.isNaN(n)) throw new Error(`Bad SVG path number near token ${i}`)
    return n
  }
  const close = (): void => {
    if (current.length > 1) {
      const a = current[0]!, b = current[current.length - 1]!
      if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-9) current.pop()
    }
    if (current.length >= 3) polygons.push(current)
    current = []
  }

  while (i < tokens.length) {
    const t = tokens[i]!
    if (/^[A-Za-z]$/.test(t)) { command = t; i++ }
    else if (!command) throw new Error('SVG path must start with a command')
    const rel = command === command.toLowerCase()
    switch (command.toUpperCase()) {
      case 'M': {
        close()
        const x = num() + (rel ? cx : 0), y = num() + (rel ? cy : 0)
        cx = x; cy = y
        current.push({ x, y })
        command = rel ? 'l' : 'L' // extra pairs after a moveto are linetos
        break
      }
      case 'L': {
        const x = num() + (rel ? cx : 0), y = num() + (rel ? cy : 0)
        cx = x; cy = y
        current.push({ x, y })
        break
      }
      case 'C': {
        const ox = rel ? cx : 0, oy = rel ? cy : 0
        const x1 = num() + ox, y1 = num() + oy
        const x2 = num() + ox, y2 = num() + oy
        const x = num() + ox, y = num() + oy
        for (let s = 1; s <= curveSteps; s++) {
          const u = s / curveSteps, v = 1 - u
          current.push({
            x: v * v * v * cx + 3 * v * v * u * x1 + 3 * v * u * u * x2 + u * u * u * x,
            y: v * v * v * cy + 3 * v * v * u * y1 + 3 * v * u * u * y2 + u * u * u * y,
          })
        }
        cx = x; cy = y
        break
      }
      case 'Z': {
        const start = current[0]
        close()
        if (start) { cx = start.x; cy = start.y }
        command = ''
        break
      }
      default:
        throw new Error(`Unsupported SVG path command "${command}"`)
    }
  }
  close()
  return polygons
}

// ─── Polygon helpers ────────────────────────────────────────────────────────

export function signedArea(poly: Polygon): number {
  let a = 0
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += poly[j]!.x * poly[i]!.y - poly[i]!.x * poly[j]!.y
  }
  return a / 2
}

/** Area-weighted centroid of a simple polygon. */
export function polygonCentroid(poly: Polygon): Vec2 {
  let cx = 0, cy = 0
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const p = poly[j]!, q = poly[i]!
    const cross = p.x * q.y - q.x * p.y
    cx += (p.x + q.x) * cross
    cy += (p.y + q.y) * cross
  }
  const a = signedArea(poly)
  return { x: cx / (6 * a), y: cy / (6 * a) }
}

export function pointInPolygon(p: Vec2, poly: Polygon): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

export function distanceToPolygon(p: Vec2, poly: Polygon): number {
  let best = Infinity
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j]!, b = poly[i]!
    const dx = b.x - a.x, dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)))
  }
  return best
}

/**
 * Fit several polygon groups into a square of side `size` centered on the
 * origin, keeping proportions. Path space is already Y-up, so no flip.
 */
export function fitPolygons(groups: Polygon[][], size: number): Polygon[][] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const g of groups) for (const poly of g) for (const p of poly) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
  }
  const s = size / Math.max(maxX - minX, maxY - minY)
  const mx = (minX + maxX) / 2, my = (minY + maxY) / 2
  return groups.map((g) => g.map((poly) => poly.map((p) => ({ x: (p.x - mx) * s, y: (p.y - my) * s }))))
}

/**
 * Resample an outline to roughly `spacing` between vertices — the low-poly
 * look — while keeping sharp corners (turn above `cornerDeg`) in place.
 */
export function resamplePolygon(poly: Polygon, spacing: number, cornerDeg = 35): Polygon {
  const n = poly.length
  const isCorner = (i: number): boolean => {
    const p = poly[(i + n - 1) % n]!, q = poly[i]!, r = poly[(i + 1) % n]!
    const a1 = Math.atan2(q.y - p.y, q.x - p.x), a2 = Math.atan2(r.y - q.y, r.x - q.x)
    let turn = Math.abs(a2 - a1)
    if (turn > Math.PI) turn = 2 * Math.PI - turn
    return turn > (cornerDeg * Math.PI) / 180
  }
  // Start on a corner when there is one so the seam does not cut it.
  let start = 0
  for (let i = 0; i < n; i++) if (isCorner(i)) { start = i; break }

  // Split the outline into runs between corners, then place evenly spaced
  // points along each run (never fewer than one segment per run).
  const out: Polygon = []
  let run: Polygon = [poly[start]!]
  const flush = (): void => {
    let length = 0
    for (let k = 1; k < run.length; k++) length += Math.hypot(run[k]!.x - run[k - 1]!.x, run[k]!.y - run[k - 1]!.y)
    const count = Math.max(1, Math.round(length / spacing))
    const step = length / count
    out.push(run[0]!)
    let k = 1, walked = 0, target = step
    for (let c = 1; c < count; c++, target += step) {
      while (k < run.length) {
        const a = run[k - 1]!, b = run[k]!
        const seg = Math.hypot(b.x - a.x, b.y - a.y)
        if (walked + seg >= target) {
          const t = seg === 0 ? 0 : (target - walked) / seg
          out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
          break
        }
        walked += seg
        k++
      }
    }
  }
  for (let s = 1; s <= n; s++) {
    const i = (start + s) % n
    run.push(poly[i]!)
    if (s === n || isCorner(i)) { flush(); run = [poly[i]!] }
  }
  return out
}

// ─── Triangulation ──────────────────────────────────────────────────────────

/** Deterministic pseudo-random in [0, 1) from two integers. */
function hash2(i: number, j: number): number {
  const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453
  return s - Math.floor(s)
}

/** Jittered hexagonal grid of points inside `poly`, kept clear of its outline. */
export function interiorPoints(poly: Polygon, spacing: number): Vec2[] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of poly) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
  }
  const rowH = spacing * Math.sqrt(3) / 2
  const out: Vec2[] = []
  for (let j = 0, y = minY + rowH / 2; y < maxY; j++, y += rowH) {
    for (let i = 0, x = minX + (j % 2 ? spacing / 2 : 0); x < maxX; i++, x += spacing) {
      const p = {
        x: x + (hash2(i, j) - 0.5) * spacing * 0.35,
        y: y + (hash2(j, i + 17) - 0.5) * spacing * 0.35,
      }
      if (pointInPolygon(p, poly) && distanceToPolygon(p, poly) > spacing * 0.55) out.push(p)
    }
  }
  return out
}

/** Bowyer–Watson Delaunay triangulation; returns counter-clockwise triangles. */
export function delaunay(points: Vec2[]): Triangle[] {
  const n = points.length
  if (n < 3) return []
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of points) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
  }
  const d = Math.max(maxX - minX, maxY - minY) * 20 || 1
  const mx = (minX + maxX) / 2, my = (minY + maxY) / 2
  const pts = [...points, { x: mx - d, y: my - d }, { x: mx + d, y: my - d }, { x: mx, y: my + d }]

  interface Tri { a: number, b: number, c: number, x: number, y: number, r2: number }
  const make = (a: number, b: number, c: number): Tri => {
    const A = pts[a]!, B = pts[b]!, C = pts[c]!
    const det = 2 * (A.x * (B.y - C.y) + B.x * (C.y - A.y) + C.x * (A.y - B.y))
    if (Math.abs(det) < 1e-12) return { a, b, c, x: 0, y: 0, r2: Infinity }
    const a2 = A.x * A.x + A.y * A.y, b2 = B.x * B.x + B.y * B.y, c2 = C.x * C.x + C.y * C.y
    const x = (a2 * (B.y - C.y) + b2 * (C.y - A.y) + c2 * (A.y - B.y)) / det
    const y = (a2 * (C.x - B.x) + b2 * (A.x - C.x) + c2 * (B.x - A.x)) / det
    return { a, b, c, x, y, r2: (A.x - x) ** 2 + (A.y - y) ** 2 }
  }

  let tris: Tri[] = [make(n, n + 1, n + 2)]
  for (let i = 0; i < n; i++) {
    const p = pts[i]!
    const keep: Tri[] = []
    const edges = new Map<string, [number, number, number]>()
    for (const t of tris) {
      if ((p.x - t.x) ** 2 + (p.y - t.y) ** 2 < t.r2 * (1 - 1e-12)) {
        for (const [u, v] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]] as const) {
          const key = u < v ? `${u},${v}` : `${v},${u}`
          const e = edges.get(key)
          if (e) e[2]++
          else edges.set(key, [u, v, 1])
        }
      } else keep.push(t)
    }
    for (const [u, v, count] of edges.values()) if (count === 1) keep.push(make(u, v, i))
    tris = keep
  }

  const out: Triangle[] = []
  for (const t of tris) {
    if (t.a >= n || t.b >= n || t.c >= n) continue
    const A = points[t.a]!, B = points[t.b]!, C = points[t.c]!
    const cross = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x)
    if (Math.abs(cross) < 1e-12) continue
    out.push(cross > 0 ? [t.a, t.b, t.c] : [t.a, t.c, t.b])
  }
  return out
}

/**
 * Low-poly triangulation of one simple polygon: resampled outline plus a
 * jittered interior grid, Delaunay-triangulated and clipped to the shape.
 */
export function triangulatePiece(poly: Polygon, spacing: number): LogoPiece {
  const ccw = signedArea(poly) < 0 ? [...poly].reverse() : poly
  const outline = resamplePolygon(ccw, spacing)
  const all = [...outline, ...interiorPoints(ccw, spacing)]
  const triangles = delaunay(all).filter(([a, b, c]) => {
    const A = all[a]!, B = all[b]!, C = all[c]!
    return pointInPolygon({ x: (A.x + B.x + C.x) / 3, y: (A.y + B.y + C.y) / 3 }, ccw)
  })
  const center = polygonCentroid(ccw)
  return {
    center,
    vertices: all.map((p) => ({ x: p.x - center.x, y: p.y - center.y })),
    boundaryCount: outline.length,
    triangles,
  }
}

/** Every triangle edge once, as [low, high] index pairs. */
export function uniqueEdges(triangles: Triangle[]): [number, number][] {
  const seen = new Set<string>()
  const out: [number, number][] = []
  for (const [a, b, c] of triangles) {
    for (const [u, v] of [[a, b], [b, c], [c, a]] as const) {
      const lo = Math.min(u, v), hi = Math.max(u, v)
      const key = `${lo},${hi}`
      if (!seen.has(key)) { seen.add(key); out.push([lo, hi]) }
    }
  }
  return out
}

/** Unit vector from the logo center toward a piece; straight up when they coincide. */
export function pieceDirection(piece: Vec2, logoCenter: Vec2): Vec2 {
  const dx = piece.x - logoCenter.x, dy = piece.y - logoCenter.y
  const len = Math.hypot(dx, dy)
  return len < 1e-9 ? { x: 0, y: 1 } : { x: dx / len, y: dy / len }
}

/** Parse, fit and triangulate the logo paths into pieces centered on the origin. */
export function buildLogoPieces(paths: readonly string[], size: number, spacing: number): LogoPiece[] {
  const fitted = fitPolygons(paths.map((d) => pathToPolygons(d)), size)
  return fitted.map((polys) => triangulatePiece(polys[0]!, spacing))
}

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildLogoPieces, delaunay, fitPolygons, pathToPolygons, pieceDirection, pointInPolygon,
  polygonCentroid, resamplePolygon, signedArea, triangulatePiece, uniqueEdges, type Polygon,
} from './logoLoaderGeometry'
import { MODLY_LOGO_PATHS } from '../../../shared/components/ui/modlyLogoPaths'

const square: Polygon = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }]

test('pathToPolygons reads absolute moves and relative lines', () => {
  assert.deepEqual(pathToPolygons('M10 10 l5 0 0 5 -5 0z'), [[
    { x: 10, y: 10 }, { x: 15, y: 10 }, { x: 15, y: 15 }, { x: 10, y: 15 },
  ]])
})

test('pathToPolygons flattens relative cubics ending on their endpoint', () => {
  const [poly] = pathToPolygons('M0 0 c0 10 10 10 10 0 l0 -5z', 4)
  assert.equal(poly!.length, 1 + 4 + 1)
  assert.deepEqual(poly![4], { x: 10, y: 0 })
  assert.deepEqual(poly![5], { x: 10, y: -5 })
  assert.ok(poly![2]!.y > 5, 'the curve bulges toward its control points')
})

test('pathToPolygons rejects commands outside the supported subset', () => {
  assert.throws(() => pathToPolygons('M0 0 A 1 1 0 0 0 5 5z'), /Unsupported|Bad/)
})

test('polygon helpers: area, centroid, inside test', () => {
  assert.equal(signedArea(square), 4)
  assert.deepEqual(polygonCentroid(square), { x: 1, y: 1 })
  assert.equal(pointInPolygon({ x: 1, y: 1 }, square), true)
  assert.equal(pointInPolygon({ x: 3, y: 1 }, square), false)
})

test('fitPolygons centers on the origin and fits the largest side', () => {
  const [[fit]] = fitPolygons([[square.map((p) => ({ x: p.x + 10, y: p.y * 0.5 + 4 }))]], 1)
  const xs = fit!.map((p) => p.x), ys = fit!.map((p) => p.y)
  assert.deepEqual([Math.min(...xs), Math.max(...xs)], [-0.5, 0.5])
  assert.deepEqual([Math.min(...ys), Math.max(...ys)], [-0.25, 0.25])
})

test('resamplePolygon keeps corners and spaces points along straight runs', () => {
  const out = resamplePolygon(square, 0.5)
  assert.equal(out.length, 16)
  for (const c of square) assert.ok(out.some((p) => p.x === c.x && p.y === c.y), `corner ${c.x},${c.y} kept`)
})

test('delaunay triangulates a square grid without overlap', () => {
  const pts = [{ x: 0, y: 0 }, { x: 1, y: 0.01 }, { x: 0.02, y: 1 }, { x: 1, y: 1 }, { x: 0.5, y: 0.45 }]
  const tris = delaunay(pts)
  assert.equal(tris.length, 4)
  let area = 0
  for (const [a, b, c] of tris) {
    const A = pts[a]!, B = pts[b]!, C = pts[c]!
    const cross = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x)
    assert.ok(cross > 0, 'counter-clockwise')
    area += cross / 2
  }
  const hull = [pts[0]!, pts[1]!, pts[3]!, pts[2]!]
  assert.ok(Math.abs(area - signedArea(hull)) < 1e-9, 'triangles tile the convex hull')
})

test('triangulatePiece covers the shape area and stays inside it', () => {
  const piece = triangulatePiece(square, 0.4)
  let area = 0
  for (const [a, b, c] of piece.triangles) {
    const A = piece.vertices[a]!, B = piece.vertices[b]!, C = piece.vertices[c]!
    area += ((B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x)) / 2
  }
  assert.ok(Math.abs(area - 4) < 1e-6, `area ${area}`)
  assert.ok(piece.vertices.length > piece.boundaryCount, 'has interior vertices')
  assert.deepEqual(piece.center, { x: 1, y: 1 })
})

test('uniqueEdges lists shared edges once', () => {
  assert.equal(uniqueEdges([[0, 1, 2], [2, 1, 3]]).length, 5)
})

test('pieceDirection points away from the center, up when degenerate', () => {
  assert.deepEqual(pieceDirection({ x: 3, y: 4 }, { x: 0, y: 0 }), { x: 0.6, y: 0.8 })
  assert.deepEqual(pieceDirection({ x: 1, y: 1 }, { x: 1, y: 1 }), { x: 0, y: 1 })
})

test('the Modly logo builds three Y-up pieces that fill their outlines', () => {
  const pieces = buildLogoPieces(MODLY_LOGO_PATHS, 2, 0.12)
  assert.equal(pieces.length, 3)
  const [top, right, bottom] = pieces
  // Path space is Y-up: the first piece sits above the third, the second on the right.
  assert.ok(top!.center.y > bottom!.center.y)
  assert.ok(right!.center.x > top!.center.x)
  for (const piece of pieces) {
    assert.ok(piece.triangles.length > 20, 'triangulated')
    const outline = piece.vertices.slice(0, piece.boundaryCount)
    let area = 0
    for (const [a, b, c] of piece.triangles) {
      const A = piece.vertices[a]!, B = piece.vertices[b]!, C = piece.vertices[c]!
      area += ((B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x)) / 2
    }
    const rel = Math.abs(area - signedArea(outline)) / signedArea(outline)
    assert.ok(rel < 0.02, `triangles cover the outline (off by ${(rel * 100).toFixed(2)}%)`)
  }
})

import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { useAppStore } from '@shared/stores/appStore'
import { MODLY_LOGO_PATHS } from '@shared/components/ui/modlyLogoPaths'
import { buildLogoPieces, pieceDirection, uniqueEdges, type LogoPiece, type Vec2 } from './logoLoaderGeometry'
import { flightPose, trailSample } from './logoLoaderMotion'

// ─── Tuning ─────────────────────────────────────────────────────────────────

const LOGO_SIZE = 2.1        // world units across the logo's largest side
const MESH_SPACING = 0.17    // target triangle edge length (the low-poly grain)
const DEPTH = 0.14           // extrusion thickness
const FLY_DISTANCE = 0.6     // how far a clicked piece travels outward
const FLY_LIFT = 0.35        // and how far it comes toward the camera
const FLY_TILT = 0.55        // radians of tilt at the far point
const TRAIL_POINTS = 20      // outline samples that shed trail particles
const TRAIL_STEPS = 7        // particles per sample, each further back in time
const TRAIL_LAG_MS = 38
const SPIN_SPEED = 0.4       // rad/s idle rotation
const SPIN_SPEED_HOVER = 0.1
const FADE_MS = 450

const VIOLET_DEEP = new THREE.Color('#7e22ce')
const VIOLET = new THREE.Color('#9333ea')
const VIOLET_LIGHT = new THREE.Color('#c084fc')
const LILAC = new THREE.Color('#e9d5ff')

// ─── Per-piece GPU resources ────────────────────────────────────────────────

interface PieceResources {
  piece: LogoPiece
  dir: Vec2
  face: THREE.BufferGeometry
  inner: THREE.BufferGeometry
  outline: THREE.BufferGeometry
  dots: THREE.BufferGeometry
  trail: THREE.BufferGeometry
  /** Piece-local XY of the outline samples that emit trail particles. */
  trailOrigins: Vec2[]
  faceMat: THREE.MeshBasicMaterial
  innerMat: THREE.LineBasicMaterial
  outlineMat: THREE.LineBasicMaterial
  dotsMat: THREE.PointsMaterial
  trailMat: THREE.PointsMaterial
}

function additive<T extends THREE.Material>(mat: T): T {
  mat.transparent = true
  mat.depthWrite = false
  mat.blending = THREE.AdditiveBlending
  return mat
}

function buildPieceResources(piece: LogoPiece, dotTexture: THREE.Texture): PieceResources {
  const { vertices, triangles, boundaryCount: b } = piece
  const n = vertices.length
  const h = DEPTH / 2

  // Closed slab: front face, back face, and side walls along the outline.
  const pos = new Float32Array(n * 2 * 3)
  vertices.forEach((v, k) => {
    pos.set([v.x, v.y, h], k * 3)
    pos.set([v.x, v.y, -h], (k + n) * 3)
  })
  const index: number[] = []
  for (const [a, c, d] of triangles) index.push(a, c, d, a + n, d + n, c + n)
  for (let i = 0; i < b; i++) {
    const j = (i + 1) % b
    index.push(i, j + n, j, i, i + n, j + n)
  }
  const face = new THREE.BufferGeometry()
  face.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  face.setIndex(index)
  face.computeBoundingSphere()

  // Inner triangulation on both faces, plus the ribs joining front and back.
  const isOutlineEdge = (u: number, v: number): boolean =>
    u < b && v < b && (Math.abs(u - v) === 1 || Math.abs(u - v) === b - 1)
  const innerPts: number[] = []
  for (const [u, v] of uniqueEdges(triangles)) {
    if (isOutlineEdge(u, v)) continue
    for (const z of [h, -h]) innerPts.push(vertices[u]!.x, vertices[u]!.y, z, vertices[v]!.x, vertices[v]!.y, z)
  }
  for (let i = 0; i < b; i++) innerPts.push(vertices[i]!.x, vertices[i]!.y, h, vertices[i]!.x, vertices[i]!.y, -h)
  const inner = new THREE.BufferGeometry()
  inner.setAttribute('position', new THREE.Float32BufferAttribute(innerPts, 3))

  // Crisp outline on both faces.
  const outlinePts: number[] = []
  for (const z of [h, -h]) {
    for (let i = 0; i < b; i++) {
      const p = vertices[i]!, q = vertices[(i + 1) % b]!
      outlinePts.push(p.x, p.y, z, q.x, q.y, z)
    }
  }
  const outline = new THREE.BufferGeometry()
  outline.setAttribute('position', new THREE.Float32BufferAttribute(outlinePts, 3))

  // Vertex dots on both faces.
  const dotPts: number[] = []
  for (const z of [h, -h]) vertices.forEach((v) => dotPts.push(v.x, v.y, z))
  const dots = new THREE.BufferGeometry()
  dots.setAttribute('position', new THREE.Float32BufferAttribute(dotPts, 3))

  // Trail: positions and colors are rewritten every frame while the piece flies.
  const trailOrigins: Vec2[] = []
  const stride = Math.max(1, Math.floor(b / TRAIL_POINTS))
  for (let i = 0; i < b && trailOrigins.length < TRAIL_POINTS; i += stride) trailOrigins.push(vertices[i]!)
  const trailCount = trailOrigins.length * TRAIL_STEPS
  const trail = new THREE.BufferGeometry()
  trail.setAttribute('position', new THREE.BufferAttribute(new Float32Array(trailCount * 3), 3))
  trail.setAttribute('color', new THREE.BufferAttribute(new Float32Array(trailCount * 3), 3))

  return {
    piece,
    dir: pieceDirection(piece.center, { x: 0, y: 0 }),
    face, inner, outline, dots, trail, trailOrigins,
    faceMat: additive(new THREE.MeshBasicMaterial({ color: VIOLET_DEEP, opacity: 0.07, side: THREE.DoubleSide })),
    innerMat: additive(new THREE.LineBasicMaterial({ color: VIOLET_LIGHT, opacity: 0.4 })),
    outlineMat: additive(new THREE.LineBasicMaterial({ color: LILAC, opacity: 0.85 })),
    dotsMat: additive(new THREE.PointsMaterial({ color: LILAC, map: dotTexture, size: 0.05, opacity: 0.9, sizeAttenuation: true })),
    trailMat: additive(new THREE.PointsMaterial({ map: dotTexture, size: 0.055, vertexColors: true, sizeAttenuation: true })),
  }
}

function disposePieceResources(r: PieceResources): void {
  for (const g of [r.face, r.inner, r.outline, r.dots, r.trail]) g.dispose()
  for (const m of [r.faceMat, r.innerMat, r.outlineMat, r.dotsMat, r.trailMat]) m.dispose()
}

function makeDotTexture(): THREE.Texture {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.35, 'rgba(255,255,255,0.85)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

/** Deterministic jitter in [-1, 1) so trail particles scatter the same way every flight. */
function jitter(i: number, k: number, axis: number): number {
  const s = Math.sin(i * 12.9898 + k * 78.233 + axis * 37.719) * 43758.5453
  return (s - Math.floor(s)) * 2 - 1
}

// ─── Scene ──────────────────────────────────────────────────────────────────

interface SceneProps {
  hovered: number | null
  onHover: (index: number | null) => void
  reducedMotion: boolean
}

function LogoScene({ hovered, onHover, reducedMotion }: SceneProps): JSX.Element {
  const resources = useMemo(() => {
    const dotTexture = makeDotTexture()
    const pieces = buildLogoPieces(MODLY_LOGO_PATHS, LOGO_SIZE, MESH_SPACING)
    return { dotTexture, pieces: pieces.map((p) => buildPieceResources(p, dotTexture)) }
  }, [])
  useEffect(() => () => {
    resources.pieces.forEach(disposePieceResources)
    resources.dotTexture.dispose()
  }, [resources])

  const clock = useThree((s) => s.clock)
  const logoRef = useRef<THREE.Group>(null)
  const pieceRefs = useRef<(THREE.Group | null)[]>([])
  const flightStart = useRef<(number | null)[]>(resources.pieces.map(() => null))
  const spin = useRef(SPIN_SPEED)
  const hoveredRef = useRef(hovered)
  hoveredRef.current = hovered

  const axis = useMemo(() => new THREE.Vector3(), [])
  const color = useMemo(() => new THREE.Color(), [])

  useFrame((state, dt) => {
    const now = state.clock.elapsedTime * 1000
    const ease = 1 - Math.exp(-dt * 12)
    const logo = logoRef.current
    if (logo) {
      if (reducedMotion) {
        logo.rotation.set(-0.12, -0.45, 0)
        logo.position.y = 0.12
      } else {
        spin.current += ((hoveredRef.current === null ? SPIN_SPEED : SPIN_SPEED_HOVER) - spin.current) * (1 - Math.exp(-dt * 3))
        logo.rotation.y += spin.current * dt
        logo.rotation.x = -0.12
        logo.position.y = 0.12 + Math.sin(state.clock.elapsedTime * 0.9) * 0.04
      }
    }

    resources.pieces.forEach((r, i) => {
      const group = pieceRefs.current[i]
      if (!group) return
      const start = flightStart.current[i]
      const elapsed = start === null ? -1 : now - start
      const pose = flightPose(elapsed)
      if (start !== null && !pose.inFlight) flightStart.current[i] = null

      const { center } = r.piece
      group.position.set(
        center.x + r.dir.x * FLY_DISTANCE * pose.offset,
        center.y + r.dir.y * FLY_DISTANCE * pose.offset,
        FLY_LIFT * pose.offset,
      )
      axis.set(-r.dir.y, r.dir.x, 0)
      group.quaternion.setFromAxisAngle(axis, -FLY_TILT * pose.tilt)
      group.scale.setScalar(pose.scale)

      const hot = hoveredRef.current === i ? 1 : 0
      const lit = Math.min(1, hot + pose.flash * 0.8)
      r.faceMat.opacity += (0.07 + 0.24 * lit - r.faceMat.opacity) * ease
      r.faceMat.color.lerp(color.lerpColors(VIOLET_DEEP, VIOLET, lit), ease)
      r.innerMat.opacity += (0.4 + 0.45 * lit - r.innerMat.opacity) * ease
      r.outlineMat.opacity += (0.85 + 0.15 * lit - r.outlineMat.opacity) * ease
      r.dotsMat.size += (0.05 + 0.02 * lit - r.dotsMat.size) * ease

      // Trail particles, in logo space, lagging behind the flying piece.
      const posAttr = r.trail.getAttribute('position') as THREE.BufferAttribute
      const colAttr = r.trail.getAttribute('color') as THREE.BufferAttribute
      const visible = start !== null
      r.trailMat.visible = visible
      if (!visible) return
      let p = 0
      for (let s = 0; s < r.trailOrigins.length; s++) {
        const o = r.trailOrigins[s]!
        for (let k = 1; k <= TRAIL_STEPS; k++, p++) {
          const sample = trailSample(elapsed, k * TRAIL_LAG_MS)
          const spread = 0.012 * k
          posAttr.setXYZ(
            p,
            center.x + o.x + r.dir.x * FLY_DISTANCE * sample.offset + jitter(s, k, 0) * spread,
            center.y + o.y + r.dir.y * FLY_DISTANCE * sample.offset + jitter(s, k, 1) * spread,
            FLY_LIFT * sample.offset + jitter(s, k, 2) * spread,
          )
          const a = sample.alpha * (1 - (k - 1) / TRAIL_STEPS)
          colAttr.setXYZ(p, VIOLET_LIGHT.r * a, VIOLET_LIGHT.g * a, VIOLET_LIGHT.b * a)
        }
      }
      posAttr.needsUpdate = true
      colAttr.needsUpdate = true
    })
  })

  function handleClick(i: number, e: ThreeEvent<MouseEvent>): void {
    e.stopPropagation()
    if (reducedMotion || flightStart.current[i] !== null) return
    flightStart.current[i] = clock.elapsedTime * 1000
  }

  return (
    <group ref={logoRef}>
      {resources.pieces.map((r, i) => (
        <group key={i}>
          <group ref={(g) => { pieceRefs.current[i] = g }}>
            <mesh
              geometry={r.face}
              material={r.faceMat}
              onPointerOver={(e) => { e.stopPropagation(); onHover(i) }}
              onPointerOut={() => { if (hoveredRef.current === i) onHover(null) }}
              onClick={(e) => handleClick(i, e)}
            />
            <lineSegments geometry={r.inner} material={r.innerMat} />
            <lineSegments geometry={r.outline} material={r.outlineMat} />
            <points geometry={r.dots} material={r.dotsMat} />
          </group>
          <points geometry={r.trail} material={r.trailMat} frustumCulled={false} />
        </group>
      ))}
    </group>
  )
}

// ─── Overlay ────────────────────────────────────────────────────────────────

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = (): void => setReduced(mq.matches)
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])
  return reduced
}

/**
 * Playful 3D Modly logo shown over the Generate viewer while a mesh is being
 * generated. Hover lights a piece up; a click sends it flying and back.
 */
export default function GenerationLogoLoader(): JSX.Element | null {
  const status = useAppStore((s) => s.currentJob?.status)
  const active = status === 'uploading' || status === 'generating'
  const [mounted, setMounted] = useState(active)
  const [shown, setShown] = useState(false)
  const [hovered, setHovered] = useState<number | null>(null)
  const reducedMotion = usePrefersReducedMotion()

  useEffect(() => {
    if (active) {
      setMounted(true)
      // Two frames so the transparent state is painted before fading in.
      let id = requestAnimationFrame(() => { id = requestAnimationFrame(() => setShown(true)) })
      return () => cancelAnimationFrame(id)
    }
    setShown(false)
    const id = setTimeout(() => { setMounted(false); setHovered(null) }, FADE_MS)
    return () => clearTimeout(id)
  }, [active])

  if (!mounted) return null

  return (
    <div
      className="absolute inset-0 z-10 bg-zinc-950/75 transition-opacity ease-out"
      style={{
        opacity: shown ? 1 : 0,
        transitionDuration: `${FADE_MS}ms`,
        cursor: hovered === null ? 'default' : 'pointer',
        pointerEvents: active ? 'auto' : 'none',
      }}
      aria-hidden="true"
    >
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ background: 'radial-gradient(ellipse 38% 34% at 50% 47%, rgba(147,51,234,0.30), rgba(88,28,135,0.12) 55%, transparent 80%)' }}
      />
      <Canvas
        className="!absolute inset-0"
        frameloop="always"
        dpr={[1, 2]}
        flat
        camera={{ position: [0, 0, 6.4], fov: 35 }}
        gl={{ alpha: true, antialias: true, powerPreference: 'high-performance' }}
        style={{ filter: 'drop-shadow(0 0 3px rgba(192,132,252,0.75)) drop-shadow(0 0 14px rgba(147,51,234,0.45))' }}
      >
        <LogoScene hovered={hovered} onHover={setHovered} reducedMotion={reducedMotion} />
      </Canvas>
    </div>
  )
}

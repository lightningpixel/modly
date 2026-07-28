import { Component, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, ErrorInfo, MutableRefObject } from 'react'
import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber'
import type { ThreeEvent } from '@react-three/fiber'
import { Environment, GizmoHelper, Lightformer, OrbitControls, useGizmoContext, useGLTF } from '@react-three/drei'
import { EffectComposer, Outline, Select, Selection } from '@react-three/postprocessing'
import * as THREE from 'three'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh'

// Patch THREE pour utiliser BVH sur tous les meshes — réduit le raycast O(N) → O(log N)
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree as any
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree as any
THREE.Mesh.prototype.raycast = acceleratedRaycast
import SplatViewer, { type SplatViewerHandle } from './SplatViewer'
import { useGeneration } from '@shared/hooks/useGeneration'
import { useAppStore } from '@shared/stores/appStore'
import { ViewerToolbar, type ViewMode } from './ViewerToolbar'
import { MotionBar, type MotionClip } from './MotionBar'
import type { LightSettings } from '@shared/stores/appStore'
import { DEFAULT_LIGHT_SETTINGS } from '@shared/stores/appStore'

export type GizmoMode = 'translate' | 'rotate' | 'scale'

const SELECTION_OUTLINE_VISIBLE_COLOR = 0x8b5cf6
const SELECTION_OUTLINE_HIDDEN_COLOR = 0x5b21b6
const SELECTION_OUTLINE_EDGE_STRENGTH = 2.5
const SELECTION_OUTLINE_BLUR = false
const SELECTION_OUTLINE_MULTISAMPLING = 0
const SELECTION_OUTLINE_RESOLUTION_SCALE = 0.5

// ---------------------------------------------------------------------------
// Procedural textures
// ---------------------------------------------------------------------------

function createMatcapTexture(): THREE.CanvasTexture {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const grad = ctx.createRadialGradient(size * 0.35, size * 0.3, 0, size / 2, size / 2, size / 2)
  grad.addColorStop(0, '#ffffff')
  grad.addColorStop(0.45, '#aaaaaa')
  grad.addColorStop(1, '#222222')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, size, size)
  return new THREE.CanvasTexture(canvas)
}

function createCheckerTexture(): THREE.CanvasTexture {
  const size = 256
  const tileCount = 8
  const tileSize = size / tileCount
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  for (let row = 0; row < tileCount; row++) {
    for (let col = 0; col < tileCount; col++) {
      ctx.fillStyle = (row + col) % 2 === 0 ? '#e0e0e0' : '#888888'
      ctx.fillRect(col * tileSize, row * tileSize, tileSize, tileSize)
    }
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  return tex
}

// ---------------------------------------------------------------------------
// CanvasCapture — exposes gl.domElement ref outside Canvas
// ---------------------------------------------------------------------------

function CanvasCapture({
  domRef,
}: {
  domRef: React.MutableRefObject<HTMLCanvasElement | null>
}): null {
  const { gl } = useThree()
  useEffect(() => {
    domRef.current = gl.domElement
    // eslint-disable-next-line react-hooks/exhaustive-deps -- domRef is a stable ref
  }, [gl])
  return null
}

// ---------------------------------------------------------------------------
// ModelErrorBoundary — catches useGLTF load failures (e.g. 404)
// ---------------------------------------------------------------------------

interface ErrorBoundaryProps {
  children: ReactNode
  fallback: ReactNode
  resetKey?: string | null
}

interface ErrorBoundaryState {
  hasError: boolean
}

class ModelErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.warn('[Viewer3D] Failed to load model:', error.message, info.componentStack)
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false })
    }
  }

  render(): ReactNode {
    return this.state.hasError ? this.props.fallback : this.props.children
  }
}

function ModelLoadError(): JSX.Element {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-600 pointer-events-none">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="12" cy="12" r="10" />
        <line x1="15" y1="9" x2="9" y2="15" />
        <line x1="9" y1="9" x2="15" y2="15" />
      </svg>
      <p className="mt-3 text-sm">Model file not found</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// MeshModel
// ---------------------------------------------------------------------------

interface MeshModelProps {
  url: string
  jobId: string
  viewMode: ViewMode
  selected: boolean
  onStats: (stats: { vertices: number; triangles: number }) => void
  onSelect: () => void
  onObject: (obj: THREE.Object3D | null) => void
  onClips: (clips: MotionClip[]) => void
  clipIndex: number
}

function MeshModel({ url, jobId, viewMode, selected, onStats, onSelect, onObject, onClips, clipIndex }: MeshModelProps): JSX.Element {
  const extension = url.split('?')[0]?.split('.').pop()?.toLowerCase()
  const common = { url, jobId, viewMode, selected, onStats, onSelect, onObject, onClips, clipIndex }
  return extension === 'obj' ? <ObjMeshModel {...common} /> : <GltfMeshModel {...common} />
}

function GltfMeshModel(props: MeshModelProps): JSX.Element {
  const gltf = useGLTF(props.url)
  const { scene, animations } = gltf
  const mixerRef  = useRef<THREE.AnimationMixer | null>(null)
  const actionRef = useRef<THREE.AnimationAction | null>(null)
  const { onClips, clipIndex } = props

  // Rigged models arrive with one or more clips; without a mixer they render
  // frozen in bind pose, which reads as "the rig failed". The mixer lives for
  // as long as this model does — clip switches below reuse it.
  useEffect(() => {
    if (!animations?.length) {
      mixerRef.current = null
      actionRef.current = null
      return
    }
    const mixer = new THREE.AnimationMixer(scene)
    mixerRef.current = mixer
    return () => {
      mixer.stopAllAction()
      mixer.uncacheRoot(scene)
      mixerRef.current = null
      actionRef.current = null
    }
  }, [scene, animations])

  // Tell the viewer which clips are available so it can render the motion bar.
  useEffect(() => {
    onClips(animations?.map((clip) => ({ name: clip.name })) ?? [])
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onClips is a stable callback
  }, [animations])

  // Switch to the selected clip, cross-fading so playback never hard-cuts.
  useEffect(() => {
    const mixer = mixerRef.current
    if (!mixer || !animations?.length) return
    const clip = animations[Math.min(clipIndex, animations.length - 1)]
    const next = mixer.clipAction(clip)
    next.reset().setLoop(THREE.LoopRepeat, Infinity)
    const prev = actionRef.current
    if (prev && prev !== next) {
      prev.fadeOut(0.25)
      next.fadeIn(0.25).play()
    } else {
      next.play()
    }
    actionRef.current = next
  }, [animations, clipIndex])

  useFrame((_state, delta) => mixerRef.current?.update(delta))

  return <SceneMeshModel {...props} scene={scene} loaderType="gltf" />
}

function ObjMeshModel(props: MeshModelProps): JSX.Element {
  const scene = useLoader(OBJLoader, props.url)
  return <SceneMeshModel {...props} scene={scene} loaderType="obj" />
}

function SceneMeshModel({
  url,
  viewMode,
  selected,
  onStats,
  onSelect,
  onObject,
  scene,
  loaderType,
}: MeshModelProps & {
  scene: THREE.Group | THREE.Scene
  loaderType: 'gltf' | 'obj'
}): JSX.Element {
  const captured = useRef(false)
  const edgeHelpers = useRef<THREE.LineSegments[]>([])

  // Expose the scene object so Viewer3D can attach the transform gizmo to it.
  useEffect(() => {
    onObject(scene)
    return () => onObject(null)
  }, [scene, onObject])

  // Free GPU resources and loader cache when this model is replaced or unmounted
  useEffect(() => {
    return () => {
      if (loaderType === 'obj') {
        useLoader.clear(OBJLoader, url)
      } else {
        useGLTF.clear(url)
      }
      scene.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose()
          const materials = Array.isArray(child.material) ? child.material : [child.material]
          materials.forEach((m: THREE.Material) => m.dispose())
        }
      })
    }
  }, [loaderType, scene, url])

  // Compute BVH on all geometries for fast raycasting (O(log N) vs O(N)).
  // Also force DoubleSide on every material so faces with inverted normals
  // (a known artifact of the flexible-dual-grid mesh decoder) are still visible.
  useEffect(() => {
    scene.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        (child.geometry as any).computeBoundsTree()
        const mats = Array.isArray(child.material) ? child.material : [child.material]
        mats.forEach((m: THREE.Material) => { m.side = THREE.DoubleSide })
      }
    })
    return () => {
      scene.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          (child.geometry as any).disposeBoundsTree?.()
        }
      })
    }
  }, [scene])

  // Centre the mesh on the grid. Runs only on first load / model change — never
  // on plain re-renders, so a live gizmo transform is not silently overwritten.
  useEffect(() => {
    // Clear any cached transform before measuring (useGLTF may reuse a scene
    // that still carries an earlier gizmo pose).
    scene.position.set(0, 0, 0)
    scene.rotation.set(0, 0, 0)
    scene.scale.set(1, 1, 1)
    const box = new THREE.Box3().setFromObject(scene)
    const center = new THREE.Vector3()
    box.getCenter(center)
    scene.position.set(-center.x, -box.min.y, -center.z)

    // Compute stats
    let vertices = 0
    let triangles = 0
    scene.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        vertices += child.geometry.attributes.position?.count ?? 0
        triangles += child.geometry.index
          ? child.geometry.index.count / 3
          : (child.geometry.attributes.position?.count ?? 0) / 3
      }
    })
    const roundedTriangles = Math.round(triangles)
    onStats({ vertices: Math.round(vertices), triangles: roundedTriangles })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recompute on scene change only; onStats is a stable callback
  }, [scene])

  // Thumbnail capture (kept for future use)
  useEffect(() => {
    captured.current = false
  }, [url])

  // Material swapping based on viewMode
  useEffect(() => {
    // Remove any edge helpers from previous wireframe pass
    edgeHelpers.current.forEach((lines) => lines.parent?.remove(lines))
    edgeHelpers.current = []

    scene.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return

      // Save original material on first visit
      if (!child.userData.originalMaterial) {
        child.userData.originalMaterial = child.material
      }

      let next: THREE.Material
      switch (viewMode) {
        case 'wireframe': {
          next = new THREE.MeshBasicMaterial({ color: 0x4ade80, wireframe: true })
          break
        }
        case 'normals':
          // Ensure vertex normals exist — AI-generated meshes often skip this
          child.geometry.computeVertexNormals()
          next = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide })
          break
        case 'matcap':
          next = new THREE.MeshMatcapMaterial({ matcap: createMatcapTexture() })
          break
        case 'uv':
          next = new THREE.MeshBasicMaterial({ map: createCheckerTexture() })
          break
        default:
          next = child.userData.originalMaterial as THREE.Material
      }

      child.material = next
    })
  }, [scene, viewMode])

  return (
    <Select enabled={selected}>
      <primitive
        object={scene}
        onClick={(e: { stopPropagation: () => void }) => { e.stopPropagation(); onSelect() }}
      />
    </Select>
  )

}

// ---------------------------------------------------------------------------
// Orientation gizmo — coloured bubbles only (X/Y/Z)
// ---------------------------------------------------------------------------

function makeAxisLabelTexture(letter: string, bg: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 64
  const ctx = canvas.getContext('2d')!
  ctx.beginPath()
  ctx.arc(32, 32, 16, 0, 2 * Math.PI)
  ctx.closePath()
  ctx.fillStyle = bg
  ctx.fill()
  ctx.font = '18px Arial, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillStyle = '#ffffff'
  ctx.fillText(letter, 32, 41)
  return new THREE.CanvasTexture(canvas)
}

const GIZMO_AXES: {
  letter: string
  color: string
  pos: [number, number, number]
  lineRotation: [number, number, number]
}[] = [
  { letter: 'X', color: '#f87171', pos: [1, 0, 0], lineRotation: [0, 0, 0] },
  { letter: 'Y', color: '#4ade80', pos: [0, 1, 0], lineRotation: [0, 0, Math.PI / 2] },
  { letter: 'Z', color: '#60a5fa', pos: [0, 0, 1], lineRotation: [0, -Math.PI / 2, 0] },
]

function AxisLine({ color, rotation }: { color: string; rotation: [number, number, number] }) {
  return (
    <group rotation={rotation}>
      <mesh position={[0.4, 0, 0]}>
        <boxGeometry args={[0.8, 0.05, 0.05]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>
    </group>
  )
}

function AxisBubble({ letter, color, pos }: { letter: string; color: string; pos: [number, number, number] }) {
  const { tweenCamera } = useGizmoContext()
  const texture = useMemo(() => makeAxisLabelTexture(letter, color), [letter, color])
  const [hovered, setHovered] = useState(false)

  return (
    <sprite
      position={pos}
      scale={hovered ? 1.2 : 1}
      onPointerDown={(e) => { tweenCamera(e.object.position); e.stopPropagation() }}
      onPointerOver={(e) => { e.stopPropagation(); setHovered(true) }}
      onPointerOut={() => setHovered(false)}
    >
      <spriteMaterial map={texture} alphaTest={0.3} toneMapped={false} />
    </sprite>
  )
}

function GizmoBubbles() {
  return (
    <group scale={40}>
      {GIZMO_AXES.map((axis) => (
        <AxisLine key={`line-${axis.letter}`} color={axis.color} rotation={axis.lineRotation} />
      ))}
      {GIZMO_AXES.map((axis) => (
        <AxisBubble key={axis.letter} {...axis} />
      ))}
    </group>
  )
}

// ---------------------------------------------------------------------------
// Transform gizmos — custom move / rotate / scale handles (shared style)
// ---------------------------------------------------------------------------

type GizmoAxis = 'x' | 'y' | 'z'
type TranslateHandleId = GizmoAxis | 'xy' | 'yz' | 'xz'
type ScaleHandleId = GizmoAxis | 'xyz'

const AXIS_COLORS: Record<GizmoAxis, string> = {
  x: '#f87171',
  y: '#4ade80',
  z: '#60a5fa',
}

const AXIS_DIR: Record<GizmoAxis, [number, number, number]> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
}

// Orient a +Y cylinder/cone/box onto each axis.
const AXIS_ROTATION: Record<GizmoAxis, [number, number, number]> = {
  x: [0, 0, -Math.PI / 2],
  y: [0, 0, 0],
  z: [Math.PI / 2, 0, 0],
}

// Orient a default-XY torus so its ring spins around each axis.
const RING_ROTATION: Record<GizmoAxis, [number, number, number]> = {
  x: [0, Math.PI / 2, 0],
  y: [Math.PI / 2, 0, 0],
  z: [0, 0, 0],
}

// Two-axis plane handles, coloured by their locked (normal) axis.
const PLANE_HANDLES: {
  id: 'xy' | 'yz' | 'xz'
  normal: [number, number, number]
  color: string
  position: [number, number, number]
  rotation: [number, number, number]
}[] = [
  { id: 'xy', normal: [0, 0, 1], color: AXIS_COLORS.z, position: [0.26, 0.26, 0], rotation: [0, 0, 0] },
  { id: 'yz', normal: [1, 0, 0], color: AXIS_COLORS.x, position: [0, 0.26, 0.26], rotation: [0, -Math.PI / 2, 0] },
  { id: 'xz', normal: [0, 1, 0], color: AXIS_COLORS.y, position: [0.26, 0, 0.26], rotation: [Math.PI / 2, 0, 0] },
]

const GIZMO_SCREEN_SIZE = 0.12

function lightenColor(hex: string, amount = 0.5): string {
  return '#' + new THREE.Color(hex).lerp(new THREE.Color('#ffffff'), amount).getHexString()
}

function intersectPlane(ray: THREE.Ray, origin: THREE.Vector3, normal: THREE.Vector3): THREE.Vector3 | null {
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin)
  const hit = new THREE.Vector3()
  return ray.intersectPlane(plane, hit) ? hit : null
}

// Shared plumbing: follow the object, keep a constant on-screen size, and run
// the pointer-drag lifecycle (window listeners + OrbitControls locking).
function useGizmoBase(object: THREE.Object3D) {
  const camera = useThree((s) => s.camera)
  const gl = useThree((s) => s.gl)
  const raycaster = useThree((s) => s.raycaster)
  const controls = useThree((s) => s.controls) as { enabled: boolean } | null

  const groupRef = useRef<THREE.Group>(null)
  const ndc = useRef(new THREE.Vector2())
  const moveRef = useRef<((ev: PointerEvent) => void) | null>(null)
  const endRef = useRef<(() => void) | null>(null)

  useFrame(() => {
    const g = groupRef.current
    if (!g) return
    object.getWorldPosition(g.position)
    g.scale.setScalar(Math.max(camera.position.distanceTo(g.position) * GIZMO_SCREEN_SIZE, 0.001))
  })

  const pointerRay = useCallback((ev: PointerEvent): THREE.Ray => {
    const rect = gl.domElement.getBoundingClientRect()
    ndc.current.set(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1,
    )
    raycaster.setFromCamera(ndc.current, camera)
    return raycaster.ray
  }, [camera, gl, raycaster])

  const stop = useCallback(() => {
    if (!moveRef.current) return
    window.removeEventListener('pointermove', moveRef.current)
    window.removeEventListener('pointerup', stop)
    moveRef.current = null
    endRef.current?.()
    endRef.current = null
    if (controls) controls.enabled = true
    gl.domElement.style.cursor = ''
  }, [controls, gl])

  const start = useCallback((onMove: (ev: PointerEvent) => void, onEnd?: () => void) => {
    moveRef.current = onMove
    endRef.current = onEnd ?? null
    if (controls) controls.enabled = false
    gl.domElement.style.cursor = 'grabbing'
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', stop)
  }, [controls, gl, stop])

  useEffect(() => stop, [stop])  // release the drag if unmounted mid-interaction

  return { camera, groupRef, pointerRay, start }
}

function hoverHandlers<T extends string>(
  id: T,
  setHovered: (value: T | null) => void,
  onDown: (e: ThreeEvent<PointerEvent>) => void,
) {
  return {
    onPointerOver: (e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); setHovered(id) },
    onPointerOut: () => setHovered(null),
    onPointerDown: onDown,
  }
}

function GizmoArrow({ color, active }: { color: string; active: boolean }): JSX.Element {
  const tint = active ? lightenColor(color) : color
  return (
    <group>
      {/* Invisible, fat hit target spanning the whole arm */}
      <mesh position={[0, 0.55, 0]}>
        <cylinderGeometry args={[0.09, 0.09, 1.1, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      {/* Shaft */}
      <mesh position={[0, 0.48, 0]} renderOrder={999}>
        <cylinderGeometry args={[0.014, 0.014, 0.66, 16]} />
        <meshBasicMaterial color={tint} toneMapped={false} transparent depthTest={false} depthWrite={false} />
      </mesh>
      {/* Arrowhead */}
      <mesh position={[0, 0.9, 0]} renderOrder={999}>
        <coneGeometry args={[0.055, 0.2, 20]} />
        <meshBasicMaterial color={tint} toneMapped={false} transparent depthTest={false} depthWrite={false} />
      </mesh>
    </group>
  )
}

function GizmoScaleArm({ color, active }: { color: string; active: boolean }): JSX.Element {
  const tint = active ? lightenColor(color) : color
  return (
    <group>
      {/* Invisible, fat hit target — starts above the centre cube so a
          centre click hits the uniform-scale handle, not an axis */}
      <mesh position={[0, 0.6, 0]}>
        <cylinderGeometry args={[0.09, 0.09, 0.8, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      {/* Shaft */}
      <mesh position={[0, 0.42, 0]} renderOrder={999}>
        <cylinderGeometry args={[0.014, 0.014, 0.7, 16]} />
        <meshBasicMaterial color={tint} toneMapped={false} transparent depthTest={false} depthWrite={false} />
      </mesh>
      {/* Cube head */}
      <mesh position={[0, 0.84, 0]} renderOrder={999}>
        <boxGeometry args={[0.11, 0.11, 0.11]} />
        <meshBasicMaterial color={tint} toneMapped={false} transparent depthTest={false} depthWrite={false} />
      </mesh>
    </group>
  )
}

function GizmoRing({ color, active }: { color: string; active: boolean }): JSX.Element {
  const tint = active ? lightenColor(color) : color
  return (
    <group>
      {/* Invisible, fat hit target */}
      <mesh>
        <torusGeometry args={[0.9, 0.06, 8, 48]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <mesh renderOrder={999}>
        <torusGeometry args={[0.9, 0.012, 12, 64]} />
        <meshBasicMaterial color={tint} toneMapped={false} transparent depthTest={false} depthWrite={false} />
      </mesh>
    </group>
  )
}

function GizmoPlane({ color, active }: { color: string; active: boolean }): JSX.Element {
  return (
    <mesh renderOrder={998}>
      <planeGeometry args={[0.26, 0.26]} />
      <meshBasicMaterial
        color={active ? lightenColor(color) : color}
        transparent
        opacity={active ? 0.6 : 0.28}
        side={THREE.DoubleSide}
        toneMapped={false}
        depthTest={false}
        depthWrite={false}
      />
    </mesh>
  )
}

function TranslateGizmo({ object, onDragStart, onDragEnd }: { object: THREE.Object3D; onDragStart?: () => void; onDragEnd?: () => void }): JSX.Element {
  const { camera, groupRef, pointerRay, start } = useGizmoBase(object)
  const [hovered, setHovered] = useState<TranslateHandleId | null>(null)
  const [activeId, setActiveId] = useState<TranslateHandleId | null>(null)
  const drag = useRef<{
    axisDir: THREE.Vector3 | null
    planeNormal: THREE.Vector3
    origin: THREE.Vector3
    startHit: THREE.Vector3
    startPos: THREE.Vector3
  } | null>(null)

  const beginDrag = useCallback((id: TranslateHandleId, e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    const origin = new THREE.Vector3()
    object.getWorldPosition(origin)
    const startPos = object.position.clone()

    let axisDir: THREE.Vector3 | null = null
    let planeNormal: THREE.Vector3
    if (id === 'x' || id === 'y' || id === 'z') {
      axisDir = new THREE.Vector3(...AXIS_DIR[id])
      // Drag plane: contains the axis and faces the camera as much as possible.
      const view = new THREE.Vector3().subVectors(camera.position, origin)
      planeNormal = view.sub(axisDir.clone().multiplyScalar(view.dot(axisDir)))
      if (planeNormal.lengthSq() < 1e-6) planeNormal.set(axisDir.y ? 1 : 0, axisDir.y ? 0 : 1, 0)
      planeNormal.normalize()
    } else {
      planeNormal = new THREE.Vector3(...PLANE_HANDLES.find((p) => p.id === id)!.normal)
    }

    const startHit = intersectPlane(e.ray, origin, planeNormal)
    if (!startHit) return
    drag.current = { axisDir, planeNormal, origin, startHit, startPos }
    setActiveId(id)
    onDragStart?.()
    start((ev) => {
      const d = drag.current
      if (!d) return
      const hit = intersectPlane(pointerRay(ev), d.origin, d.planeNormal)
      if (!hit) return
      const delta = new THREE.Vector3().subVectors(hit, d.startHit)
      if (d.axisDir) {
        object.position.copy(d.startPos).addScaledVector(d.axisDir, delta.dot(d.axisDir))
      } else {
        object.position.copy(d.startPos).add(delta)
      }
    }, () => { drag.current = null; setActiveId(null); onDragEnd?.() })
  }, [object, camera, pointerRay, start, onDragStart, onDragEnd])

  return (
    <group ref={groupRef} renderOrder={999}>
      {/* Central origin handle (decorative — never blocks picking) */}
      <mesh raycast={() => null} renderOrder={999}>
        <sphereGeometry args={[0.05, 20, 20]} />
        <meshBasicMaterial color="#e4e4e7" toneMapped={false} transparent depthTest={false} depthWrite={false} />
      </mesh>

      {(['x', 'y', 'z'] as GizmoAxis[]).map((axis) => (
        <group key={axis} rotation={AXIS_ROTATION[axis]} {...hoverHandlers<TranslateHandleId>(axis, setHovered, (e) => beginDrag(axis, e))}>
          <GizmoArrow color={AXIS_COLORS[axis]} active={hovered === axis || activeId === axis} />
        </group>
      ))}

      {PLANE_HANDLES.map((plane) => (
        <group key={plane.id} position={plane.position} rotation={plane.rotation} {...hoverHandlers<TranslateHandleId>(plane.id, setHovered, (e) => beginDrag(plane.id, e))}>
          <GizmoPlane color={plane.color} active={hovered === plane.id || activeId === plane.id} />
        </group>
      ))}
    </group>
  )
}

function RotateGizmo({ object, onDragStart, onDragEnd }: { object: THREE.Object3D; onDragStart?: () => void; onDragEnd?: () => void }): JSX.Element {
  const { groupRef, pointerRay, start } = useGizmoBase(object)
  const [hovered, setHovered] = useState<GizmoAxis | null>(null)
  const [activeId, setActiveId] = useState<GizmoAxis | null>(null)
  const drag = useRef<{
    axisDir: THREE.Vector3
    origin: THREE.Vector3
    startVec: THREE.Vector3
    startQuat: THREE.Quaternion
  } | null>(null)

  const beginDrag = useCallback((axis: GizmoAxis, e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    const origin = new THREE.Vector3()
    object.getWorldPosition(origin)
    const axisDir = new THREE.Vector3(...AXIS_DIR[axis]).normalize()
    // Rotation happens in the plane perpendicular to the axis (the ring's plane).
    const startHit = intersectPlane(e.ray, origin, axisDir)
    if (!startHit) return
    const startVec = new THREE.Vector3().subVectors(startHit, origin)
    if (startVec.lengthSq() < 1e-9) return
    drag.current = { axisDir, origin, startVec, startQuat: object.quaternion.clone() }
    setActiveId(axis)
    onDragStart?.()
    start((ev) => {
      const d = drag.current
      if (!d) return
      const hit = intersectPlane(pointerRay(ev), d.origin, d.axisDir)
      if (!hit) return
      const cur = new THREE.Vector3().subVectors(hit, d.origin)
      // Signed angle between the start and current vectors, around the axis.
      const cross = new THREE.Vector3().crossVectors(d.startVec, cur)
      const angle = Math.atan2(cross.dot(d.axisDir), d.startVec.dot(cur))
      const q = new THREE.Quaternion().setFromAxisAngle(d.axisDir, angle)
      object.quaternion.copy(d.startQuat).premultiply(q)
    }, () => { drag.current = null; setActiveId(null); onDragEnd?.() })
  }, [object, pointerRay, start, onDragStart, onDragEnd])

  return (
    <group ref={groupRef} renderOrder={999}>
      {(['x', 'y', 'z'] as GizmoAxis[]).map((axis) => (
        <group key={axis} rotation={RING_ROTATION[axis]} {...hoverHandlers<GizmoAxis>(axis, setHovered, (e) => beginDrag(axis, e))}>
          <GizmoRing color={AXIS_COLORS[axis]} active={hovered === axis || activeId === axis} />
        </group>
      ))}
    </group>
  )
}

function ScaleGizmo({ object, onDragStart, onDragEnd }: { object: THREE.Object3D; onDragStart?: () => void; onDragEnd?: () => void }): JSX.Element {
  const { camera, groupRef, pointerRay, start } = useGizmoBase(object)
  const [hovered, setHovered] = useState<ScaleHandleId | null>(null)
  const [activeId, setActiveId] = useState<ScaleHandleId | null>(null)
  const drag = useRef<{
    axisDir: THREE.Vector3 | null
    planeNormal: THREE.Vector3
    origin: THREE.Vector3
    startProj: number
    startScale: THREE.Vector3
    armLength: number
  } | null>(null)

  const beginDrag = useCallback((id: ScaleHandleId, e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    const origin = new THREE.Vector3()
    object.getWorldPosition(origin)
    // World length of one local unit — maps drag distance to a sensible factor.
    const armLength = Math.max(groupRef.current?.scale.x ?? 1, 1e-4)

    let axisDir: THREE.Vector3 | null = null
    let planeNormal: THREE.Vector3
    if (id === 'xyz') {
      planeNormal = new THREE.Vector3().subVectors(camera.position, origin).normalize()
    } else {
      axisDir = new THREE.Vector3(...AXIS_DIR[id])
      const view = new THREE.Vector3().subVectors(camera.position, origin)
      planeNormal = view.sub(axisDir.clone().multiplyScalar(view.dot(axisDir)))
      if (planeNormal.lengthSq() < 1e-6) planeNormal.set(axisDir.y ? 1 : 0, axisDir.y ? 0 : 1, 0)
      planeNormal.normalize()
    }

    const startHit = intersectPlane(e.ray, origin, planeNormal)
    if (!startHit) return
    const startRel = new THREE.Vector3().subVectors(startHit, origin)
    const startProj = axisDir ? startRel.dot(axisDir) : startRel.length()
    drag.current = { axisDir, planeNormal, origin, startProj, startScale: object.scale.clone(), armLength }
    setActiveId(id)
    onDragStart?.()
    start((ev) => {
      const d = drag.current
      if (!d) return
      const hit = intersectPlane(pointerRay(ev), d.origin, d.planeNormal)
      if (!hit) return
      const rel = new THREE.Vector3().subVectors(hit, d.origin)
      const proj = d.axisDir ? rel.dot(d.axisDir) : rel.length()
      const factor = Math.max(0.01, 1 + (proj - d.startProj) / d.armLength)
      if (d.axisDir) {
        const s = d.startScale.clone()
        if (d.axisDir.x) s.x = Math.max(0.01, d.startScale.x * factor)
        if (d.axisDir.y) s.y = Math.max(0.01, d.startScale.y * factor)
        if (d.axisDir.z) s.z = Math.max(0.01, d.startScale.z * factor)
        object.scale.copy(s)
      } else {
        object.scale.copy(d.startScale).multiplyScalar(factor)
      }
    }, () => { drag.current = null; setActiveId(null); onDragEnd?.() })
  }, [object, camera, pointerRay, start, groupRef, onDragStart, onDragEnd])

  const uniformActive = hovered === 'xyz' || activeId === 'xyz'

  return (
    <group ref={groupRef} renderOrder={999}>
      {/* Central cube — uniform scale */}
      <mesh {...hoverHandlers<ScaleHandleId>('xyz', setHovered, (e) => beginDrag('xyz', e))} renderOrder={999}>
        <boxGeometry args={[0.12, 0.12, 0.12]} />
        <meshBasicMaterial color={uniformActive ? lightenColor('#e4e4e7') : '#e4e4e7'} toneMapped={false} transparent depthTest={false} depthWrite={false} />
      </mesh>

      {(['x', 'y', 'z'] as GizmoAxis[]).map((axis) => (
        <group key={axis} rotation={AXIS_ROTATION[axis]} {...hoverHandlers<ScaleHandleId>(axis, setHovered, (e) => beginDrag(axis, e))}>
          <GizmoScaleArm color={AXIS_COLORS[axis]} active={hovered === axis || activeId === axis} />
        </group>
      ))}
    </group>
  )
}

// ---------------------------------------------------------------------------
// EmptyState
// ---------------------------------------------------------------------------

function EmptyState(): JSX.Element {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-700 pointer-events-none">
      <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="0.75">
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
      </svg>
      <p className="mt-4 text-sm">3D model will appear here</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Viewer3D
// ---------------------------------------------------------------------------

type TransformSnapshot = { p: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3 }

export default function Viewer3D({ lightSettings = DEFAULT_LIGHT_SETTINGS, gizmoMode = null, gizmoUndoRef }: { lightSettings?: LightSettings; gizmoMode?: GizmoMode | null; gizmoUndoRef?: MutableRefObject<(() => boolean) | null> }): JSX.Element {
  const { currentJob } = useGeneration()
  const apiUrl = useAppStore((s) => s.apiUrl)

  const setStoreMeshStats = useAppStore((s) => s.setMeshStats)
  const meshStats = useAppStore((s) => s.meshStats)
  const setCurrentJob = useAppStore((s) => s.setCurrentJob)

  const [viewMode, setViewMode] = useState<ViewMode>('solid')
  const [autoRotate, setAutoRotate] = useState(false)
  const clips = useAppStore((s) => s.motionClips)
  const activeClipIndex = useAppStore((s) => s.activeClipIndex)
  const setStoreMotionClips = useAppStore((s) => s.setMotionClips)
  const setStoreActiveClipIndex = useAppStore((s) => s.setActiveClipIndex)
  // Playback and every selector share appStore. Keeping a local mirror here
  // made the Library tile and motion bar disagree about the active clip.
  const setClips = useCallback((c: MotionClip[]) => {
    setStoreMotionClips(c)
    const currentIndex = useAppStore.getState().activeClipIndex
    if (currentIndex >= c.length) setStoreActiveClipIndex(0)
  }, [setStoreActiveClipIndex, setStoreMotionClips])
  const setActiveClipIndex = useCallback((i: number) => {
    setStoreActiveClipIndex(i)
  }, [setStoreActiveClipIndex])
  const selected = useAppStore((s) => s.meshSelected)
  const setSelected = useAppStore((s) => s.setMeshSelected)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const splatRef = useRef<SplatViewerHandle | null>(null)

  const [meshObject, setMeshObject] = useState<THREE.Object3D | null>(null)

  // Local gizmo-transform history (live TRS), undoable with Ctrl+Z. A snapshot
  // is taken when a drag starts and committed on release only if it changed.
  const transformHistory = useRef<TransformSnapshot[]>([])
  const pendingTransform = useRef<TransformSnapshot | null>(null)

  const outputUrl = currentJob?.outputUrl ?? ''
  const modelUrl =
    currentJob?.status === 'done' && currentJob.outputUrl
      ? `${apiUrl}${currentJob.outputUrl}`
      : null

  // A .ply/.splat reaching the viewer is always a Gaussian splat here: mesh
  // plys are converted to GLB on import and workflow mesh outputs are .glb.
  const isSplat = /\.(ply|splat)$/i.test(outputUrl)

  // The splat viewer needs binary .splat — route raw workspace .ply through the
  // conversion endpoint; import URLs already point at a .splat via serve-file.
  const splatUrl = outputUrl.startsWith('/workspace/')
    ? `${apiUrl}/optimize/ply-to-splat?path=${encodeURIComponent(outputUrl.slice('/workspace/'.length))}`
    : modelUrl

  // Reset view state when model changes
  useEffect(() => {
    setSelected(false)
    setViewMode('solid')
    setStoreMeshStats(null)
    setClips([])
    setActiveClipIndex(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when the model changes; setters are stable
  }, [modelUrl])

  // Clear the shared selection when the viewer unmounts — the store would
  // otherwise keep it set and flash a stale selection on the next mount.
  useEffect(() => () => setSelected(false), [setSelected])

  // Delete key removes the model from the scene
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Delete') return
      if (document.activeElement instanceof HTMLInputElement) return
      if (!selected) return
      setCurrentJob(null)
      setSelected(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setSelected is a stable store setter
  }, [selected, setCurrentJob])

  const handleScreenshot = () => {
    const dataUrl = isSplat
      ? splatRef.current?.screenshot() ?? null
      : canvasRef.current?.toDataURL('image/png') ?? null
    if (!dataUrl) return
    const link = document.createElement('a')
    link.download = `modly-${Date.now()}.png`
    link.href = dataUrl
    link.click()
  }

  // Snapshot the pre-drag pose when a gizmo manipulation starts.
  const handleGizmoDragStart = useCallback(() => {
    if (meshObject) {
      pendingTransform.current = {
        p: meshObject.position.clone(),
        q: meshObject.quaternion.clone(),
        s: meshObject.scale.clone(),
      }
    }
  }, [meshObject])

  // Commit the snapshot on release, but only if the pose actually changed.
  const handleGizmoDragEnd = useCallback(() => {
    const before = pendingTransform.current
    pendingTransform.current = null
    if (!before || !meshObject) return
    const changed = !meshObject.position.equals(before.p)
      || !meshObject.quaternion.equals(before.q)
      || !meshObject.scale.equals(before.s)
    if (changed) transformHistory.current.push(before)
  }, [meshObject])

  // Revert the most recent gizmo manipulation. Returns false when there is
  // nothing to undo, so the caller can fall back to the mesh-history undo.
  const undoTransform = useCallback((): boolean => {
    const prev = transformHistory.current.pop()
    if (!prev || !meshObject) return false
    meshObject.position.copy(prev.p)
    meshObject.quaternion.copy(prev.q)
    meshObject.scale.copy(prev.s)
    return true
  }, [meshObject])

  // Expose transform-undo so the page's Ctrl+Z undoes gizmo edits first.
  useEffect(() => {
    if (!gizmoUndoRef) return
    gizmoUndoRef.current = undoTransform
    return () => { if (gizmoUndoRef.current === undoTransform) gizmoUndoRef.current = null }
  }, [gizmoUndoRef, undoTransform])

  // Drop the transform history when the model changes.
  useEffect(() => {
    transformHistory.current = []
    pendingTransform.current = null
  }, [modelUrl])

  // Memoise the post-processing stack so its children stay referentially stable.
  // @react-three/postprocessing rebuilds (recompiles) all EffectPasses whenever the
  // <EffectComposer> children identity changes; without this, every Viewer3D re-render
  // (e.g. dragging a Lighting slider) recompiles the outline shader. The Outline still
  // tracks selection through the <Selection> context, so nothing here needs to depend
  // on render state.
  const postProcessing = useMemo(() => (
    <EffectComposer
      autoClear={false}
      multisampling={SELECTION_OUTLINE_MULTISAMPLING}
      resolutionScale={SELECTION_OUTLINE_RESOLUTION_SCALE}
      frameBufferType={THREE.HalfFloatType}
    >
      <Outline
        blur={SELECTION_OUTLINE_BLUR}
        edgeStrength={SELECTION_OUTLINE_EDGE_STRENGTH}
        visibleEdgeColor={SELECTION_OUTLINE_VISIBLE_COLOR}
        hiddenEdgeColor={SELECTION_OUTLINE_HIDDEN_COLOR}
        xRay={false}
      />
    </EffectComposer>
  ), [])


  return (
    <ModelErrorBoundary resetKey={modelUrl} fallback={<ModelLoadError />}>
      <div className="relative w-full h-full bg-surface-400">
        {!modelUrl && <EmptyState />}

        {/* Splat path → fully isolated viewer (mkkellogg, outside R3F) */}
        {modelUrl && isSplat && splatUrl ? (
          <SplatViewer ref={splatRef} url={splatUrl} autoRotate={autoRotate} />
        ) : null}

        {/* Mesh path → original Canvas, unchanged */}
        {!isSplat && (
        <Canvas
          onPointerMissed={() => setSelected(false)}
          camera={{ position: [0, 1.5, 4], fov: 45 }}
          dpr={[1, 2]}
          gl={{
            antialias: true,
            preserveDrawingBuffer: true,
            outputColorSpace: THREE.SRGBColorSpace,
          }}
        >
          <color attach="background" args={['#18181b']} />
          <CanvasCapture domRef={canvasRef} />
          <ambientLight intensity={lightSettings.ambientIntensity ?? DEFAULT_LIGHT_SETTINGS.ambientIntensity} />
          <Environment background={false}>
            <Lightformer intensity={2 * (lightSettings.envIntensity ?? DEFAULT_LIGHT_SETTINGS.envIntensity)} position={[0, 4, 4]} scale={8} />
            <Lightformer intensity={0.5 * (lightSettings.envIntensity ?? DEFAULT_LIGHT_SETTINGS.envIntensity)} position={[-4, 2, -4]} scale={6} />
            <Lightformer intensity={0.3 * (lightSettings.envIntensity ?? DEFAULT_LIGHT_SETTINGS.envIntensity)} position={[4, 1, -4]} scale={6} />
          </Environment>

          <gridHelper args={[10, 20, '#3f3f46', '#27272a']} />

          {modelUrl && currentJob ? (
            <Selection enabled={selected}>
              {postProcessing}
              <Suspense fallback={null}>
                <directionalLight position={[5, 8, 5]} color={lightSettings.mainColor} intensity={lightSettings.mainIntensity} castShadow />
                <directionalLight position={[-4, 2, -4]} color={lightSettings.fillColor} intensity={lightSettings.fillIntensity} />
                <MeshModel
                  url={modelUrl}
                  jobId={currentJob.id}
                  viewMode={viewMode}
                  selected={selected}
                  onStats={setStoreMeshStats}
                  onSelect={() => setSelected(true)}
                  onObject={setMeshObject}
                  onClips={setClips}
                  clipIndex={activeClipIndex}
                />
              </Suspense>
            </Selection>
          ) : null}

          {selected && meshObject && gizmoMode === 'translate' && (
            <TranslateGizmo object={meshObject} onDragStart={handleGizmoDragStart} onDragEnd={handleGizmoDragEnd} />
          )}
          {selected && meshObject && gizmoMode === 'rotate' && (
            <RotateGizmo object={meshObject} onDragStart={handleGizmoDragStart} onDragEnd={handleGizmoDragEnd} />
          )}
          {selected && meshObject && gizmoMode === 'scale' && (
            <ScaleGizmo object={meshObject} onDragStart={handleGizmoDragStart} onDragEnd={handleGizmoDragEnd} />
          )}

          <OrbitControls
            makeDefault
            enablePan
            enableZoom
            enableRotate
            minDistance={0.5}
            maxDistance={20}
            autoRotate={autoRotate}
            autoRotateSpeed={1.5}
            enableDamping
            dampingFactor={0.05}
          />

          <GizmoHelper alignment="top-right" margin={[72, 72]} renderPriority={modelUrl && currentJob ? 2 : 0}>
            <GizmoBubbles />
          </GizmoHelper>
        </Canvas>
        )}

        {/* Left toolbar — visible only when a model is loaded */}
        {modelUrl && (
          <ViewerToolbar
            viewMode={viewMode}
            autoRotate={autoRotate}
            onViewMode={setViewMode}
            onAutoRotate={() => setAutoRotate((v) => !v)}
            onScreenshot={handleScreenshot}
            showViewModes={!isSplat}
          />
        )}

        {/* Bottom-left overlays — mesh stats and the motion bar */}
        {(meshStats || clips.length > 0) && (
          <div className="absolute bottom-4 left-4 flex flex-col items-start gap-2">
            {meshStats && (
              <p className="text-xs text-zinc-500 pointer-events-none">
                {meshStats.triangles.toLocaleString()} tri &bull; {meshStats.vertices.toLocaleString()} verts
              </p>
            )}
            <MotionBar clips={clips} activeIndex={activeClipIndex} onChange={setActiveClipIndex} />
          </div>
        )}

        {/* Bottom-right hint */}
        {modelUrl && (
          <div className="absolute bottom-4 right-4 pointer-events-none">
            <p className="text-xs text-zinc-600">
              {selected
                ? <>Click mesh to select &bull; <span className="text-zinc-500">Delete</span> to remove</>
                : 'Drag to rotate \u2022 Scroll to zoom'
              }
            </p>
          </div>
        )}
      </div>
    </ModelErrorBoundary>
  )
}

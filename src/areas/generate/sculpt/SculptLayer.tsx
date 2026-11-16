// Viewer side of sculpt mode, mounted next to a glTF model (one instance per
// model URL). Turns left-drags on the mesh into SculptMesh strokes, uploads the
// touched vertex ranges, draws the brush ring, and registers the session that
// commits the strokes back to the mesh file.
//
// Blender-like input: a left press that hits the mesh starts a stroke (orbit is
// suspended for it); a press on empty space, right/middle drag and the wheel
// still drive OrbitControls.

import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { useAppStore } from '@shared/stores/appStore'
import { useApi } from '@shared/hooks/useApi'
import { apiErrorMessage, meshPathFromUrl } from '../meshEditPanel'
import { SculptMesh } from './SculptMesh'
import type { BrushKind, BrushSettings, DirtyRegion, Vec3 } from './types'
import { useSculptStore, type SculptSession, type SculptStrokeEntry } from './sculptStore'
import {
  attributeUpdateRange,
  buildVertexPatch,
  mergeRange,
  pushStroke,
  redoStroke,
  sessionEndOutcome,
  toLocalRadius,
  undoStroke,
  worldRadius,
  type IndexRange,
  type VertexPatch,
} from './sculptLogic'

/** GLTFLoader's parser, reduced to what the commit needs. */
interface GltfParserLike {
  associations: Map<unknown, unknown>
}

interface SculptTarget {
  key: string
  /** A THREE.Mesh using the geometry: its glTF association names the primitive to patch. */
  mesh: THREE.Mesh
  geometry: THREE.BufferGeometry
  core: SculptMesh
  /** Vertex range touched since the last GPU upload. */
  pending: IndexRange | null
}

interface Stroke {
  target: SculptTarget
  mesh: THREE.Mesh
  kind: BrushKind
  /** Grab: camera-facing plane through the start point (world space). */
  plane: THREE.Plane | null
  /** Grab: surface normal at the start point (local space). */
  startNormal: Vec3
}

interface Drag {
  pointerId: number
  stroke: Stroke | null
  released: boolean
}

const RING_COLOR = '#a78bfa'
const Z_AXIS = new THREE.Vector3(0, 0, 1)

function vec(v: THREE.Vector3): Vec3 {
  return [v.x, v.y, v.z]
}

function isSculptable(obj: THREE.Object3D): obj is THREE.Mesh {
  const mesh = obj as THREE.Mesh & { isSkinnedMesh?: boolean; isInstancedMesh?: boolean }
  return mesh.isMesh === true
    && !mesh.isSkinnedMesh
    && !mesh.isInstancedMesh
    && !!mesh.geometry?.getAttribute('position')
    && !mesh.geometry.morphAttributes?.position?.length
}

/**
 * The geometry's attribute as a plain, non-normalized Float32 vec3 attribute,
 * so the sculpt core can mutate its array in place. Interleaved, quantized or
 * non-float data is copied into a fresh Float32BufferAttribute first.
 */
function float32Attribute(geometry: THREE.BufferGeometry, name: 'position' | 'normal'): THREE.BufferAttribute | null {
  const attr = geometry.getAttribute(name) as THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined
  if (!attr) return null
  const plain = !(attr as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute
    && attr.array instanceof Float32Array
    && !attr.normalized
    && attr.itemSize === 3
  if (plain) return attr as THREE.BufferAttribute
  const out = new Float32Array(attr.count * 3)
  for (let i = 0; i < attr.count; i++) {
    out[i * 3] = attr.getX(i)
    out[i * 3 + 1] = attr.getY(i)
    out[i * 3 + 2] = attr.getZ(i)
  }
  const fresh = new THREE.Float32BufferAttribute(out, 3)
  geometry.setAttribute(name, fresh)
  return fresh
}

function indexArray(geometry: THREE.BufferGeometry): Uint32Array | Uint16Array | null {
  const array = geometry.index?.array
  if (!array) return null
  if (array instanceof Uint32Array || array instanceof Uint16Array) return array
  return Uint32Array.from(array as ArrayLike<number>)
}

function createTarget(mesh: THREE.Mesh): SculptTarget {
  const geometry = mesh.geometry
  const position = float32Attribute(geometry, 'position')
  if (!position) throw new Error('This part has no vertex positions.')
  const normal = float32Attribute(geometry, 'normal')
  const core = new SculptMesh(
    position.array as Float32Array,
    normal ? normal.array as Float32Array : null,
    indexArray(geometry),
  )
  if (!normal) geometry.setAttribute('normal', new THREE.BufferAttribute(core.normals, 3))
  return { key: geometry.uuid, mesh, geometry, core, pending: null }
}

function uploadPending(target: SculptTarget): void {
  if (!target.pending) return
  const { start, count } = attributeUpdateRange(target.pending, 3)
  for (const name of ['position', 'normal'] as const) {
    const attr = target.geometry.getAttribute(name) as THREE.BufferAttribute | undefined
    if (!attr) continue
    attr.addUpdateRange(start, count)
    attr.needsUpdate = true
  }
  target.pending = null
}

/** BVH and bounds follow the moved vertices (end of a stroke, undo, redo). */
function refreshSpatialData(target: SculptTarget): void {
  const geometry = target.geometry as THREE.BufferGeometry & { boundsTree?: { refit: () => void } }
  geometry.boundsTree?.refit()
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
}

function markDirty(target: SculptTarget, region: DirtyRegion): void {
  target.pending = mergeRange(target.pending, { min: region.minIndex, max: region.maxIndex })
}

function errorText(err: unknown): string {
  return apiErrorMessage(err)
}

export default function SculptLayer({
  scene,
  parser,
  outputUrl,
}: {
  scene: THREE.Object3D
  parser: GltfParserLike
  /** Workspace URL of the mesh file (currentJob.outputUrl) these strokes apply to. */
  outputUrl: string
}): JSX.Element {
  const active = useSculptStore((s) => s.active)
  const camera = useThree((s) => s.camera)
  const gl = useThree((s) => s.gl)
  const controls = useThree((s) => s.controls) as { enabled: boolean } | null
  const { patchMeshVertices } = useApi()

  const targets = useRef(new Map<string, SculptTarget>())
  const drag = useRef<Drag | null>(null)
  const ringRef = useRef<THREE.Mesh>(null)
  const hoverNdc = useRef<THREE.Vector2 | null>(null)
  const diagonal = useRef<number | null>(null)
  const activeRef = useRef(active)
  activeRef.current = active

  // Latest values for the long-lived DOM listeners and session callbacks.
  const live = useRef({ camera, gl, controls, patchMeshVertices })
  live.current = { camera, gl, controls, patchMeshVertices }

  const raycaster = useMemo(() => {
    const r = new THREE.Raycaster() as THREE.Raycaster & { firstHitOnly?: boolean }
    r.firstHitOnly = true
    return r
  }, [])

  const meshes = useMemo(() => {
    const list: THREE.Mesh[] = []
    scene.traverse((obj) => { if (isSculptable(obj)) list.push(obj) })
    return list
  }, [scene])

  // Shared helpers, rebuilt only with the model.
  const api = useMemo(() => {
    const ndc = new THREE.Vector2()

    const setRay = (clientX: number, clientY: number): THREE.Ray => {
      const rect = live.current.gl.domElement.getBoundingClientRect()
      ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
      raycaster.setFromCamera(ndc, live.current.camera)
      return raycaster.ray
    }

    const hitTest = (objects: THREE.Object3D[]): THREE.Intersection<THREE.Mesh> | null => {
      const hits = raycaster.intersectObjects(objects, false) as THREE.Intersection<THREE.Mesh>[]
      return hits.find((h) => h.object.visible && h.face) ?? null
    }

    const modelDiagonal = (): number => {
      if (diagonal.current === null) {
        diagonal.current = new THREE.Box3().setFromObject(scene).getSize(new THREE.Vector3()).length()
      }
      return diagonal.current
    }

    const localRadius = (mesh: THREE.Mesh, kind: BrushKind): number => {
      const { brushes } = useSculptStore.getState()
      mesh.updateWorldMatrix(true, false)
      return toLocalRadius(worldRadius(brushes[kind].radius, modelDiagonal()), mesh.matrixWorld.getMaxScaleOnAxis())
    }

    const reportError = (prefix: string, err: unknown) => {
      console.warn(`[Sculpt] ${prefix}:`, err)
      useSculptStore.getState().setError(`${prefix}: ${errorText(err)}`)
    }

    const setOrbit = (enabled: boolean) => {
      if (live.current.controls) live.current.controls.enabled = enabled
    }

    const startStroke = (target: SculptTarget, hit: THREE.Intersection<THREE.Mesh>, ev: PointerEvent): Stroke | null => {
      const state = useSculptStore.getState()
      // Shift held = smooth, whatever the brush (as in Blender).
      const kind: BrushKind = ev.shiftKey ? 'smooth' : state.brush
      const mesh = hit.object
      const settings: BrushSettings = {
        kind,
        radius: localRadius(mesh, kind),
        strength: state.brushes[kind].strength,
        invert: ev.ctrlKey || ev.metaKey,
        symmetry: [...state.symmetry],
      }
      const point = mesh.worldToLocal(hit.point.clone())
      const normal = hit.face!.normal.clone()
      try {
        markDirty(target, target.core.beginStroke(settings, vec(point), vec(normal)))
      } catch (err) {
        reportError('Sculpt stroke failed', err)
        return null
      }
      let plane: THREE.Plane | null = null
      if (kind === 'grab') {
        const facing = live.current.camera.getWorldDirection(new THREE.Vector3())
        plane = new THREE.Plane().setFromNormalAndCoplanarPoint(facing, hit.point)
      }
      return { target, mesh, kind, plane, startNormal: vec(normal) }
    }

    const continueStroke = (stroke: Stroke, ev: PointerEvent) => {
      const ray = setRay(ev.clientX, ev.clientY)
      let point: THREE.Vector3 | null = null
      let normal: Vec3 = stroke.startNormal
      if (stroke.plane) {
        const world = ray.intersectPlane(stroke.plane, new THREE.Vector3())
        if (world) point = stroke.mesh.worldToLocal(world)
      } else {
        const hit = hitTest([stroke.mesh])
        if (hit) {
          point = stroke.mesh.worldToLocal(hit.point.clone())
          normal = vec(hit.face!.normal)
        }
      }
      if (!point) return
      try {
        markDirty(stroke.target, stroke.target.core.strokeTo(vec(point), normal))
      } catch (err) {
        reportError('Sculpt stroke failed', err)
        abortStroke()
      }
    }

    const finishStroke = (stroke: Stroke) => {
      let record = null
      try {
        record = stroke.target.core.endStroke()
      } catch (err) {
        reportError('Sculpt stroke failed', err)
      }
      uploadPending(stroke.target)
      refreshSpatialData(stroke.target)
      diagonal.current = null
      if (record) {
        const store = useSculptStore.getState()
        const entry: SculptStrokeEntry = { meshKey: stroke.target.key, record }
        store.setHistory(pushStroke(store.history, entry))
      }
    }

    const onMove = (ev: PointerEvent) => {
      const d = drag.current
      if (!d || ev.pointerId !== d.pointerId || !d.stroke) return
      continueStroke(d.stroke, ev)
      hoverNdc.current = null
      updateRingFromEvent(ev, d.stroke.mesh)
    }

    const endDrag = () => {
      const d = drag.current
      drag.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      if (d?.stroke) finishStroke(d.stroke)
      setOrbit(true)
    }

    function onUp(ev: PointerEvent) {
      const d = drag.current
      if (!d || ev.pointerId !== d.pointerId) return
      d.released = true
      // Still preparing the mesh: the stroke (if any) ends once it starts.
      if (useSculptStore.getState().status === 'preparing') return
      endDrag()
    }

    function abortStroke() {
      const d = drag.current
      if (d?.stroke) {
        try { d.stroke.target.core.endStroke() } catch { /* already reported */ }
        uploadPending(d.stroke.target)
        d.stroke = null
      }
      endDrag()
    }

    // Ring under the cursor, sized to the brush and lying on the surface.
    const placeRing = (hit: THREE.Intersection<THREE.Mesh> | null) => {
      const ring = ringRef.current
      if (!ring) return
      if (!hit) { ring.visible = false; return }
      const mesh = hit.object
      const state = useSculptStore.getState()
      const kind = state.brush
      const radius = worldRadius(state.brushes[kind].radius, modelDiagonal())
      const normal = hit.face!.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld))
      if (normal.lengthSq() < 1e-12) normal.set(0, 1, 0)
      ring.position.copy(hit.point).addScaledVector(normal, radius * 0.01)
      ring.quaternion.setFromUnitVectors(Z_AXIS, normal.normalize())
      ring.scale.setScalar(Math.max(radius, 1e-6))
      ring.visible = true
    }

    function updateRingFromEvent(ev: PointerEvent, mesh: THREE.Mesh) {
      setRay(ev.clientX, ev.clientY)
      placeRing(hitTest([mesh]))
    }

    const onDown = (ev: PointerEvent) => {
      if (!activeRef.current || ev.button !== 0 || drag.current) return
      const store = useSculptStore.getState()
      if (store.status !== 'idle') return
      setRay(ev.clientX, ev.clientY)
      const hit = hitTest(meshes)
      if (!hit) return // empty space: let OrbitControls orbit

      // Runs before OrbitControls' own pointerdown (capture phase), so it never starts.
      setOrbit(false)
      store.setError(null)
      const d: Drag = { pointerId: ev.pointerId, stroke: null, released: false }
      drag.current = d
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)

      const geometryKey = hit.object.geometry.uuid
      const existing = targets.current.get(geometryKey)
      if (existing) {
        d.stroke = startStroke(existing, hit, ev)
        if (!d.stroke) endDrag()
        return
      }

      // First stroke on this part: build its sculpt data (can take ~1 s on big
      // meshes). Let React paint "Preparing mesh…" before blocking the thread.
      store.setStatus('preparing')
      window.setTimeout(() => {
        let target: SculptTarget | null = null
        try {
          target = createTarget(hit.object)
          targets.current.set(geometryKey, target)
        } catch (err) {
          reportError('Could not prepare the mesh for sculpting', err)
        }
        useSculptStore.getState().setStatus('idle')
        if (drag.current !== d) return
        if (target && activeRef.current) d.stroke = startStroke(target, hit, ev)
        if (!d.stroke || d.released) endDrag()
      }, 30)
    }

    const onHover = (ev: PointerEvent) => {
      if (!activeRef.current || drag.current) return
      const rect = live.current.gl.domElement.getBoundingClientRect()
      hoverNdc.current = new THREE.Vector2(
        ((ev.clientX - rect.left) / rect.width) * 2 - 1,
        -((ev.clientY - rect.top) / rect.height) * 2 + 1,
      )
    }

    const onLeave = () => {
      hoverNdc.current = null
      if (ringRef.current && !drag.current) ringRef.current.visible = false
    }

    const hover = (point: THREE.Vector2) => {
      raycaster.setFromCamera(point, live.current.camera)
      placeRing(hitTest(meshes))
    }

    const replay = (entry: SculptStrokeEntry): SculptStrokeEntry => {
      const target = targets.current.get(entry.meshKey)
      if (!target) throw new Error('The sculpted part is no longer loaded.')
      const { region, inverse } = target.core.restore(entry.record)
      markDirty(target, region)
      uploadPending(target)
      refreshSpatialData(target)
      return { meshKey: entry.meshKey, record: inverse }
    }

    const session: SculptSession = {
      async commit() {
        // A stroke in progress belongs to this commit.
        if (drag.current) endDrag()
        // Let "Saving sculpt…" paint before the (synchronous) encoding.
        await new Promise((resolve) => window.setTimeout(resolve, 0))
        const patches: VertexPatch[] = []
        for (const target of targets.current.values()) {
          if (!target.core.changed) continue
          const patch = buildVertexPatch(
            parser.associations.get(target.mesh) as { meshes?: number; primitives?: number } | undefined,
            target.core.positions,
            target.core.normals,
          )
          if (!patch) throw new Error('A sculpted part is not a glTF primitive and cannot be written back.')
          patches.push(patch)
        }
        if (patches.length === 0) return
        const { url } = await live.current.patchMeshVertices(meshPathFromUrl(outputUrl), patches)
        // Another mesh replaced this one while saving: applying would drop it.
        if (useAppStore.getState().currentJob?.outputUrl !== outputUrl) {
          throw new Error('The mesh changed while saving; the sculpt was not applied.')
        }
        useAppStore.getState().applyMeshEdit(url)
      },
      undo() {
        if (drag.current) return
        const store = useSculptStore.getState()
        try { store.setHistory(undoStroke(store.history, replay)) } catch (err) { reportError('Undo failed', err) }
      },
      redo() {
        if (drag.current) return
        const store = useSculptStore.getState()
        try { store.setHistory(redoStroke(store.history, replay)) } catch (err) { reportError('Redo failed', err) }
      },
    }

    return { onDown, onHover, onLeave, hover, session, endDrag, flush: () => targets.current.forEach(uploadPending) }
  }, [scene, meshes, parser, outputUrl, raycaster])

  // One session per model: commit (viewer going away) or drop (mesh replaced)
  // whatever is still pending when it ends.
  useEffect(() => {
    const { session } = api
    const unregister = useSculptStore.getState().registerSession(session)
    const owned = targets.current
    return () => {
      const store = useSculptStore.getState()
      const outcome = sessionEndOutcome(
        store.session === session && store.dirty,
        outputUrl,
        useAppStore.getState().currentJob?.outputUrl,
      )
      if (drag.current) api.endDrag()
      if (outcome === 'commit') {
        session.commit().catch((err) => {
          useAppStore.getState().showToast(`Could not save the sculpt: ${errorText(err)}`, 5000)
        })
      } else if (outcome === 'discard') {
        useAppStore.getState().showToast('Unsaved sculpt strokes were dropped: the mesh was replaced.', 5000)
      }
      unregister()
      if (outcome !== 'commit') owned.clear()
    }
  }, [api, outputUrl])

  // Pointer input, capture phase on the canvas: decides stroke vs orbit before
  // OrbitControls (listening further up) sees the press.
  useEffect(() => {
    const el = gl.domElement
    el.addEventListener('pointerdown', api.onDown, { capture: true })
    el.addEventListener('pointermove', api.onHover)
    el.addEventListener('pointerleave', api.onLeave)
    return () => {
      el.removeEventListener('pointerdown', api.onDown, { capture: true })
      el.removeEventListener('pointermove', api.onHover)
      el.removeEventListener('pointerleave', api.onLeave)
    }
  }, [gl, api])

  // Entering / leaving sculpt mode: fresh model size, no stale ring, no stuck stroke.
  useEffect(() => {
    diagonal.current = null
    if (!active) {
      if (drag.current) api.endDrag()
      hoverNdc.current = null
      if (ringRef.current) ringRef.current.visible = false
    }
    gl.domElement.style.cursor = active ? 'crosshair' : ''
    return () => { gl.domElement.style.cursor = '' }
  }, [active, api, gl])

  // At most one GPU upload per frame, and one hover raycast per frame.
  useFrame(() => {
    api.flush()
    if (!activeRef.current || drag.current) return
    const point = hoverNdc.current
    if (point) {
      hoverNdc.current = null
      api.hover(point)
    }
  })

  return (
    <mesh ref={ringRef} visible={false} renderOrder={1000} raycast={() => null}>
      <ringGeometry args={[0.94, 1, 64]} />
      <meshBasicMaterial
        color={RING_COLOR}
        transparent
        opacity={0.9}
        side={THREE.DoubleSide}
        depthTest={false}
        depthWrite={false}
        toneMapped={false}
      />
    </mesh>
  )
}

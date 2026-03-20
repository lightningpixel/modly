import { Suspense, useEffect, useRef, useState } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { OrbitControls, useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { useGeneration } from '@shared/hooks/useGeneration'
import { useAppStore } from '@shared/stores/appStore'
import { useCollectionsStore } from '@shared/stores/collectionsStore'
import { ViewerToolbar, type ViewMode } from './ViewerToolbar'

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
  }, [gl])
  return null
}

// ---------------------------------------------------------------------------
// MeshModel
// ---------------------------------------------------------------------------

interface MeshModelProps {
  url: string
  jobId: string
  viewMode: ViewMode
  onStats: (stats: { vertices: number; triangles: number }) => void
}

function MeshModel({ url, jobId, viewMode, onStats }: MeshModelProps): JSX.Element {
  const { scene } = useGLTF(url)
  const { gl } = useThree()
  const updateWorkspaceItem = useCollectionsStore((s) => s.updateWorkspaceItem)
  const captured = useRef(false)
  const edgeHelpers = useRef<THREE.LineSegments[]>([])

  // Free GPU resources and GLTF cache when this model is replaced or unmounted
  useEffect(() => {
    return () => {
      useGLTF.clear(url)
      scene.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose()
          const materials = Array.isArray(child.material) ? child.material : [child.material]
          materials.forEach((m: THREE.Material) => m.dispose())
        }
      })
      gl.renderLists.dispose()
    }
  }, [url])

  // Centre the mesh on the grid
  useEffect(() => {
    // Reset before computing — useGLTF caches the scene with its already-modified position,
    // which would skew the setFromObject (world space) on a second mount.
    scene.position.set(0, 0, 0)
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

    // Store originalTriangles only once (before any optimization)
    const existingJob = useCollectionsStore.getState().collections
      .flatMap((c) => c.jobs)
      .find((j) => j.id === jobId)
    if (!existingJob?.originalTriangles) {
      updateWorkspaceItem(jobId, { originalTriangles: roundedTriangles })
    }
  }, [scene])

  // Thumbnail capture
  useEffect(() => {
    if (captured.current) return
    captured.current = true
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const thumbnail = gl.domElement.toDataURL('image/jpeg', 0.85)
        updateWorkspaceItem(jobId, { thumbnailUrl: thumbnail })
      })
    })
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

  return <primitive object={scene} />
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

export default function Viewer3D(): JSX.Element {
  const { currentJob } = useGeneration()
  const apiUrl = useAppStore((s) => s.apiUrl)

  const setStoreMeshStats = useAppStore((s) => s.setMeshStats)
  const meshStats = useAppStore((s) => s.meshStats)

  const [viewMode, setViewMode] = useState<ViewMode>('solid')
  const [autoRotate, setAutoRotate] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const modelUrl =
    currentJob?.status === 'done' && currentJob.outputUrl
      ? `${apiUrl}${currentJob.outputUrl}`
      : null

  // Reset view state when model changes
  useEffect(() => {
    setViewMode('solid')
    setStoreMeshStats(null)
  }, [modelUrl])

  const handleScreenshot = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const link = document.createElement('a')
    link.download = `modly-${Date.now()}.png`
    link.href = canvas.toDataURL('image/png')
    link.click()
  }

  return (
    <div className="relative w-full h-full bg-surface-400">
      {!modelUrl && <EmptyState />}

      <Canvas
        camera={{ position: [0, 1.5, 4], fov: 45 }}
        gl={{
          antialias: true,
          preserveDrawingBuffer: true,
          outputColorSpace: THREE.SRGBColorSpace,
          toneMapping: THREE.NeutralToneMapping,
          toneMappingExposure: 1.8,
        }}
      >
        <color attach="background" args={['#18181b']} />
        <CanvasCapture domRef={canvasRef} />

        <gridHelper args={[10, 20, '#3f3f46', '#27272a']} />

        {modelUrl && currentJob && (
          <Suspense fallback={null}>
            <hemisphereLight args={['#ffffff', '#444466', 1.2]} />
            <directionalLight position={[5, 8, 5]} intensity={1.5} castShadow />
            <directionalLight position={[-4, 2, -4]} intensity={0.6} />
            <MeshModel
              url={modelUrl}
              jobId={currentJob.id}
              viewMode={viewMode}
              onStats={setStoreMeshStats}
            />
          </Suspense>
        )}

        <OrbitControls
          enablePan
          enableZoom
          enableRotate
          minDistance={0.5}
          maxDistance={20}
          autoRotate={autoRotate}
          autoRotateSpeed={1.5}
        />
      </Canvas>

      {/* Left toolbar — visible only when a model is loaded */}
      {modelUrl && (
        <ViewerToolbar
          viewMode={viewMode}
          autoRotate={autoRotate}
          onViewMode={setViewMode}
          onAutoRotate={() => setAutoRotate((v) => !v)}
          onScreenshot={handleScreenshot}
        />
      )}

      {/* Bottom-left stats overlay */}
      {meshStats && (
        <div className="absolute bottom-4 left-4 pointer-events-none">
          <p className="text-xs text-zinc-500">
            {meshStats.triangles.toLocaleString()} tri &bull; {meshStats.vertices.toLocaleString()} verts
          </p>
        </div>
      )}

      {/* Bottom-right hint */}
      {modelUrl && (
        <div className="absolute bottom-4 right-4 pointer-events-none">
          <p className="text-xs text-zinc-600">Drag to rotate &bull; Scroll to zoom</p>
        </div>
      )}
    </div>
  )
}

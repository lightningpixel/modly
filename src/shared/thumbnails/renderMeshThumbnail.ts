import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DEFAULT_LIGHT_SETTINGS } from '@shared/stores/appStore'

export const THUMBNAIL_SIZE = 256

// Same look as Viewer3D's default view: its background, default light rig,
// fov and three-quarter camera direction, R3F's ACES tone mapping and sRGB
// output, DoubleSide materials. The user's live lighting tweaks are left out
// on purpose so every thumbnail is rendered the same way.
const BACKGROUND = '#18181b'
const CAMERA_FOV = 45
const CAMERA_DIRECTION = new THREE.Vector3(0, 1.5, 4).normalize()

let renderer: THREE.WebGLRenderer | null = null

function getRenderer(): THREE.WebGLRenderer {
  if (renderer) return renderer
  const canvas = document.createElement('canvas')
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true })
  renderer.setPixelRatio(1)
  renderer.setSize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, false)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  return renderer
}

/** Frees the offscreen WebGL context; the next render recreates it. */
export function releaseThumbnailRenderer(): void {
  if (!renderer) return
  renderer.dispose()
  renderer.forceContextLoss()
  renderer = null
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return
    child.geometry.dispose()
    const materials: THREE.Material[] = Array.isArray(child.material) ? child.material : [child.material]
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) value.dispose()
      }
      material.dispose()
    }
  })
}

function buildScene(model: THREE.Object3D): { scene: THREE.Scene, camera: THREE.PerspectiveCamera } {
  model.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return
    const materials: THREE.Material[] = Array.isArray(child.material) ? child.material : [child.material]
    materials.forEach((material) => { material.side = THREE.DoubleSide })
  })

  // Rest the mesh on the ground at the origin, as Viewer3D does.
  const box = new THREE.Box3().setFromObject(model)
  const center = box.getCenter(new THREE.Vector3())
  model.position.set(-center.x, -box.min.y, -center.z)
  model.updateMatrixWorld(true)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(BACKGROUND)
  scene.add(new THREE.AmbientLight(0xffffff, DEFAULT_LIGHT_SETTINGS.ambientIntensity))
  const main = new THREE.DirectionalLight(DEFAULT_LIGHT_SETTINGS.mainColor, DEFAULT_LIGHT_SETTINGS.mainIntensity)
  main.position.set(5, 8, 5)
  const fill = new THREE.DirectionalLight(DEFAULT_LIGHT_SETTINGS.fillColor, DEFAULT_LIGHT_SETTINGS.fillIntensity)
  fill.position.set(-4, 2, -4)
  scene.add(main, fill, model)

  // Frame the bounding sphere from Viewer3D's default camera direction.
  const sphere = new THREE.Box3().setFromObject(model).getBoundingSphere(new THREE.Sphere())
  const radius = Math.max(sphere.radius, 1e-3)
  const distance = (radius / Math.sin(THREE.MathUtils.degToRad(CAMERA_FOV) / 2)) * 1.05
  const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, distance / 100, distance * 10)
  camera.position.copy(sphere.center).addScaledVector(CAMERA_DIRECTION, distance)
  camera.lookAt(sphere.center)
  return { scene, camera }
}

function canvasToWebp(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Thumbnail encoding failed'))
        return
      }
      blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject)
    }, 'image/webp', 0.85)
  })
}

/** Loads a .glb/.gltf from `url` and renders a square WebP thumbnail of it. */
export async function renderMeshThumbnail(url: string): Promise<Uint8Array> {
  const gltf = await new GLTFLoader().loadAsync(url)
  const model = gltf.scene
  try {
    const gl = getRenderer()
    const { scene, camera } = buildScene(model)
    gl.render(scene, camera)
    return await canvasToWebp(gl.domElement)
  } finally {
    disposeObject(model)
  }
}

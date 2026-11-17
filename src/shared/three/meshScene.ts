import * as THREE from 'three'

// Helpers shared by the viewers that show a loaded mesh file (Generate, Print).

/** Free a loaded model's GPU memory: every mesh's geometry and materials. */
export function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose()
      const materials = Array.isArray(child.material) ? child.material : [child.material]
      materials.forEach((m: THREE.Material) => m.dispose())
    }
  })
}

/**
 * Clear any pose left on a loaded scene (the loader cache may hand back one an
 * earlier viewer moved), then measure it. `offset` centres it on the origin
 * and rests its lowest point on the ground (y = 0).
 */
export function groundPlacement(scene: THREE.Object3D): { offset: THREE.Vector3, size: THREE.Vector3 } {
  scene.position.set(0, 0, 0)
  scene.rotation.set(0, 0, 0)
  scene.scale.set(1, 1, 1)
  scene.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(scene)
  const center = box.getCenter(new THREE.Vector3())
  return {
    offset: new THREE.Vector3(-center.x, -box.min.y, -center.z),
    size: box.getSize(new THREE.Vector3()),
  }
}

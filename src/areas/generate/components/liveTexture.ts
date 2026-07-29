import * as THREE from 'three'

type PaintedMaterial = THREE.Material & { map: THREE.Texture | null }

export interface LiveTextureTarget {
  texture: THREE.Texture
  materials: PaintedMaterial[]
  width: number
  height: number
}

export type LiveTextureTargetResult =
  | { ok: true; target: LiveTextureTarget }
  | { ok: false; message: string }

function materialList(value: THREE.Material | THREE.Material[]): THREE.Material[] {
  return Array.isArray(value) ? value : [value]
}

function hasPaintedTexture(material: THREE.Material): material is PaintedMaterial {
  return 'map' in material && material.map instanceof THREE.Texture
}

function textureSize(texture: THREE.Texture): { width: number; height: number } | null {
  const image = texture.image as { width?: unknown; height?: unknown } | undefined
  const width = Number(image?.width)
  const height = Number(image?.height)
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width, height }
    : null
}

export function findLiveTextureTarget(object: THREE.Object3D): LiveTextureTargetResult {
  const materials = new Set<PaintedMaterial>()
  const textures = new Set<THREE.Texture>()

  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return
    const original = child.userData.originalMaterial as THREE.Material | THREE.Material[] | undefined
    const source = original ?? child.material
    for (const material of materialList(source)) {
      if (!hasPaintedTexture(material) || !material.map) continue
      materials.add(material)
      textures.add(material.map)
    }
  })

  if (textures.size === 0) {
    return { ok: false, message: 'This model has no painted texture to update.' }
  }
  if (textures.size > 1) {
    return {
      ok: false,
      message: 'This model uses more than one painted texture. Live updates currently work with one texture at a time.',
    }
  }

  const texture = [...textures][0]
  const size = textureSize(texture)
  if (!size) {
    return { ok: false, message: 'The model texture size could not be read.' }
  }

  return {
    ok: true,
    target: {
      texture,
      materials: [...materials].filter((material) => material.map === texture),
      width: size.width,
      height: size.height,
    },
  }
}

export function prepareLiveTexture(texture: THREE.Texture, source: THREE.Texture): void {
  texture.name = source.name
  texture.wrapS = source.wrapS
  texture.wrapT = source.wrapT
  texture.flipY = source.flipY
  texture.channel = source.channel
  texture.offset.copy(source.offset)
  texture.repeat.copy(source.repeat)
  texture.center.copy(source.center)
  texture.rotation = source.rotation
  texture.matrixAutoUpdate = source.matrixAutoUpdate
  texture.matrix.copy(source.matrix)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true
}

export function replaceLiveTexture(target: LiveTextureTarget, texture: THREE.Texture): void {
  for (const material of target.materials) {
    material.map = texture
    material.needsUpdate = true
  }
}

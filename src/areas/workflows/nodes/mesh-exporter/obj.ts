// Wavefront OBJ export: the .obj, plus a .mtl and the base color textures when
// the mesh has any, written side by side like Blender does.

export interface ObjPrimitive {
  positions: Float32Array
  normals:   Float32Array | null
  uvs:       Float32Array | null
  indices:   number[]
  /** Index into the textures list, or null when the primitive is untextured. */
  texture:   number | null
}

export interface ObjTexture {
  image:    Uint8Array
  mimeType: string
}

export interface ObjFile {
  name: string
  data: string | Uint8Array
}

const TEXTURE_EXTENSIONS: Record<string, string> = {
  'image/png':  'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

/** The file extension for a texture image, or null for a format OBJ readers won't load. */
export function textureExtension(mimeType: string): string | null {
  return TEXTURE_EXTENSIONS[mimeType.toLowerCase()] ?? null
}

/**
 * The files of an OBJ export named `stem`: `<stem>.obj`, and when a primitive is
 * textured, `<stem>.mtl` and `<stem>_texture.<ext>` (numbered when there are several).
 * Only the base color texture is carried.
 */
export function objFiles(prims: ObjPrimitive[], textures: ObjTexture[], stem: string): ObjFile[] {
  const isTextured = (p: ObjPrimitive) => p.texture !== null && p.uvs !== null
    && textures[p.texture] !== undefined && textureExtension(textures[p.texture].mimeType) !== null
  // The textures some primitive actually shows, in order.
  const used = textures
    .map((texture, index) => ({ texture, index }))
    .filter(({ index }) => prims.some((p) => isTextured(p) && p.texture === index))

  if (used.length === 0) return [{ name: `${stem}.obj`, data: buildObj(prims, null, () => null) }]

  const single = used.length === 1
  const materials = new Map(used.map(({ texture, index }, i) => [index, {
    name: single ? 'material' : `material_${i + 1}`,
    file: `${stem}_texture${single ? '' : `_${i + 1}`}.${textureExtension(texture.mimeType)}`,
    image: texture.image,
  }]))

  const mtlName = `${stem}.mtl`
  const mtl: string[] = ['# Exported by Modly mesh-exporter']
  for (const { name, file } of materials.values()) {
    mtl.push('', `newmtl ${name}`, 'Ka 1.000000 1.000000 1.000000', 'Kd 1.000000 1.000000 1.000000',
      'Ks 0.000000 0.000000 0.000000', 'd 1.000000', 'illum 1', `map_Kd ${file}`)
  }
  // An OBJ material carries over to the faces that follow: untextured parts get their own.
  if (prims.some((p) => !isTextured(p))) {
    mtl.push('', 'newmtl untextured', 'Kd 0.800000 0.800000 0.800000', 'Ks 0.000000 0.000000 0.000000',
      'd 1.000000', 'illum 1')
  }
  mtl.push('')

  const materialFor = (p: ObjPrimitive) => (isTextured(p) ? materials.get(p.texture!)!.name : 'untextured')
  return [
    { name: `${stem}.obj`, data: buildObj(prims, mtlName, materialFor) },
    { name: mtlName, data: mtl.join('\n') },
    ...[...materials.values()].map(({ file, image }) => ({ name: file, data: image })),
  ]
}

function buildObj(
  prims: ObjPrimitive[],
  mtlName: string | null,
  materialFor: (p: ObjPrimitive) => string | null,
): string {
  const lines: string[] = ['# Exported by Modly mesh-exporter']
  if (mtlName) lines.push(`mtllib ${mtlName}`)
  lines.push('')
  let vOff = 1, vnOff = 1, vtOff = 1

  for (let pi = 0; pi < prims.length; pi++) {
    const prim = prims[pi]
    const { positions: p, normals: n, uvs: uv, indices } = prim
    const vc = p.length / 3

    lines.push(`g mesh_${pi}`)
    const material = materialFor(prim)
    if (material) lines.push(`usemtl ${material}`)

    for (let i = 0; i < p.length; i += 3)
      lines.push(`v ${p[i].toFixed(6)} ${p[i+1].toFixed(6)} ${p[i+2].toFixed(6)}`)

    if (n) for (let i = 0; i < n.length; i += 3)
      lines.push(`vn ${n[i].toFixed(6)} ${n[i+1].toFixed(6)} ${n[i+2].toFixed(6)}`)

    // glTF puts the UV origin at the image's top-left, OBJ at its bottom-left.
    if (uv) for (let i = 0; i < uv.length; i += 2)
      lines.push(`vt ${uv[i].toFixed(6)} ${(1 - uv[i+1]).toFixed(6)}`)

    for (let i = 0; i + 2 < indices.length; i += 3) {
      const [a, b, c] = [indices[i]+vOff, indices[i+1]+vOff, indices[i+2]+vOff]
      const [ua, ub, uc] = [indices[i]+vtOff, indices[i+1]+vtOff, indices[i+2]+vtOff]
      const [na, nb, nc] = [indices[i]+vnOff, indices[i+1]+vnOff, indices[i+2]+vnOff]
      if (n && uv)  lines.push(`f ${a}/${ua}/${na} ${b}/${ub}/${nb} ${c}/${uc}/${nc}`)
      else if (n)   lines.push(`f ${a}//${na} ${b}//${nb} ${c}//${nc}`)
      else if (uv)  lines.push(`f ${a}/${ua} ${b}/${ub} ${c}/${uc}`)
      else          lines.push(`f ${a} ${b} ${c}`)
    }

    vOff  += vc
    if (n)  vnOff += n.length  / 3
    if (uv) vtOff += uv.length / 2
  }

  return lines.join('\n')
}

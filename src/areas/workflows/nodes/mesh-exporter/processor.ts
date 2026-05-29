/* eslint-disable @typescript-eslint/no-require-imports */
import path = require('path')
import fs   = require('fs')

interface ProcessInput  { filePath?: string; text?: string }
interface ProcessResult { filePath?: string; text?: string }
interface ProcessContext {
  workspaceDir: string
  tempDir:      string
  log:          (msg: string) => void
  progress:     (pct: number, label: string) => void
}

// ─── Geometry extraction ──────────────────────────────────────────────────────

interface PrimGeometry {
  positions: Float32Array
  normals:   Float32Array | null
  uvs:       Float32Array | null
  indices:   number[]
}

function extractPrimitives(doc: any): PrimGeometry[] {
  const result: PrimGeometry[] = []
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const posArr = prim.getAttribute('POSITION')?.getArray() as Float32Array | null
      if (!posArr) continue
      const normArr = (prim.getAttribute('NORMAL')?.getArray() as Float32Array | null) ?? null
      const uvArr   = (prim.getAttribute('TEXCOORD_0')?.getArray() as Float32Array | null) ?? null
      const idxRaw  = prim.getIndices()?.getArray() ?? null
      const vertCount = posArr.length / 3
      const indices   = idxRaw
        ? Array.from(idxRaw as Uint16Array | Uint32Array)
        : Array.from({ length: vertCount }, (_, i) => i)
      result.push({ positions: posArr, normals: normArr, uvs: uvArr, indices })
    }
  }
  return result
}

// ─── STL (binary) ─────────────────────────────────────────────────────────────

function faceNormal(p: Float32Array, i0: number, i1: number, i2: number): [number, number, number] {
  const ax = p[i1*3]-p[i0*3],   ay = p[i1*3+1]-p[i0*3+1], az = p[i1*3+2]-p[i0*3+2]
  const bx = p[i2*3]-p[i0*3],   by = p[i2*3+1]-p[i0*3+1], bz = p[i2*3+2]-p[i0*3+2]
  const nx = ay*bz - az*by, ny = az*bx - ax*bz, nz = ax*by - ay*bx
  const len = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1
  return [nx/len, ny/len, nz/len]
}

function writeSTL(prims: PrimGeometry[], outPath: string): void {
  let totalTri = 0
  for (const p of prims) totalTri += Math.floor(p.indices.length / 3)

  const buf = Buffer.allocUnsafe(84 + totalTri * 50)
  buf.fill(0, 0, 80)
  buf.writeUInt32LE(totalTri, 80)

  let off = 84
  for (const { positions: p, normals: n, indices } of prims) {
    for (let i = 0; i + 2 < indices.length; i += 3) {
      const i0 = indices[i], i1 = indices[i+1], i2 = indices[i+2]

      let nx: number, ny: number, nz: number
      if (n) {
        nx = (n[i0*3] + n[i1*3] + n[i2*3]) / 3
        ny = (n[i0*3+1] + n[i1*3+1] + n[i2*3+1]) / 3
        nz = (n[i0*3+2] + n[i1*3+2] + n[i2*3+2]) / 3
      } else {
        ;[nx, ny, nz] = faceNormal(p, i0, i1, i2)
      }

      buf.writeFloatLE(nx, off); off += 4
      buf.writeFloatLE(ny, off); off += 4
      buf.writeFloatLE(nz, off); off += 4

      for (const vi of [i0, i1, i2]) {
        buf.writeFloatLE(p[vi*3],   off); off += 4
        buf.writeFloatLE(p[vi*3+1], off); off += 4
        buf.writeFloatLE(p[vi*3+2], off); off += 4
      }
      buf.writeUInt16LE(0, off); off += 2
    }
  }

  fs.writeFileSync(outPath, buf)
}

// ─── OBJ ──────────────────────────────────────────────────────────────────────

function writeOBJ(prims: PrimGeometry[], outPath: string): void {
  const lines: string[] = ['# Exported by Modly mesh-exporter', '']
  let vOff = 1, vnOff = 1, vtOff = 1

  for (let pi = 0; pi < prims.length; pi++) {
    const { positions: p, normals: n, uvs: uv, indices } = prims[pi]
    const vc = p.length / 3

    lines.push(`g mesh_${pi}`)

    for (let i = 0; i < p.length; i += 3)
      lines.push(`v ${p[i].toFixed(6)} ${p[i+1].toFixed(6)} ${p[i+2].toFixed(6)}`)

    if (n) for (let i = 0; i < n.length; i += 3)
      lines.push(`vn ${n[i].toFixed(6)} ${n[i+1].toFixed(6)} ${n[i+2].toFixed(6)}`)

    if (uv) for (let i = 0; i < uv.length; i += 2)
      lines.push(`vt ${uv[i].toFixed(6)} ${uv[i+1].toFixed(6)}`)

    for (let i = 0; i + 2 < indices.length; i += 3) {
      const [a, b, c] = [indices[i]+vOff, indices[i+1]+vOff, indices[i+2]+vOff]
      if (n && uv) {
        const [ua, ub, uc] = [indices[i]+vtOff, indices[i+1]+vtOff, indices[i+2]+vtOff]
        const [na, nb, nc] = [indices[i]+vnOff, indices[i+1]+vnOff, indices[i+2]+vnOff]
        lines.push(`f ${a}/${ua}/${na} ${b}/${ub}/${nb} ${c}/${uc}/${nc}`)
      } else if (n) {
        const [na, nb, nc] = [indices[i]+vnOff, indices[i+1]+vnOff, indices[i+2]+vnOff]
        lines.push(`f ${a}//${na} ${b}//${nb} ${c}//${nc}`)
      } else {
        lines.push(`f ${a} ${b} ${c}`)
      }
    }

    vOff  += vc
    if (n)  vnOff += n.length  / 3
    if (uv) vtOff += uv.length / 2
  }

  fs.writeFileSync(outPath, lines.join('\n'), 'utf-8')
}

// ─── PLY (ASCII) ──────────────────────────────────────────────────────────────

function writePLY(prims: PrimGeometry[], outPath: string): void {
  let totalVerts = 0, totalFaces = 0
  let hasNormals = true
  for (const p of prims) {
    totalVerts += p.positions.length / 3
    totalFaces += Math.floor(p.indices.length / 3)
    if (!p.normals) hasNormals = false
  }

  const header = [
    'ply',
    'format ascii 1.0',
    'comment Exported by Modly mesh-exporter',
    `element vertex ${totalVerts}`,
    'property float x', 'property float y', 'property float z',
    ...(hasNormals ? ['property float nx', 'property float ny', 'property float nz'] : []),
    `element face ${totalFaces}`,
    'property list uchar int vertex_indices',
    'end_header',
  ]

  const vertLines: string[] = []
  const faceLines: string[] = []
  let vertOffset = 0

  for (const { positions: p, normals: n, indices } of prims) {
    const vc = p.length / 3
    for (let i = 0; i < vc; i++) {
      const row = [p[i*3].toFixed(6), p[i*3+1].toFixed(6), p[i*3+2].toFixed(6)]
      if (hasNormals) {
        if (n) row.push(n[i*3].toFixed(6), n[i*3+1].toFixed(6), n[i*3+2].toFixed(6))
        else   row.push('0.000000', '0.000000', '0.000000')
      }
      vertLines.push(row.join(' '))
    }
    for (let i = 0; i + 2 < indices.length; i += 3)
      faceLines.push(`3 ${indices[i]+vertOffset} ${indices[i+1]+vertOffset} ${indices[i+2]+vertOffset}`)
    vertOffset += vc
  }

  fs.writeFileSync(outPath, [...header, ...vertLines, ...faceLines].join('\n'), 'utf-8')
}

// ─── FBX (ASCII 7.4, UE5-compatible) ─────────────────────────────────────────
// Converts from glTF coordinate space (Y-up, meters) to UE5 (Z-up, centimeters).
// Axis remapping: gltf (x, y, z) → ue5 (x, z, -y) then scale ×100 for cm.
// UV V channel is flipped (glTF origin = bottom-left; FBX/UE5 = top-left).

function writeFBX(doc: any, prims: PrimGeometry[], outPath: string): void {
  const timestamp = new Date()
  const dateStr = timestamp.toISOString().replace('T', ' ').replace(/\..+/, '')

  // Extract base-color texture bytes (PNG) from the glTF document if present
  let texturePngBytes: Buffer | null = null
  let textureRelPath = ''
  try {
    const textures = doc.getRoot().listTextures()
    if (textures.length > 0) {
      const img = textures[0].getImage()
      if (img) {
        texturePngBytes = Buffer.from(img)
        textureRelPath = path.basename(outPath, '.fbx') + '_texture.png'
      }
    }
  } catch (_) { /* no texture — continue */ }

  // Build vertex + index arrays with axis conversion
  const allVerts:  string[] = []
  const allNorms:  string[] = []
  const allUVs:    string[] = []
  const allPolys:  string[] = []
  let vertOffset = 0

  for (const { positions: p, normals: n, uvs: uv, indices } of prims) {
    const vc = p.length / 3
    // Vertices: gltf (x,y,z) → ue5 (x*100, z*100, -y*100)
    for (let i = 0; i < vc; i++)
      allVerts.push(`\t\t\t${(p[i*3]*100).toFixed(4)},${(p[i*3+2]*100).toFixed(4)},${(-p[i*3+1]*100).toFixed(4)}`)

    if (n) for (let i = 0; i < vc; i++)
      allNorms.push(`\t\t\t${n[i*3].toFixed(6)},${n[i*3+2].toFixed(6)},${(-n[i*3+1]).toFixed(6)}`)

    // UVs: flip V  (glTF V=0 is bottom, FBX V=0 is top)
    if (uv) for (let i = 0; i < uv.length / 2; i++)
      allUVs.push(`\t\t\t\t${uv[i*2].toFixed(6)},${(1 - uv[i*2+1]).toFixed(6)}`)

    // Polygons — FBX uses negative last index to mark end of polygon
    for (let i = 0; i + 2 < indices.length; i += 3) {
      const a = indices[i]   + vertOffset
      const b = indices[i+1] + vertOffset
      const c = indices[i+2] + vertOffset
      allPolys.push(`\t\t\t${a},${b},${~c}`)  // ~c == -(c+1), FBX polygon-end marker
    }
    vertOffset += vc
  }

  const totalVerts = vertOffset
  const totalPolys = allPolys.length

  const lines: string[] = [
    '; FBX 7.4.0 project file',
    '; Generated by Modly mesh-exporter (UE5 compatible)',
    `; Created: ${dateStr}`,
    '',
    'FBXHeaderExtension:  {',
    '\tFBXHeaderVersion: 1003',
    '\tFBXVersion: 7400',
    `\tCreationTimeStamp:  {`,
    '\t\tVersion: 1000',
    `\t\tYear: ${timestamp.getFullYear()}`,
    `\t\tMonth: ${timestamp.getMonth()+1}`,
    `\t\tDay: ${timestamp.getDate()}`,
    `\t\tHour: ${timestamp.getHours()}`,
    `\t\tMinute: ${timestamp.getMinutes()}`,
    `\t\tSecond: ${timestamp.getSeconds()}`,
    '\t\tMillisecond: 0',
    '\t}',
    '\tCreator: "Modly mesh-exporter"',
    '}',
    '',
    'GlobalSettings:  {',
    '\tVersion: 1000',
    '\tProperties70:  {',
    '\t\tP: "UpAxis", "int", "Integer", "",1',          // 1 = Z-up
    '\t\tP: "UpAxisSign", "int", "Integer", "",1',
    '\t\tP: "FrontAxis", "int", "Integer", "",1',       // 1 = Y-front (UE5 default)
    '\t\tP: "FrontAxisSign", "int", "Integer", "",1',
    '\t\tP: "CoordAxis", "int", "Integer", "",0',       // 0 = X-right
    '\t\tP: "CoordAxisSign", "int", "Integer", "",1',
    '\t\tP: "OriginalUpAxis", "int", "Integer", "",1',
    '\t\tP: "OriginalUpAxisSign", "int", "Integer", "",1',
    '\t\tP: "UnitScaleFactor", "double", "Number", "",1',
    '\t\tP: "OriginalUnitScaleFactor", "double", "Number", "",100',
    '\t}',
    '}',
    '',
    'Definitions:  {',
    '\tVersion: 100',
    '\tCount: 1',
    '\tObjectType: "Geometry" {',
    '\t\tCount: 1',
    '\t}',
    '}',
    '',
    'Objects:  {',
    '\tGeometry: 1, "Geometry::ModlyMesh", "Mesh" {',
    `\t\tVertices: *${totalVerts * 3} {`,
    '\t\t\ta: \\',
  ]

  lines.push(allVerts.join(',\n') )
  lines.push('\t\t}')

  lines.push(`\t\tPolygonVertexIndex: *${totalPolys * 3} {`)
  lines.push('\t\t\ta: \\')
  lines.push(allPolys.join(',\n'))
  lines.push('\t\t}')

  if (allNorms.length > 0) {
    lines.push('\t\tLayerElementNormal: 0 {')
    lines.push('\t\t\tVersion: 101')
    lines.push('\t\t\tName: ""')
    lines.push('\t\t\tMappingInformationType: "ByControlPoint"')
    lines.push('\t\t\tReferenceInformationType: "Direct"')
    lines.push(`\t\t\tNormals: *${allNorms.length * 3} {`)
    lines.push('\t\t\t\ta: \\')
    lines.push(allNorms.join(',\n'))
    lines.push('\t\t\t}')
    lines.push('\t\t}')
  }

  if (allUVs.length > 0) {
    lines.push('\t\tLayerElementUV: 0 {')
    lines.push('\t\t\tVersion: 101')
    lines.push('\t\t\tName: "UVMap"')
    lines.push('\t\t\tMappingInformationType: "ByControlPoint"')
    lines.push('\t\t\tReferenceInformationType: "Direct"')
    lines.push(`\t\t\tUV: *${allUVs.length * 2} {`)
    lines.push('\t\t\t\ta: \\')
    lines.push(allUVs.join(',\n'))
    lines.push('\t\t\t}')
    lines.push('\t\t}')
  }

  // Layer block
  lines.push('\t\tLayer: 0 {')
  lines.push('\t\t\tVersion: 100')
  if (allNorms.length > 0) {
    lines.push('\t\t\tLayerElement:  {')
    lines.push('\t\t\t\tType: "LayerElementNormal"')
    lines.push('\t\t\t\tTypedIndex: 0')
    lines.push('\t\t\t}')
  }
  if (allUVs.length > 0) {
    lines.push('\t\t\tLayerElement:  {')
    lines.push('\t\t\t\tType: "LayerElementUV"')
    lines.push('\t\t\t\tTypedIndex: 0')
    lines.push('\t\t\t}')
  }
  lines.push('\t\t}')
  lines.push('\t}')
  lines.push('}')
  lines.push('')
  lines.push('Connections:  {')
  lines.push('}')
  lines.push('')

  fs.writeFileSync(outPath, lines.join('\n'), 'utf-8')

  // Write texture PNG alongside FBX if present
  if (texturePngBytes && textureRelPath) {
    const texOut = path.join(path.dirname(outPath), textureRelPath)
    fs.writeFileSync(texOut, texturePngBytes)
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const EXT_MAP: Record<string, string> = { glb: '.glb', fbx: '.fbx', stl: '.stl', obj: '.obj', ply: '.ply' }

const processor = async (
  input:   ProcessInput,
  params:  Record<string, unknown>,
  context: ProcessContext,
): Promise<ProcessResult> => {
  if (!input.filePath) throw new Error('mesh-exporter: input.filePath is required')

  const format     = String(params['export_format'] ?? 'glb').toLowerCase()
  const outputPath = String(params['output_path']   ?? '').trim()

  const ext = EXT_MAP[format]
  if (!ext) throw new Error(`mesh-exporter: unsupported format "${format}"`)

  context.log(`Format: ${format} — input: ${input.filePath}`)

  const { NodeIO } = require('@gltf-transform/core')
  const io = new NodeIO()

  context.progress(20, 'Loading mesh…')
  const doc = await io.read(input.filePath)

  let outPath: string
  if (outputPath) {
    fs.mkdirSync(outputPath, { recursive: true })
    outPath = path.join(outputPath, `export-${Date.now()}${ext}`)
  } else {
    const exportsDir = path.join(context.workspaceDir, 'Exports')
    fs.mkdirSync(exportsDir, { recursive: true })
    outPath = path.join(exportsDir, `export-${Date.now()}${ext}`)
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true })

  context.progress(50, `Exporting as ${format.toUpperCase()}…`)

  if (format === 'glb') {
    await io.write(outPath, doc)
  } else {
    const prims = extractPrimitives(doc)
    if (prims.length === 0) throw new Error('mesh-exporter: no mesh data found in input')
    if      (format === 'fbx') writeFBX(doc, prims, outPath)
    else if (format === 'stl') writeSTL(prims, outPath)
    else if (format === 'obj') writeOBJ(prims, outPath)
    else if (format === 'ply') writePLY(prims, outPath)
  }

  context.progress(100, 'Done')
  context.log(`Output: ${outPath}`)
  return { filePath: outPath }
}

export = processor

import path = require('path')
import fs   = require('fs')
import { objFiles, textureExtension, type ObjTexture } from './obj'

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
  /** Index into the base color textures, or null when untextured. */
  texture:   number | null
}

function extractPrimitives(doc: any, textures: ObjTexture[]): PrimGeometry[] {
  const result: PrimGeometry[] = []
  // One entry per distinct texture, shared by the primitives that use it.
  const textureIndex = new Map<unknown, number>()
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
      let texture: number | null = null
      const baseColor = prim.getMaterial()?.getBaseColorTexture() ?? null
      const image = baseColor?.getImage() as Uint8Array | null | undefined
      if (baseColor && image && textureExtension(baseColor.getMimeType() ?? '')) {
        if (!textureIndex.has(baseColor)) {
          textureIndex.set(baseColor, textures.length)
          textures.push({ image, mimeType: baseColor.getMimeType() })
        }
        texture = textureIndex.get(baseColor)!
      }
      result.push({ positions: posArr, normals: normArr, uvs: uvArr, indices, texture })
    }
  }
  return result
}

// ─── Real-world scale ──────────────────────────────────────────────────────

/** STL, OBJ and PLY carry no unit: by convention they hold millimetres. */
const MM_PER_M = 1000

/**
 * Whether the GLB declares its real size: Modly's set_real_scale writes
 * `scenes[n].extras.modly.real_scale = { unit: 'm' }` (api/services/mesh_ops/real_scale.py).
 */
function isCalibrated(doc: any): boolean {
  const scene = doc.getRoot().getDefaultScene?.() ?? doc.getRoot().listScenes?.()[0]
  const extras = scene?.getExtras?.() as { modly?: { real_scale?: { unit?: unknown } } } | undefined
  return extras?.modly?.real_scale?.unit === 'm'
}

/** A calibrated asset is written in millimetres, like the API's exports. */
function scalePrimitives(prims: PrimGeometry[], factor: number): PrimGeometry[] {
  if (factor === 1) return prims
  return prims.map((p) => ({ ...p, positions: p.positions.map((v) => v * factor) }))
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

/** `<name>.obj`, plus `<name>.mtl` and its textures next to it when the mesh is textured. */
function writeOBJ(prims: PrimGeometry[], textures: ObjTexture[], outPath: string): string[] {
  const dir = path.dirname(outPath)
  const files = objFiles(prims, textures, path.basename(outPath, path.extname(outPath)))
  for (const file of files) fs.writeFileSync(path.join(dir, file.name), file.data)
  return files.map((file) => file.name)
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

// ─── Main ─────────────────────────────────────────────────────────────────────

const EXT_MAP: Record<string, string> = { glb: '.glb', stl: '.stl', obj: '.obj', ply: '.ply' }

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
  const { ALL_EXTENSIONS } = require('@gltf-transform/extensions')
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)

  context.progress(20, 'Loading mesh…')
  const doc = await io.read(input.filePath)

  let outPath: string
  if (outputPath) {
    // Relative destinations belong to the configured workspace, never the
    // application's working directory (often Program Files on Windows).
    const destination = path.resolve(context.workspaceDir, outputPath)
    const destinationExt = path.extname(destination).toLowerCase()
    const isFile = !/[\\/]$/.test(outputPath)
      && Object.values(EXT_MAP).includes(destinationExt)
      && !(fs.existsSync(destination) && fs.statSync(destination).isDirectory())
    if (isFile && destinationExt !== ext) {
      throw new Error(`mesh-exporter: output file extension must be ${ext} for format "${format}"`)
    }
    outPath = isFile ? destination : path.join(destination, `export-${Date.now()}${ext}`)
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
    const calibrated = isCalibrated(doc)
    const textures: ObjTexture[] = []
    const prims = scalePrimitives(extractPrimitives(doc, textures), calibrated ? MM_PER_M : 1)
    if (prims.length === 0) throw new Error('mesh-exporter: no mesh data found in input')
    if (calibrated) context.log('Real-size asset: written in millimetres')
    if      (format === 'stl') writeSTL(prims, outPath)
    else if (format === 'obj') {
      const written = writeOBJ(prims, textures, outPath)
      if (written.length > 1) context.log(`Material and texture: ${written.slice(1).join(', ')}`)
    }
    else if (format === 'ply') writePLY(prims, outPath)
  }

  context.progress(100, 'Done')
  context.log(`Output: ${outPath}`)
  return { filePath: outPath }
}

export = processor

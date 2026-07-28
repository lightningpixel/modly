import path = require('path')
import fs   = require('fs')

interface ProcessInput  { filePath?: string; text?: string; sourceAssetPath?: string }
interface ProcessResult { filePath?: string; text?: string }
interface ProcessContext {
  workspaceDir: string
  tempDir:      string
  log:          (msg: string) => void
  progress:     (pct: number, label: string) => void
}

// ─── Lineage ──────────────────────────────────────────────────────────────────
// When the input mesh traces back to an existing workspace asset, record where
// it came from: the immediate parent, plus the root of the chain (so re-exporting
// an already-derived model doesn't grow an unbounded ancestry list).

interface DerivedRef  { path: string; name: string | null }
interface DerivedFrom { parent: DerivedRef; root: DerivedRef }
type Sidecar = Record<string, unknown>

function sidecarPathFor(assetPath: string): string {
  return assetPath.replace(/\.[^./\\]+$/, '') + '.tags.json'
}

function readSidecar(assetPath: string): Sidecar {
  const sidecarPath = sidecarPathFor(assetPath)
  if (!fs.existsSync(sidecarPath)) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8'))
  } catch (error) {
    throw new Error(`mesh-exporter: cannot read metadata sidecar ${sidecarPath}: ${String(error)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`mesh-exporter: metadata sidecar is not a JSON object: ${sidecarPath}`)
  }
  return parsed as Sidecar
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function writeSidecarAtomic(assetPath: string, sidecar: Sidecar): void {
  const destination = sidecarPathFor(assetPath)
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(temporary, JSON.stringify(sidecar, null, 2) + '\n', 'utf-8')
    fs.renameSync(temporary, destination)
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
}

/** Workspace-relative form of an absolute path, or null if it's outside the workspace. */
function toWorkspaceRelative(workspaceDir: string, absPath: string): string | null {
  const norm   = absPath.replace(/\\/g, '/')
  const wsNorm = workspaceDir.replace(/\\/g, '/').replace(/\/+$/, '')
  if (norm !== wsNorm && !norm.startsWith(wsNorm + '/')) return null
  return norm.slice(wsNorm.length + 1)
}

/** Reads asset.extras.modly straight out of a GLB's leading JSON chunk — used only
 *  as a name fallback when a source asset predates the .tags.json sidecar. */
function readGlbModlyExtras(glbPath: string): { name?: string } | null {
  try {
    const fd = fs.openSync(glbPath, 'r')
    try {
      const header = Buffer.alloc(12)
      fs.readSync(fd, header, 0, 12, 0)
      if (header.toString('ascii', 0, 4) !== 'glTF') return null
      const chunkHeader = Buffer.alloc(8)
      fs.readSync(fd, chunkHeader, 0, 8, 12)
      const chunkLength = chunkHeader.readUInt32LE(0)
      if (chunkHeader.toString('ascii', 4, 8) !== 'JSON') return null
      const chunkData = Buffer.alloc(chunkLength)
      fs.readSync(fd, chunkData, 0, chunkLength, 20)
      const json = JSON.parse(chunkData.toString('utf-8'))
      return json?.asset?.extras?.modly ?? null
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
}

/**
 * Resolves the `derived_from` sidecar field for an export whose input traces
 * back to `sourceAssetPath`. Returns null when there's nothing to record (no
 * source, or the source isn't a workspace asset).
 */
function resolveDerivedFrom(sourceAssetPath: string | undefined, workspaceDir: string): DerivedFrom | null {
  if (!sourceAssetPath) return null
  const relPath = toWorkspaceRelative(workspaceDir, sourceAssetPath)
  if (!relPath) return null

  let name: string | null = null
  let upstream: DerivedFrom | undefined

  const sidecarPath = sidecarPathFor(sourceAssetPath)
  if (fs.existsSync(sidecarPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8'))
      name = data.name ?? null
      if (data.derived_from) upstream = data.derived_from as DerivedFrom
    } catch {
      // Malformed sidecar — treat the source as untagged rather than failing the export.
    }
  } else {
    name = readGlbModlyExtras(sourceAssetPath)?.name ?? null
  }

  const parent: DerivedRef = { path: relPath, name }
  const root = upstream?.root ?? parent
  return { parent, root }
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

  // modly-friendly-names: a folder of export-1785194887022.glb tells you nothing.
  const stamp  = new Date()
  const pad    = (n: number): string => String(n).padStart(2, '0')
  const unique = Date.now().toString(36).slice(-4)
  const typed  = String(params['model_name'] ?? '').trim()
  const slug   = typed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  const dated = `model-${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}`
    + `-${pad(stamp.getHours())}${pad(stamp.getMinutes())}`
  const baseName = `${slug || dated}-${unique}${ext}`

  const slugify = (s: unknown): string => String(s ?? '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  const project = slugify(params['project'])

  const root = outputPath || path.join(context.workspaceDir, 'Exports')
  const dir  = project ? path.join(root, project) : root
  fs.mkdirSync(dir, { recursive: true })
  const outPath = path.join(dir, baseName)

  // Tags: what the operator typed, plus what the file itself can tell us.
  const typedTags = String(params['tags'] ?? '').split(',').map(slugify).filter(Boolean)
  const suggested: string[] = []
  try {
    const r = doc.getRoot()
    if (r.listSkins().length) suggested.push('rigged')
    if (r.listAnimations().length) {
      suggested.push('animated')
      for (const a of r.listAnimations()) {
        const n = slugify(a.getName())
        if (n) suggested.push(`clip-${n}`)
      }
    }
    if (r.listTextures().length) suggested.push('textured')
    let tris = 0
    for (const m of r.listMeshes())
      for (const prim of m.listPrimitives()) {
        const idx = prim.getIndices()
        tris += idx ? idx.getCount() / 3
                    : (prim.getAttribute('POSITION')?.getCount() ?? 0) / 3
      }
    tris = Math.round(tris)
    suggested.push(tris < 5000 ? 'low-poly' : tris > 100000 ? 'high-poly' : 'mid-poly')
    if (project) suggested.push(project)
  } catch (e) {
    context.log(`tagging skipped: ${e}`)
  }
  const sourceSidecar = readSidecar(input.filePath)
  const tags = Array.from(new Set([
    ...stringArray(sourceSidecar.tags),
    ...typedTags,
    ...suggested,
  ]))

  // Lineage: only recorded when the input actually traces back to an existing
  // workspace asset — a fresh generation has nothing to chain to.
  const derivedFrom = resolveDerivedFrom(input.sourceAssetPath, context.workspaceDir)
  const existingOutputSidecar = readSidecar(outPath)
  const outputSidecar: Sidecar = {
    // Preserve the complete traveling record and any future metadata fields.
    // The exporter owns only the catalog fields below.
    ...sourceSidecar,
    ...existingOutputSidecar,
    name:    typed || existingOutputSidecar.name || sourceSidecar.name || null,
    project: params['project'] || existingOutputSidecar.project || sourceSidecar.project || null,
    tags: Array.from(new Set([
      ...stringArray(existingOutputSidecar.tags),
      ...tags,
    ])),
    ...(derivedFrom
      ? { derived_from: derivedFrom }
      : (existingOutputSidecar.derived_from ?? sourceSidecar.derived_from)
        ? { derived_from: existingOutputSidecar.derived_from ?? sourceSidecar.derived_from }
        : {}),
    created: existingOutputSidecar.created || new Date().toISOString(),
  }

  try {
    const asset = doc.getRoot().getAsset()
    asset.extras = Object.assign({}, asset.extras, {
      modly: { name: typed || null, project: params['project'] || null, tags },
    })
  } catch (e) {
    context.log(`could not embed tags: ${e}`)
  }

  context.progress(50, `Exporting as ${format.toUpperCase()}…`)

  if (format === 'glb') {
    await io.write(outPath, doc)
  } else {
    const prims = extractPrimitives(doc)
    if (prims.length === 0) throw new Error('mesh-exporter: no mesh data found in input')
    if      (format === 'stl') writeSTL(prims, outPath)
    else if (format === 'obj') writeOBJ(prims, outPath)
    else if (format === 'ply') writePLY(prims, outPath)
  }

  // Publish metadata only after the asset exists. This also prevents a failed
  // conversion from leaving a catalog entry that points at no model.
  writeSidecarAtomic(outPath, outputSidecar)

  context.progress(100, 'Done')
  context.log(`Output: ${outPath}`)
  return { filePath: outPath }
}

export = processor

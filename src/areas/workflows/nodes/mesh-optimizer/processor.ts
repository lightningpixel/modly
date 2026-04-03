/* eslint-disable @typescript-eslint/no-require-imports */
import path = require('path')

interface ProcessInput  { filePath?: string; text?: string }
interface ProcessResult { filePath?: string; text?: string }
interface ProcessContext {
  workspaceDir: string
  tempDir:      string
  log:          (msg: string) => void
  progress:     (pct: number, label: string) => void
}

const processor = async (
  input:   ProcessInput,
  params:  Record<string, unknown>,
  context: ProcessContext,
): Promise<ProcessResult> => {
  if (!input.filePath) throw new Error('mesh-optimizer: input.filePath is required')

  const targetFaces = Math.max(100, Math.round(Number(params['target_faces'] ?? 10000)))
  context.log(`Target: ${targetFaces} triangles — input: ${input.filePath}`)

  // Lazy requires — resolved from the extension's own node_modules
  const { NodeIO }             = require('@gltf-transform/core')
  const { simplify, weld }     = require('@gltf-transform/functions')
  const { MeshoptSimplifier }  = require('meshoptimizer')

  // MeshoptSimplifier loads a WASM binary asynchronously
  await MeshoptSimplifier.ready

  context.progress(10, 'Loading mesh…')
  const io  = new NodeIO()
  const doc = await io.read(input.filePath)

  // Count current triangles across all primitives
  let currentFaces = 0
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const indices = prim.getIndices()
      if (indices) {
        currentFaces += Math.round(indices.getCount() / 3)
      } else {
        const pos = prim.getAttribute('POSITION')
        if (pos) currentFaces += Math.round(pos.getCount() / 3)
      }
    }
  }
  context.log(`Current triangles: ${currentFaces}`)

  if (currentFaces <= targetFaces) {
    context.log('Already within target — skipping simplification')
    context.progress(100, 'Done')
    return { filePath: input.filePath }
  }

  const ratio = Math.min(1, targetFaces / currentFaces)
  context.log(`Simplification ratio: ${ratio.toFixed(4)} (~${Math.round(currentFaces * ratio)} triangles)`)

  // error tolerance scales with aggressiveness: tighter simplification needs more room
  const error = Math.max(0.001, 1 - ratio)

  context.progress(25, 'Welding vertices…')
  await doc.transform(weld())

  context.progress(55, 'Simplifying mesh…')
  await doc.transform(
    simplify({ simplifier: MeshoptSimplifier, ratio, error, lockBorder: false }),
  )

  context.progress(85, 'Writing output…')
  // Save to workspaceDir/Workflows/ so the result lands in the workspace
  const outDir  = path.join(context.workspaceDir, 'Workflows')
  require('fs').mkdirSync(outDir, { recursive: true })
  const outPath = path.join(outDir, `mesh-optimizer-${Date.now()}.glb`)
  await io.write(outPath, doc)

  context.progress(100, 'Done')
  context.log(`Output: ${outPath}`)

  return { filePath: outPath }
}

export = processor

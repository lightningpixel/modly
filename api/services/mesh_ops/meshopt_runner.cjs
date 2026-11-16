/**
 * meshoptimizer backend for the Python mesh-op registry.
 *
 * Dependencies are resolved from the built-in mesh-optimizer extension so the
 * packaged app keeps one copy of glTF Transform and meshoptimizer.
 */
const fs = require('fs')
const path = require('path')
const Module = require('module')

function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function progress(percent, label) {
  emit({ type: 'progress', percent, label })
}

function log(message) {
  emit({ type: 'log', message: String(message) })
}

function countTriangles(document) {
  let count = 0
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const indices = primitive.getIndices()
      if (indices) {
        count += Math.round(indices.getCount() / 3)
      } else {
        const positions = primitive.getAttribute('POSITION')
        if (positions) count += Math.round(positions.getCount() / 3)
      }
    }
  }
  return count
}

async function run(payload) {
  const requireExtension = Module.createRequire(
    path.join(payload.dependencyDir, 'package.json'),
  )
  const { NodeIO } = requireExtension('@gltf-transform/core')
  const { ALL_EXTENSIONS } = requireExtension('@gltf-transform/extensions')
  const { simplify, weld } = requireExtension('@gltf-transform/functions')
  const { MeshoptSimplifier } = requireExtension('meshoptimizer')

  const targetFaces = Math.max(
    100,
    Math.round(Number(payload.params?.target_faces ?? 10000)),
  )
  log(`Target: ${targetFaces} triangles — input: ${payload.inputPath}`)

  await MeshoptSimplifier.ready

  progress(10, 'Loading mesh…')
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  const document = await io.read(payload.inputPath)
  const currentFaces = countTriangles(document)
  log(`Current triangles: ${currentFaces}`)

  if (currentFaces <= targetFaces) {
    log('Already within target — skipping simplification')
    if (!payload.outputPath) {
      progress(100, 'Done')
      return { filePath: payload.inputPath, faceCount: currentFaces }
    }

    fs.mkdirSync(path.dirname(payload.outputPath), { recursive: true })
    progress(85, 'Writing output…')
    await io.write(payload.outputPath, document)
    progress(100, 'Done')
    log(`Output: ${payload.outputPath}`)
    return { filePath: payload.outputPath, faceCount: currentFaces }
  }

  const ratio = Math.min(1, targetFaces / currentFaces)
  log(
    `Simplification ratio: ${ratio.toFixed(4)} `
      + `(~${Math.round(currentFaces * ratio)} triangles)`,
  )
  const error = Math.max(0.001, 1 - ratio)

  if (currentFaces < 500000) {
    progress(25, 'Welding vertices…')
    await document.transform(weld())
  } else {
    log(`Skipping weld (${currentFaces} faces > 500k threshold)`)
  }

  progress(55, 'Simplifying mesh…')
  await document.transform(
    simplify({ simplifier: MeshoptSimplifier, ratio, error, lockBorder: false }),
  )

  progress(85, 'Writing output…')
  const outputPath = payload.outputPath || path.join(
    payload.workspaceDir,
    'Workflows',
    `mesh-optimizer-${Date.now()}.glb`,
  )
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  await io.write(outputPath, document)

  progress(100, 'Done')
  log(`Output: ${outputPath}`)
  return { filePath: outputPath, faceCount: countTriangles(document) }
}

async function main() {
  const raw = fs.readFileSync(0, 'utf8').trim()
  if (!raw) throw new Error('mesh-optimizer: missing request payload')
  const result = await run(JSON.parse(raw))
  emit({ type: 'done', result })
}

main().catch((error) => {
  emit({ type: 'error', message: String(error) })
  process.exitCode = 1
})

// Builds the OrcaSlicer deeplink for a generated mesh.
//
// OrcaSlicer registers the `orcaslicer://open?file=<url>` scheme; its handler
// downloads the http(s) URL in `file=` and imports it, deriving the filename —
// and therefore the mesh format — from the URL's FINAL path segment. That means
// the served URL must be path-only and end in a real `model.<ext>` with NO
// query string, and the whole thing must be percent-encoded. OrcaSlicer cannot
// import GLB, so we point at the backend's slicer-export route which converts to
// STL on the fly.

/** Format handed to OrcaSlicer. STL is universal and OrcaSlicer auto-repairs it. */
export const SLICER_FORMAT = 'stl'

/** Prefix of an imported mesh served from outside the workspace. */
const SERVE_FILE_PREFIX = '/optimize/serve-file?path='

/**
 * Source formats the slicer route can convert. Gaussian splats (`.splat`, and
 * the `.ply` they are delivered in) are point clouds, not printable meshes.
 */
const SLICEABLE_SOURCE = /\.(glb|gltf|obj|stl)$/i

/** URL-safe base64 (no padding) of a UTF-8 string — matches the API's token decode. */
export function encodeWorkspacePathToken(workspacePath: string): string {
  const bytes = new TextEncoder().encode(workspacePath)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * The source path the slicer route should convert, or `undefined` when the
 * output cannot be sliced.
 *
 * Two output shapes reach the viewer: a workspace URL (generated or
 * workflow-produced meshes) and a `serve-file` URL (meshes the user imported
 * from elsewhere on disk). Both are sliceable — the API accepts the absolute
 * path of an import because it recorded that the user picked it themselves.
 */
function sliceableSourcePath(outputUrl: string | undefined): string | undefined {
  if (!outputUrl) return undefined

  if (outputUrl.startsWith('/workspace/')) {
    const workspacePath = outputUrl.slice('/workspace/'.length)
    return SLICEABLE_SOURCE.test(workspacePath) ? workspacePath : undefined
  }

  if (outputUrl.startsWith(SERVE_FILE_PREFIX)) {
    const absolutePath = decodeURIComponent(outputUrl.slice(SERVE_FILE_PREFIX.length))
    return SLICEABLE_SOURCE.test(absolutePath) ? absolutePath : undefined
  }

  return undefined
}

/**
 * Whether a generation output can be opened in OrcaSlicer: it must be a mesh in
 * a format the slicer route converts, served either from the workspace or as a
 * user-selected import.
 */
export function canOpenInOrcaSlicer(outputUrl: string | undefined): boolean {
  return sliceableSourcePath(outputUrl) !== undefined
}

/**
 * Build the `orcaslicer://open?file=...` deeplink for a generated mesh.
 *
 * @param apiUrl    Modly backend origin, e.g. `http://localhost:8765`
 * @param outputUrl workspace or serve-file URL of the mesh
 * @throws if `outputUrl` is not sliceable — guard with {@link canOpenInOrcaSlicer}
 */
export function buildOrcaSlicerDeepLink(apiUrl: string, outputUrl: string): string {
  const sourcePath = sliceableSourcePath(outputUrl)
  if (!sourcePath) throw new Error(`Not sliceable: ${outputUrl}`)
  const token = encodeWorkspacePathToken(sourcePath)
  const base = apiUrl.replace(/\/+$/, '')
  const modelUrl = `${base}/export/slicer/${SLICER_FORMAT}/${token}/model.${SLICER_FORMAT}`
  return `orcaslicer://open?file=${encodeURIComponent(modelUrl)}`
}

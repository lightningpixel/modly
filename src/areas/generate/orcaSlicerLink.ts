// Builds the OrcaSlicer deeplink for a generated mesh.
//
// OrcaSlicer registers the `orcaslicer://open?file=<url>` scheme; its handler
// downloads the http(s) URL in `file=` and imports it, deriving the filename —
// and therefore the mesh format — from the URL's FINAL path segment. That means
// the served URL must be path-only and end in a real `model.<ext>` with NO
// query string, and the whole thing must be percent-encoded. OrcaSlicer cannot
// import GLB, so we point at the backend's slicer-export route which converts to
// STL on the fly.
//
// OrcaSlicer is an external app: it fetches that URL without the API token, so
// the URL carries a signature of the source path instead. Only the backend can
// sign (the renderer never sees the token): ask `GET /export/slicer-link` for
// the `url_path` of `orcaSlicerSourcePath(outputUrl)`, then build the deeplink
// with `orcaSlicerDeepLink`. Links stop working when Modly restarts.

/** Format handed to OrcaSlicer. STL is universal and OrcaSlicer auto-repairs it. */
export const SLICER_FORMAT = 'stl'

/** Prefix of an imported mesh served from outside the workspace. */
const SERVE_FILE_PREFIX = '/optimize/serve-file?path='

/**
 * Source formats the slicer route can convert. Gaussian splats (`.splat`, and
 * the `.ply` they are delivered in) are point clouds, not printable meshes.
 */
const SLICEABLE_SOURCE = /\.(glb|gltf|obj|stl)$/i

/**
 * The source path the slicer route should convert, or `undefined` when the
 * output cannot be sliced.
 *
 * Two output shapes reach the viewer: a workspace URL (generated or
 * workflow-produced meshes) and a `serve-file` URL (meshes the user imported
 * from elsewhere on disk). Both are sliceable — the API accepts the absolute
 * path of an import because it recorded that the user picked it themselves.
 */
export function orcaSlicerSourcePath(outputUrl: string | undefined): string | undefined {
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
  return orcaSlicerSourcePath(outputUrl) !== undefined
}

/**
 * The `orcaslicer://open?file=...` deeplink for a signed slicer URL.
 *
 * @param apiUrl  Modly backend origin, e.g. `http://localhost:8765`
 * @param urlPath `url_path` returned by `GET /export/slicer-link`
 *                (`/export/slicer/stl/<signed token>/model.stl`)
 */
export function orcaSlicerDeepLink(apiUrl: string, urlPath: string): string {
  const base = apiUrl.replace(/\/+$/, '')
  const path = urlPath.startsWith('/') ? urlPath : `/${urlPath}`
  return `orcaslicer://open?file=${encodeURIComponent(`${base}${path}`)}`
}

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

/** URL-safe base64 (no padding) of a UTF-8 string — matches the API's token decode. */
export function encodeWorkspacePathToken(workspacePath: string): string {
  const bytes = new TextEncoder().encode(workspacePath)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Whether a generation output can be opened in OrcaSlicer: it must be a mesh
 * served from the workspace (Gaussian splats and non-workspace imports are not
 * sliceable through this route).
 */
export function canOpenInOrcaSlicer(outputUrl: string | undefined): boolean {
  if (!outputUrl) return false
  return outputUrl.startsWith('/workspace/') && !/\.(ply|splat)$/i.test(outputUrl)
}

/**
 * Build the `orcaslicer://open?file=...` deeplink for a generated mesh.
 *
 * @param apiUrl    Modly backend origin, e.g. `http://localhost:8765`
 * @param outputUrl workspace URL of the mesh, e.g. `/workspace/Foo/hero.glb`
 */
export function buildOrcaSlicerDeepLink(apiUrl: string, outputUrl: string): string {
  const workspacePath = outputUrl.replace(/^\/workspace\//, '')
  const token = encodeWorkspacePathToken(workspacePath)
  const base = apiUrl.replace(/\/+$/, '')
  const modelUrl = `${base}/export/slicer/${SLICER_FORMAT}/${token}/model.${SLICER_FORMAT}`
  return `orcaslicer://open?file=${encodeURIComponent(modelUrl)}`
}

import type { SceneArtifactManifestInitialView, SceneArtifactManifestPreview, SceneArtifactManifestV1 } from '../../shared/types/artifacts'

export const SCENE_MANIFEST_FILE_NAME = 'scene-manifest.json'

export type SceneSourceKind = 'manifest' | 'directory'

export type ResolveSceneSourceSuccess = {
  ok: true
  sourceKind: SceneSourceKind
  inputWorkspacePath: string
  manifestWorkspacePath: string
  manifestAbsolutePath: string
  sceneRoot: string
  manifest: SceneArtifactManifestV1
}

export type ResolveSceneSourceFailure = {
  ok: false
  error: string
}

export type ResolveSceneSourceResult = ResolveSceneSourceSuccess | ResolveSceneSourceFailure

export function applySceneValidationResult(
  currentParams: Record<string, unknown>,
  validatedPath: string,
  resolution: ResolveSceneSourceResult,
): Record<string, unknown> | undefined {
  if (currentParams.path !== validatedPath) return undefined

  if (!resolution.ok) {
    return {
      ...currentParams,
      manifestPath: undefined,
      sceneRoot: undefined,
      sourceKind: undefined,
      error: resolution.error,
    }
  }

  return {
    ...currentParams,
    path: resolution.inputWorkspacePath,
    manifestPath: resolution.manifestWorkspacePath,
    sceneRoot: resolution.sceneRoot,
    sourceKind: resolution.sourceKind,
    error: undefined,
  }
}

export function invalidateValidatedScenePath(
  params: Record<string, unknown>,
  nextPath: string,
): Record<string, unknown> {
  return {
    ...params,
    path: nextPath,
    manifestPath: undefined,
    sceneRoot: undefined,
    sourceKind: undefined,
    error: undefined,
  }
}

type ResolveSceneSourceArgs = {
  scenePath: string
  workspaceDir: string
  readFileBase64: (filePath: string) => Promise<string>
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:\//.test(value)
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '')
}

function isSafeRelativePath(value: unknown, allowDot = false): value is string {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.includes('\u0000')) return false
  const normalized = value.replace(/\\/g, '/')
  if (allowDot && normalized === '.') return true
  if (isAbsolutePath(normalized) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(normalized)
    || /%(?:25|2e|2f|5c|00)/i.test(normalized) || /%(?![0-9a-f]{2})/i.test(normalized)) return false
  return normalized.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

function normalizeWorkspaceRelativePath(value: string | undefined, workspaceDir: string): string | undefined {
  const normalizedValue = value?.replace(/\\/g, '/')
  if (!normalizedValue) return undefined

  const normalizedWorkspace = trimTrailingSlashes(workspaceDir.replace(/\\/g, '/'))
  let relativePath: string | undefined

  if (normalizedValue.startsWith('/workspace/')) {
    relativePath = normalizedValue.slice('/workspace/'.length)
  } else if (normalizedValue === normalizedWorkspace) {
    return undefined
  } else if (normalizedValue.startsWith(`${normalizedWorkspace}/`)) {
    relativePath = normalizedValue.slice(normalizedWorkspace.length + 1)
  } else if (!isAbsolutePath(normalizedValue)) {
    relativePath = normalizedValue
  }

  if (!relativePath) return undefined
  return isSafeRelativePath(relativePath) ? relativePath : undefined
}

function resolveSceneSourceKind(inputWorkspacePath: string): SceneSourceKind | undefined {
  if (inputWorkspacePath === SCENE_MANIFEST_FILE_NAME || inputWorkspacePath.endsWith(`/${SCENE_MANIFEST_FILE_NAME}`)) {
    return 'manifest'
  }
  if (inputWorkspacePath.toLowerCase().endsWith('.json')) return undefined
  return 'directory'
}

function decodeBase64Utf8(base64: string): string {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSafePreviewReference(value: unknown): value is string {
  return isSafeRelativePath(value)
}

function isSceneManifestPreview(value: unknown): value is SceneArtifactManifestPreview {
  return isPlainObject(value)
    && (!('image' in value) || isSafePreviewReference(value.image))
    && (!('video' in value) || isSafePreviewReference(value.video))
}

function isFiniteTriple(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3
    && value.every((component) => typeof component === 'number' && Number.isFinite(component))
}

function isSceneManifestInitialView(value: unknown): value is SceneArtifactManifestInitialView {
  if (!isPlainObject(value)) return false
  const { position, target, up } = value
  if (!isFiniteTriple(position) || !isFiniteTriple(target)) return false
  if (position.every((component, index) => component === target[index])) return false
  return up === undefined || (isFiniteTriple(up) && up.some((component) => component !== 0))
}

function normalizeSceneRoot(sceneRoot: unknown): string | undefined {
  return isSafeRelativePath(sceneRoot, true) ? sceneRoot.replace(/\\/g, '/') : undefined
}

function validateSceneManifest(manifest: unknown): { ok: true; manifest: SceneArtifactManifestV1; sceneRoot: string } | { ok: false; error: string } {
  if (!isPlainObject(manifest)) {
    return { ok: false, error: 'Scene manifest must be a JSON object.' }
  }
  if (manifest.schema !== 'modly.scene-manifest.v1') {
    return { ok: false, error: 'Scene manifest schema must be modly.scene-manifest.v1.' }
  }

  const rawSceneRoot = manifest.sceneRoot
  const sceneRoot = normalizeSceneRoot(rawSceneRoot)
  if (typeof rawSceneRoot !== 'string' || !sceneRoot) {
    return { ok: false, error: 'Scene manifest sceneRoot must be a safe relative path.' }
  }
  if (!Array.isArray(manifest.assets)) {
    return { ok: false, error: 'Scene manifest assets must be an array.' }
  }
  if (manifest.assets.some((asset) => isPlainObject(asset)
    && (('workspacePath' in asset && !isSafeRelativePath(asset.workspacePath))
      || ('path' in asset && !isSafeRelativePath(asset.path))))) {
    return { ok: false, error: 'Scene manifest asset paths must be safe relative file references.' }
  }

  const { preview, initialView, ...metadata } = manifest
  if (preview !== undefined && !isPlainObject(preview)) {
    return { ok: false, error: 'Scene manifest preview must be a JSON object.' }
  }
  if (preview !== undefined && !isSceneManifestPreview(preview)) {
    return { ok: false, error: 'Scene manifest preview image/video must be safe relative file references.' }
  }
  if (initialView !== undefined && !isPlainObject(initialView)) {
    return { ok: false, error: 'Scene manifest initialView must be a JSON object.' }
  }
  if (initialView !== undefined && !isSceneManifestInitialView(initialView)) {
    return { ok: false, error: 'Scene manifest initialView requires distinct finite numeric position/target triples and optional non-zero finite up.' }
  }

  return {
    ok: true,
    sceneRoot,
    manifest: {
      ...metadata,
      schema: 'modly.scene-manifest.v1',
      sceneRoot: rawSceneRoot,
      assets: manifest.assets,
      ...(preview !== undefined ? { preview } : {}),
      ...(initialView !== undefined ? { initialView } : {}),
    },
  }
}

export async function resolveSceneSourceManifest(args: ResolveSceneSourceArgs): Promise<ResolveSceneSourceResult> {
  const inputWorkspacePath = normalizeWorkspaceRelativePath(args.scenePath, args.workspaceDir)
  if (!inputWorkspacePath) {
    return { ok: false, error: 'Load Scene requires a safe workspace-relative scene path.' }
  }

  const sourceKind = resolveSceneSourceKind(inputWorkspacePath)
  if (!sourceKind) {
    return { ok: false, error: `Load Scene accepts ${SCENE_MANIFEST_FILE_NAME} or a scene directory.` }
  }

  const manifestWorkspacePath = sourceKind === 'manifest'
    ? inputWorkspacePath
    : `${inputWorkspacePath}/${SCENE_MANIFEST_FILE_NAME}`
  const normalizedWorkspace = trimTrailingSlashes(args.workspaceDir.replace(/\\/g, '/'))
  const manifestAbsolutePath = `${normalizedWorkspace}/${manifestWorkspacePath}`

  let manifestRaw: string
  try {
    manifestRaw = decodeBase64Utf8(await args.readFileBase64(manifestAbsolutePath))
  } catch (error) {
    return { ok: false, error: `Unable to read scene manifest: ${String(error)}` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(manifestRaw)
  } catch (error) {
    return { ok: false, error: `Scene manifest is not valid JSON: ${String(error)}` }
  }

  const validation = validateSceneManifest(parsed)
  if (!validation.ok) return validation

  return {
    ok: true,
    sourceKind,
    inputWorkspacePath,
    manifestWorkspacePath,
    manifestAbsolutePath,
    sceneRoot: validation.sceneRoot,
    manifest: validation.manifest,
  }
}

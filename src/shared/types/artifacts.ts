export interface ArtifactProvenance {
  workflowId?: string
  workflowNodeId?: string
  source?: string
  [key: string]: unknown
}

export interface SceneArtifactManifestPreview { image?: string; video?: string }
export interface SceneArtifactManifestInitialView {
  position: [number, number, number]
  target: [number, number, number]
  up?: [number, number, number]
}
export interface SceneArtifactManifestV1 {
  schema: 'modly.scene-manifest.v1'
  sceneRoot: string
  assets: unknown[]
  preview?: SceneArtifactManifestPreview
  initialView?: SceneArtifactManifestInitialView
}

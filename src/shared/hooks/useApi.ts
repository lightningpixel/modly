import axios from 'axios'
import { useAppStore } from '@shared/stores/appStore'
import { createGenerationApi } from '../utils/generationRunner'
import type { MeshOpDescriptor, MeshOpResponse } from '@areas/generate/meshEditPanel'
import type { VertexPatch } from '@areas/generate/sculpt/sculptLogic'

export function useApi() {
  const apiUrl = useAppStore((s) => s.apiUrl)

  const client = axios.create({ baseURL: apiUrl })

  const { generateFromImage, pollJobStatus, cancelJob } = createGenerationApi(apiUrl)

  async function getModelStatus(): Promise<{
    downloaded: boolean
    name: string
    size_gb: number
    progress?: number
  }> {
    const { data } = await client.get('/model/status')
    return data
  }

  async function getAllModelsStatus(): Promise<{ id: string; name: string; downloaded: boolean }[]> {
    const { data } = await client.get('/model/all')
    return data
  }

  async function downloadModel(
    onProgress?: (pct: number) => void
  ): Promise<void> {
    const response = await client.get('/model/download', {
      responseType: 'stream'
    })

    const reader = response.data
    reader.on('data', (chunk: Buffer) => {
      try {
        const line = chunk.toString().replace('data: ', '').trim()
        if (line) {
          const { progress } = JSON.parse(line)
          onProgress?.(progress)
        }
      } catch {
        // ignore parse errors
      }
    })

    await new Promise<void>((resolve, reject) => {
      reader.on('end', resolve)
      reader.on('error', reject)
    })
  }

  async function optimizeMesh(
    path: string,
    targetFaces: number,
  ): Promise<{ url: string; faceCount: number }> {
    const { data } = await client.post<{ url: string; face_count: number }>('/optimize/mesh', {
      path,
      target_faces: targetFaces,
    })
    return { url: data.url, faceCount: data.face_count }
  }

  async function smoothMesh(
    path: string,
    iterations: number,
  ): Promise<{ url: string }> {
    const { data } = await client.post<{ url: string }>('/optimize/smooth', {
      path,
      iterations,
    })
    return { url: data.url }
  }

  async function importMesh(filePath: string): Promise<{ url: string }> {
    const { data } = await client.post<{ url: string }>('/optimize/import-by-path', { path: filePath })
    return { url: data.url }
  }

  // Bakes a world-space 4x4 transform into the GLB geometry.
  // `matrix` is row-major (4 rows of 4), matching the backend's reshape.
  async function transformMesh(
    path: string,
    matrix: number[][],
  ): Promise<{ url: string }> {
    const { data } = await client.post<{ url: string }>('/optimize/transform', {
      path,
      matrix,
    })
    return { url: data.url }
  }

  // Mesh-ops registry: every op the chat agent can run, with its params schema.
  async function listMeshOps(): Promise<MeshOpDescriptor[]> {
    const { data } = await client.get<MeshOpDescriptor[]>('/optimize/ops')
    return data
  }

  // Runs one registry op. The response carries `url` when a new mesh was
  // written; analysis ops (inspect_mesh, suggest_fixes) return only a report.
  async function runMeshOp(
    opId: string,
    path: string,
    params: Record<string, unknown>,
  ): Promise<MeshOpResponse> {
    const { data } = await client.post<MeshOpResponse>(`/optimize/op/${encodeURIComponent(opId)}`, {
      path,
      params,
    })
    return data
  }

  // Writes sculpted vertex positions/normals into a copy of the mesh file.
  // Each patch replaces whole attributes of one glTF primitive (base64 LE float32).
  async function patchMeshVertices(
    path: string,
    patches: VertexPatch[],
  ): Promise<{ path: string; url: string }> {
    const { data } = await client.post<{ path: string; url: string }>('/optimize/patch-vertices', {
      path,
      patches,
    })
    return data
  }

  return { generateFromImage, pollJobStatus, cancelJob, getModelStatus, getAllModelsStatus, downloadModel, optimizeMesh, smoothMesh, importMesh, transformMesh, listMeshOps, runMeshOp, patchMeshVertices }
}

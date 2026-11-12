import axios from 'axios'
import { useAppStore } from '@shared/stores/appStore'
import { createGenerationApi } from '../utils/generationRunner'

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

  return { generateFromImage, pollJobStatus, cancelJob, getModelStatus, getAllModelsStatus, downloadModel, optimizeMesh, smoothMesh, importMesh, transformMesh }
}

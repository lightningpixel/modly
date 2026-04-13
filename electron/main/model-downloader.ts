/**
 * ModelDownloader — downloads models via the SSE endpoint of the Python backend.
 * No longer depends on the Go API catalog.
 */
import { existsSync, readdirSync, statSync, readFileSync } from 'fs'
import { join } from 'path'
import { getSettings } from './settings-store'
import { app } from 'electron'

export interface DownloadProgress {
  percent: number
  file?: string
  fileIndex?: number
  totalFiles?: number
  status?: string
}
export type ProgressCallback = (progress: DownloadProgress) => void

const PYTHON_API_URL = process.env['PYTHON_API_URL'] ?? 'http://127.0.0.1:8765'

// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

/**
 * Check if a model is already downloaded (directory exists and is non-empty).
 */
export function isModelDownloaded(modelsDir: string, modelId: string): boolean {
  const modelDir = join(modelsDir, modelId)
  if (!existsSync(modelDir)) return false
  try {
    return readdirSync(modelDir).length > 0
  } catch {
    return false
  }
}

/**
 * Recursively compute the total size in bytes of a directory.
 */
function dirSizeBytes(dirPath: string): number {
  let total = 0
  try {
    for (const entry of readdirSync(dirPath)) {
      const full = join(dirPath, entry)
      try {
        const s = statSync(full)
        total += s.isDirectory() ? dirSizeBytes(full) : s.size
      } catch { /* skip unreadable entries */ }
    }
  } catch { /* skip unreadable dir */ }
  return total
}

/**
 * Read HuggingFace download metadata files to get declared file sizes.
 * HF stores these at <modelDir>/.cache/huggingface/download/<filename>.metadata
 * Each file is JSON with a "size" field (bytes).
 * Used as fallback when dirSizeBytes returns near-zero (e.g. symlinks on Windows).
 */
function getModelSizeFromHFMetadata(modelDir: string): number {
  const cacheDir = join(modelDir, '.cache', 'huggingface', 'download')
  if (!existsSync(cacheDir)) return 0
  let total = 0
  try {
    for (const entry of readdirSync(cacheDir)) {
      if (!entry.endsWith('.metadata')) continue
      try {
        const data = JSON.parse(readFileSync(join(cacheDir, entry), 'utf-8'))
        if (typeof data.size === 'number' && data.size > 0) total += data.size
      } catch { /* skip malformed metadata */ }
    }
  } catch { /* skip unreadable cache dir */ }
  return total
}

/**
 * List all locally downloaded models by scanning the models directory.
 * Returns id, name and size_gb (rounded to 1 decimal).
 */
export function listDownloadedModels(modelsDir: string): { id: string; name: string; size_gb: number }[] {
  if (!existsSync(modelsDir)) return []
  try {
    return readdirSync(modelsDir)
      .filter((name) => {
        try {
          const dir = join(modelsDir, name)
          return statSync(dir).isDirectory() && readdirSync(dir).length > 0
        } catch {
          return false
        }
      })
      .map((name) => {
        const modelDir = join(modelsDir, name)
        let bytes = dirSizeBytes(modelDir)
        // Fallback: if near-zero (symlinks not followed), use HF metadata declared sizes
        if (bytes < 1_000_000) bytes = getModelSizeFromHFMetadata(modelDir)
        const size_gb = Math.round(bytes / 1e9 * 10) / 10
        return { id: name, name, size_gb }
      })
  } catch {
    return []
  }
}

/**
 * Download a model from HuggingFace Hub via the Python FastAPI SSE endpoint.
 * Reports progress (0–100) via the onProgress callback.
 */
export async function downloadModelFromHF(
  repoId:        string,
  modelId:       string,
  onProgress:    ProgressCallback,
  skipPrefixes?: string[],
): Promise<void> {
  const { net } = require('electron')
  let url = `${PYTHON_API_URL}/model/hf-download?repo_id=${encodeURIComponent(repoId)}&model_id=${encodeURIComponent(modelId)}`
  if (skipPrefixes && skipPrefixes.length > 0) {
    url += `&skip_prefixes=${encodeURIComponent(JSON.stringify(skipPrefixes))}`
  }
  const hfToken = getSettings(app.getPath('userData')).hfToken
  if (hfToken) {
    url += `&token=${encodeURIComponent(hfToken)}`
  }

  const res = await net.fetch(url)
  if (!res.ok) throw new Error(`HuggingFace download failed: HTTP ${res.status}`)
  if (!res.body) throw new Error('No response body from HF download stream')

  const decoder = new TextDecoder()
  const reader  = res.body.getReader()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      try {
        const data = JSON.parse(line.slice(6))
        if (typeof data.percent === 'number') onProgress({
          percent:    data.percent,
          file:       data.file,
          fileIndex:  data.fileIndex,
          totalFiles: data.totalFiles,
          status:     data.status,
        })
        if (data.error) throw new Error(`HF download error: ${data.error}`)
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('HF download error:')) throw e
      }
    }
  }
}

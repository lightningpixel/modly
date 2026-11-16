import { basename } from 'node:path'
import { readFile, stat } from 'node:fs/promises'

export const SCENE_MANIFEST_FILE_NAME = 'scene-manifest.json'
export const MAX_SCENE_MANIFEST_BYTES = 1024 * 1024

type FileReadDependencies = {
  statFile: (filePath: string) => Promise<{ size: number; isFile: () => boolean }>
  readBytes: (filePath: string) => Promise<Uint8Array>
}

const DEFAULT_DEPENDENCIES: FileReadDependencies = {
  statFile: stat,
  readBytes: readFile,
}

export async function readLocalFileBase64(
  filePath: string,
  dependencies: FileReadDependencies = DEFAULT_DEPENDENCIES,
): Promise<string> {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new Error('fs:readFileBase64 requires a non-empty file path')
  }

  const isSceneManifest = basename(filePath) === SCENE_MANIFEST_FILE_NAME
  if (isSceneManifest) {
    const fileInfo = await dependencies.statFile(filePath)
    if (!fileInfo.isFile()) throw new Error('Scene manifest is not a file')
    if (fileInfo.size > MAX_SCENE_MANIFEST_BYTES) {
      throw new Error('Scene manifest exceeds the 1 MiB limit')
    }
  }

  const bytes = await dependencies.readBytes(filePath)
  // Recheck the transferred bytes in case the file grew between stat and read.
  if (isSceneManifest && bytes.byteLength > MAX_SCENE_MANIFEST_BYTES) {
    throw new Error('Scene manifest exceeds the 1 MiB limit')
  }
  return Buffer.from(bytes).toString('base64')
}

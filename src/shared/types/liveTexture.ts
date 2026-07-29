export type TextureWatchState = 'reading' | 'ready' | 'error'

export interface TextureWatchUpdate {
  state: TextureWatchState
  filePath: string
  fileName: string
  revision: number
  changedAt: number
  savedAt?: number
  width?: number
  height?: number
  dataUrl?: string
  message?: string
}

export type TextureWatchChoice =
  | { cancelled: true }
  | { cancelled: false; update: TextureWatchUpdate }

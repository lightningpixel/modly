import { useEffect, useState } from 'react'

// Small previews of run input images. The file is read once through the fs
// IPC bridge, drawn into a tiny canvas and kept as a data URL in memory, so a
// list of runs costs one read per image per session. Reads run one at a time.

const PREVIEW_SIZE = 96
const MAX_CACHED = 200

const cache = new Map<string, Promise<string | null>>()
let tail: Promise<unknown> = Promise.resolve()

function mimeFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase()
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  return 'image/png'
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Could not decode the image'))
    image.src = src
  })
}

async function renderPreview(path: string): Promise<string | null> {
  try {
    const base64 = await window.electron.fs.readFileBase64(path)
    const image = await loadImage(`data:${mimeFor(path)};base64,${base64}`)
    const scale = PREVIEW_SIZE / Math.max(image.naturalWidth, image.naturalHeight, 1)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.naturalWidth * Math.min(1, scale)))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * Math.min(1, scale)))
    canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/webp', 0.8)
  } catch {
    return null
  }
}

/** A downscaled data URL of the image at `path`, or null when it cannot be read. */
export function loadInputPreview(path: string): Promise<string | null> {
  const cached = cache.get(path)
  if (cached) return cached
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value as string)
  const job = tail.then(() => renderPreview(path))
  tail = job
  cache.set(path, job)
  return job
}

export function useInputPreview(path: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    setUrl(null)
    if (!path) return
    let alive = true
    void loadInputPreview(path).then((result) => { if (alive) setUrl(result) })
    return () => { alive = false }
  }, [path])
  return url
}

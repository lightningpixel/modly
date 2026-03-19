import { useState, useCallback } from 'react'
import { useAppStore } from '@shared/stores/appStore'
import { useGeneration } from '@shared/hooks/useGeneration'

export default function ImageUpload(): JSX.Element {
  const { currentJob } = useGeneration()
  const { setSelectedImagePath, selectedImagePreviewUrl, setSelectedImagePreviewUrl, setSelectedImageData } = useAppStore()
  const [isDragging, setIsDragging] = useState(false)

  const isGenerating = currentJob?.status === 'uploading' || currentJob?.status === 'generating'

  const handleFileSelect = useCallback(async () => {
    const path = await window.electron.fs.selectImage()
    if (!path) return
    setSelectedImageData(null)
    setSelectedImagePath(path)

    // Read via IPC → blob URL (file:// blocked when served from localhost in dev)
    const base64 = await window.electron.fs.readFileBase64(path)
    const byteArray = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const blob = new Blob([byteArray], { type: 'image/png' })
    setSelectedImagePreviewUrl(URL.createObjectURL(blob))
  }, [setSelectedImagePath, setSelectedImagePreviewUrl, setSelectedImageData])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (!file || !file.type.startsWith('image/')) return

    setSelectedImagePreviewUrl(URL.createObjectURL(file))

    const filePath = (file as File & { path?: string }).path
    if (filePath) {
      setSelectedImageData(null)
      setSelectedImagePath(filePath)
    } else {
      // file.path unavailable (some Electron configs) — read directly via FileReader
      const reader = new FileReader()
      reader.onload = (ev) => {
        const dataUrl = ev.target?.result as string
        const base64 = dataUrl.split(',')[1]
        setSelectedImageData(base64)
        setSelectedImagePath('__blob__')
      }
      reader.readAsDataURL(file)
    }
  }, [setSelectedImagePath, setSelectedImagePreviewUrl, setSelectedImageData])

  return (
    <div className="flex flex-col p-4 gap-3">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Input Image</h2>

      {/* Drop zone */}
      <div
        onClick={isGenerating ? undefined : handleFileSelect}
        onDrop={handleDrop}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
        onDragLeave={() => setIsDragging(false)}
        className={`
          relative aspect-square rounded-xl border-2 border-dashed
          flex items-center justify-center overflow-hidden
          transition-colors cursor-pointer
          ${isDragging ? 'border-accent bg-accent/10' : 'border-zinc-700 hover:border-zinc-500'}
          ${isGenerating ? 'cursor-not-allowed opacity-60' : ''}
        `}
      >
        {selectedImagePreviewUrl ? (
          <img
            src={selectedImagePreviewUrl}
            alt="Input"
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="flex flex-col items-center gap-2 text-zinc-600">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
            <p className="text-xs text-center">Drop image here<br />or click to browse</p>
          </div>
        )}

        {/* Generating overlay */}
        {isGenerating && (
          <div className="absolute inset-0 bg-surface-500/80 flex items-center justify-center">
            <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          </div>
        )}
      </div>
    </div>
  )
}

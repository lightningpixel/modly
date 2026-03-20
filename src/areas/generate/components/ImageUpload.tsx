import { useCallback } from 'react'
import { useAppStore, VIEW_SLOTS, ViewSlot } from '@shared/stores/appStore'
import { useGeneration } from '@shared/hooks/useGeneration'

const VIEW_LABELS: Record<ViewSlot, { label: string; tooltip: string }> = {
  front: { label: 'Front', tooltip: 'Front-facing view of the object' },
  left:  { label: 'Left',  tooltip: 'Left side view (90° clockwise from front)' },
  back:  { label: 'Back',  tooltip: 'Rear view of the object' },
  right: { label: 'Right', tooltip: 'Right side view (90° counter-clockwise from front)' },
}

export default function ImageUpload(): JSX.Element {
  const { currentJob } = useGeneration()
  const { viewImages, setViewImage, removeViewImage, clearViewImages } = useAppStore()

  const isGenerating = currentJob?.status === 'uploading' || currentJob?.status === 'generating'
  const hasAnyImage = Object.keys(viewImages).length > 0

  const handleSlotSelect = useCallback(async (slot: ViewSlot) => {
    const path = await window.electron.fs.selectImage()
    if (!path) return

    const base64 = await window.electron.fs.readFileBase64(path)
    const byteArray = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const blob = new Blob([byteArray], { type: 'image/png' })
    const previewUrl = URL.createObjectURL(blob)

    setViewImage(slot, { path, previewUrl, data: null })
  }, [setViewImage])

  const handleSlotDrop = useCallback((e: React.DragEvent, slot: ViewSlot) => {
    e.preventDefault()
    e.stopPropagation()
    const file = e.dataTransfer.files[0]
    if (!file || !file.type.startsWith('image/')) return

    const previewUrl = URL.createObjectURL(file)
    const filePath = (file as File & { path?: string }).path

    if (filePath) {
      setViewImage(slot, { path: filePath, previewUrl, data: null })
    } else {
      const reader = new FileReader()
      reader.onload = (ev) => {
        const dataUrl = ev.target?.result as string
        const base64 = dataUrl.split(',')[1]
        setViewImage(slot, { path: '__blob__', previewUrl, data: base64 })
      }
      reader.readAsDataURL(file)
    }
  }, [setViewImage])

  return (
    <div className="flex flex-col p-4 gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">
          Input Images
        </h2>
        {hasAnyImage && (
          <button
            onClick={clearViewImages}
            disabled={isGenerating}
            className="text-[10px] text-zinc-500 hover:text-zinc-300 disabled:opacity-40"
          >
            Clear all
          </button>
        )}
      </div>

      {/* View slots grid */}
      <div className="grid grid-cols-2 gap-2">
        {VIEW_SLOTS.map((slot) => {
          const image = viewImages[slot]
          const { label, tooltip } = VIEW_LABELS[slot]
          const isRequired = slot === 'front'

          return (
            <div
              key={slot}
              title={tooltip}
              onClick={isGenerating ? undefined : () => handleSlotSelect(slot)}
              onDrop={(e) => !isGenerating && handleSlotDrop(e, slot)}
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation() }}
              className={`
                relative aspect-square rounded-lg border-2 border-dashed
                flex items-center justify-center overflow-hidden
                transition-colors cursor-pointer
                ${image ? 'border-zinc-600' : isRequired ? 'border-zinc-600 hover:border-zinc-400' : 'border-zinc-800 hover:border-zinc-600'}
                ${isGenerating ? 'cursor-not-allowed opacity-60' : ''}
              `}
            >
              {image ? (
                <>
                  <img src={image.previewUrl} alt={label} className="w-full h-full object-cover" />
                  {!isGenerating && (
                    <button
                      onClick={(e) => { e.stopPropagation(); removeViewImage(slot) }}
                      className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/70 text-zinc-300 hover:text-white flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                      style={{ opacity: undefined }}
                      onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
                      onMouseLeave={(e) => (e.currentTarget.style.opacity = '0')}
                    >
                      x
                    </button>
                  )}
                  <span className="absolute bottom-1 left-1 text-[9px] bg-black/60 text-zinc-300 px-1 rounded">
                    {label}
                  </span>
                </>
              ) : (
                <div className="flex flex-col items-center gap-1 text-zinc-600 p-2">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                  <p className="text-[10px] text-center leading-tight">
                    {label}
                    {isRequired && <span className="text-accent"> *</span>}
                  </p>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <p className="text-[10px] text-zinc-600 leading-tight">
        Front view required. Add more views for better results. Empty slots are skipped.
      </p>

      {/* Generating overlay */}
      {isGenerating && (
        <div className="text-center">
          <div className="inline-block w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
        </div>
      )}
    </div>
  )
}

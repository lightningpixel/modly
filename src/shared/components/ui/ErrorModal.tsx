import { useState } from 'react'
import { useAppStore } from '@shared/stores/appStore'

export function ErrorModal(): JSX.Element | null {
  const { errorModal, hideError } = useAppStore()
  const [copied, setCopied] = useState(false)

  if (!errorModal) return null

  const handleCopy = () => {
    navigator.clipboard.writeText(errorModal).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-lg mx-4 bg-surface-300 border border-zinc-700/60 rounded-xl shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-zinc-700/50">
          <div className="w-7 h-7 rounded-full bg-red-500/15 border border-red-500/30 flex items-center justify-center shrink-0">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-red-400">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <span className="text-sm font-semibold text-zinc-100">An error occurred</span>
        </div>

        {/* Error message — selectable */}
        <div className="px-5 py-4">
          <pre className="text-xs text-red-400 bg-red-950/30 border border-red-900/30 rounded-lg px-4 py-3 max-h-60 overflow-y-auto whitespace-pre-wrap break-words select-text font-mono leading-relaxed">
            {errorModal}
          </pre>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 px-5 pb-4">
          <button
            onClick={handleCopy}
            className="px-4 py-2 text-xs font-semibold rounded-lg bg-zinc-700/60 hover:bg-zinc-700 text-zinc-200 transition-colors"
          >
            {copied ? 'Copied!' : 'Copy'}
          </button>
          <button
            onClick={hideError}
            className="px-4 py-2 text-xs font-semibold rounded-lg bg-accent hover:bg-accent-dark text-white transition-colors"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  )
}

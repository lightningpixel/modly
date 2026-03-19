import { createPortal } from 'react-dom'
import logo from '../../../../resources/icons/icon.png'

interface UpdateModalProps {
  currentVersion: string
  latestVersion: string
  onDismiss: () => void
}

export function UpdateModal({ currentVersion, latestVersion, onDismiss }: UpdateModalProps): JSX.Element {
  const handleDownload = (): void => {
    window.open('https://github.com/lightningpixel/modly/releases', '_blank')
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onDismiss() }}
    >
      <div className="absolute inset-0 bg-zinc-950/70 backdrop-blur-sm animate-fade-in" />

      <div className="relative w-[440px] rounded-2xl bg-zinc-900 border border-accent/20 shadow-2xl shadow-accent/10 overflow-hidden animate-slide-up-center">

        {/* Header band */}
        <div className="relative px-6 pt-6 pb-5 border-b border-zinc-800">
          <div className="absolute inset-0 bg-gradient-to-br from-accent/10 via-transparent to-transparent pointer-events-none" />

          <div className="relative flex items-center gap-4">
            <img src={logo} alt="Modly" className="w-12 h-12 rounded-xl shrink-0" />
            <div>
              <h2 className="text-lg font-semibold text-zinc-100 leading-tight">New update available</h2>
              <p className="text-sm text-zinc-500 mt-0.5">A new version of Modly is ready to download.</p>
            </div>
          </div>
        </div>

        {/* Version info */}
        <div className="px-6 py-5 flex flex-col gap-4">

          <div className="flex items-center gap-3 p-4 rounded-xl bg-zinc-800/60 border border-zinc-700/50">
            <div className="flex-1 flex flex-col items-center gap-1">
              <span className="text-[11px] uppercase tracking-widest text-zinc-500 font-medium">Current</span>
              <span className="text-base font-mono font-semibold text-zinc-400">
                {currentVersion ? `v${currentVersion}` : '—'}
              </span>
            </div>

            <div className="text-zinc-600">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="5" y1="12" x2="19" y2="12" />
                <polyline points="12 5 19 12 12 19" />
              </svg>
            </div>

            <div className="flex-1 flex flex-col items-center gap-1">
              <span className="text-[11px] uppercase tracking-widest text-accent-light font-medium">Latest</span>
              <span className="text-base font-mono font-semibold text-zinc-100">{latestVersion}</span>
            </div>
          </div>

          <p className="text-xs text-zinc-500 leading-relaxed">
            Download the latest release from GitHub to get bug fixes, improvements, and new features.
          </p>

          {/* Actions */}
          <div className="flex gap-3 pt-1">
            <button
              onClick={onDismiss}
              className="flex-1 py-3 rounded-xl bg-zinc-800 hover:bg-zinc-700/80 text-zinc-400 hover:text-zinc-200 text-sm font-medium transition-colors border border-zinc-700/50"
            >
              Later
            </button>
            <button
              onClick={handleDownload}
              className="flex-1 py-3 rounded-xl bg-accent hover:bg-accent-dark text-white text-sm font-semibold transition-colors shadow-lg shadow-accent/20 flex items-center justify-center gap-2"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Download
            </button>
          </div>

        </div>
      </div>
    </div>,
    document.body
  )
}

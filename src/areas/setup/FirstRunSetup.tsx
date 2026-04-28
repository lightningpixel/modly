import { useEffect, useState } from 'react'
import { useAppStore, SetupProgress } from '@shared/stores/appStore'

// ─── Logo (shared) ──────────────────────────────────────────────────────────

function ModlyLogo(): JSX.Element {
  return (
    <div className="mb-8">
      <svg width="64" height="64" viewBox="0 0 609 609" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="tlg-splash" x1="700" y1="5700" x2="5900" y2="750" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#c084fc"/>
            <stop offset="45%" stopColor="#9333ea"/>
            <stop offset="100%" stopColor="#4c1d95"/>
          </linearGradient>
        </defs>
        <g transform="translate(0,609) scale(0.1,-0.1)" fill="url(#tlg-splash)" stroke="none">
          <path d="M2964 5671 c-20 -9 -918 -521 -1604 -914 -173 -100 -362 -207 -420 -239 -58 -32 -118 -73 -133 -91 -58 -67 -57 -45 -57 -1067 0 -831 2 -938 16 -958 l15 -22 758 0 c417 0 761 3 764 6 12 13 -26 67 -283 399 -64 83 -120 156 -124 163 -5 7 4 32 22 60 16 26 238 396 493 822 254 426 569 951 699 1165 308 506 305 502 290 520 -7 8 -72 48 -144 87 -124 69 -135 73 -201 75 -38 2 -79 -1 -91 -6z"/>
          <path d="M3683 5328 c-18 -23 -833 -1306 -833 -1312 0 -12 83 -15 485 -21 230 -3 420 -7 421 -8 4 -5 451 -755 657 -1102 438 -739 668 -1120 691 -1143 l23 -24 71 36 c91 46 139 88 152 134 14 50 14 2403 0 2453 -20 72 -48 98 -215 193 -766 440 -1414 806 -1427 806 -9 0 -20 -6 -25 -12z"/>
          <path d="M4037 2838 c-25 -33 -443 -702 -467 -747 l-12 -24 -1384 4 c-1247 4 -1385 2 -1399 -12 -44 -44 -21 -170 42 -231 21 -20 203 -132 408 -249 385 -220 1034 -594 1310 -754 88 -51 183 -105 210 -121 28 -15 88 -49 134 -76 158 -90 177 -86 475 84 127 72 416 236 641 363 226 128 507 287 625 354 212 121 250 145 250 163 0 5 -40 73 -88 151 -49 78 -177 286 -284 462 -393 643 -407 664 -430 665 -4 0 -18 -15 -31 -32z"/>
        </g>
      </svg>
    </div>
  )
}

function AppHeader(): JSX.Element {
  return (
    <>
      <ModlyLogo />
      <h1 className="text-2xl font-semibold text-zinc-100 mb-1">Modly</h1>
      <p className="text-sm text-zinc-500 mb-10">AI-powered 3D mesh generation</p>
    </>
  )
}

// ─── Panels ─────────────────────────────────────────────────────────────────

function CheckingPanel(): JSX.Element {
  return (
    <div className="w-80 bg-surface-300 rounded-xl p-6">
      <p className="text-sm font-medium text-zinc-100">Checking environment…</p>
      <div className="mt-4 h-1 bg-zinc-800 rounded-full overflow-hidden">
        <div className="h-full bg-accent rounded-full animate-pulse" style={{ width: '30%' }} />
      </div>
    </div>
  )
}

function ChoosePathPanel({
  defaultPath,
  platform,
  arch,
  onConfirm,
}: {
  defaultPath: string
  platform: string
  arch: string
  onConfirm: (path: string) => void
}): JSX.Element {
  const [selectedPath, setSelectedPath] = useState(defaultPath || '')

  // Sync if defaultPath arrives after mount (async IPC)
  useEffect(() => {
    if (defaultPath && !selectedPath) setSelectedPath(defaultPath)
  }, [defaultPath])

  async function handleBrowse() {
    const picked = await window.electron.fs.selectDirectory()
    if (picked) setSelectedPath(picked)
  }

  return (
    <div className="w-80 bg-surface-300 rounded-xl p-6">
      <p className="text-sm font-medium text-zinc-100 mb-1">Choose a data folder</p>
      <p className="text-xs text-zinc-500 mb-4">
        Models can be several GB each. Choose a folder with plenty of free space.
        {platform === 'darwin' && arch === 'arm64'
          ? ' Apple Silicon is supported on this build.'
          : ' A fast local SSD is recommended.'}
      </p>

      {/* Path display */}
      <div className="flex items-center gap-2 mb-4">
        <div className="flex-1 min-w-0 bg-zinc-900 rounded-lg px-3 py-2">
          <p className="text-xs font-mono text-zinc-400 truncate" title={selectedPath}>
            {selectedPath || 'No folder selected'}
          </p>
        </div>
        <button
          onClick={handleBrowse}
          className="shrink-0 px-3 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-xs font-medium transition-colors"
        >
          Browse…
        </button>
      </div>

      <button
        onClick={() => onConfirm(selectedPath)}
        disabled={!selectedPath}
        className="w-full py-2 bg-accent hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm font-medium text-white transition-colors"
      >
        Continue
      </button>
    </div>
  )
}

const STEPS = [
  { key: 'enabling-site', label: 'Preparing Python' },
  { key: 'pip',           label: 'Installing pip' },
  { key: 'packages',      label: 'Installing packages' },
] as const

function stepIndex(step: string): number {
  return STEPS.findIndex((s) => s.key === step)
}

function InstallingPanel({ progress }: { progress: SetupProgress | null }): JSX.Element {
  const currentIdx = progress ? stepIndex(progress.step) : -1
  const percent = progress?.percent ?? 0

  return (
    <div className="w-80 bg-surface-300 rounded-xl p-6">
      <p className="text-sm font-medium text-zinc-100 mb-4">Setting up environment…</p>

      {/* Step indicators */}
      <div className="flex gap-2 mb-4">
        {STEPS.map((step, idx) => {
          const done    = idx < currentIdx
          const active  = idx === currentIdx
          return (
            <div key={step.key} className="flex-1 min-w-0">
              <div
                className={`h-1 rounded-full transition-colors ${
                  done   ? 'bg-accent' :
                  active ? 'bg-accent opacity-60 animate-pulse' :
                           'bg-zinc-700'
                }`}
              />
              <p className={`text-xs mt-1 truncate ${active ? 'text-zinc-300' : 'text-zinc-600'}`}>
                {step.label}
              </p>
            </div>
          )
        })}
      </div>

      {/* Progress bar */}
      <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden mb-3">
        <div
          className="h-full bg-accent rounded-full transition-all duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>

      <div className="flex justify-between items-center">
        <p className="text-xs text-zinc-500 truncate flex-1 min-w-0">
          {progress?.currentPackage ?? (currentIdx >= 0 ? STEPS[currentIdx]?.label : 'Initialising…')}
        </p>
        <p className="text-xs text-zinc-500 ml-2 shrink-0">{percent}%</p>
      </div>
    </div>
  )
}

function StartingPanel(): JSX.Element {
  return (
    <div className="w-80 bg-surface-300 rounded-xl p-6">
      <p className="text-sm font-medium text-zinc-100">Starting backend…</p>
      <p className="text-xs text-zinc-500 mt-1">Launching the local AI server</p>
      <div className="mt-4 h-1 bg-zinc-800 rounded-full overflow-hidden">
        <div className="h-full bg-accent rounded-full animate-pulse" style={{ width: '40%' }} />
      </div>
    </div>
  )
}

function ApplyingUpdatePanel({ version }: { version: string }): JSX.Element {
  return (
    <div className="w-80 bg-surface-300 rounded-xl p-6">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-8 h-8 rounded-lg bg-accent/15 border border-accent/25 flex items-center justify-center shrink-0">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent-light">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
        </div>
        <div>
          <p className="text-sm font-medium text-zinc-100">Applying update {version}</p>
          <p className="text-xs text-zinc-500 mt-0.5">The app will restart automatically</p>
        </div>
      </div>
      <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
        <div className="h-full bg-accent rounded-full animate-pulse" style={{ width: '70%' }} />
      </div>
    </div>
  )
}

function ErrorPanel({ message }: { message: string | null }): JSX.Element {
  return (
    <div className="w-80 bg-surface-300 rounded-xl p-6">
      <p className="text-sm font-medium text-zinc-100">Something went wrong</p>
      <p className="text-xs text-zinc-500 mt-1">{message ?? 'Check the console for details'}</p>
      <button
        onClick={() => window.location.reload()}
        className="mt-4 w-full py-2 bg-accent hover:bg-accent-dark rounded-lg text-sm font-medium text-white transition-colors"
      >
        Retry
      </button>
    </div>
  )
}

// ─── Main component ─────────────────────────────────────────────────────────

export default function FirstRunSetup(): JSX.Element {
  const { setupStatus, setupProgress, setupError, saveDataDir, defaultDataDir, backendStatus, backendError, platform, arch } =
    useAppStore()
  const [applyingVersion, setApplyingVersion] = useState<string | null>(null)
  const isMac = platform === 'darwin'

  useEffect(() => {
    window.electron.updater.onApplying(({ version }) => setApplyingVersion(`v${version}`))
    return () => { window.electron.updater.offApplying() }
  }, [])

  const renderPanel = () => {
    if (applyingVersion) return <ApplyingUpdatePanel version={applyingVersion} />
    switch (setupStatus) {
      case 'idle':
      case 'checking':
        return <CheckingPanel />

      case 'needed':
        return <ChoosePathPanel defaultPath={defaultDataDir} platform={platform} arch={arch} onConfirm={saveDataDir} />

      case 'installing':
        return <InstallingPanel progress={setupProgress} />

      case 'done':
        // setup done — now waiting for backend
        if (backendStatus === 'error') return <ErrorPanel message={backendError} />
        return <StartingPanel />

      case 'error':
        return <ErrorPanel message={setupError} />

      default:
        return <StartingPanel />
    }
  }

  return (
    <div className="flex flex-col h-full bg-surface-500">
      {/* Title bar */}
      <div className="flex items-center h-9 px-3 shrink-0 drag-region">
        <div className={`flex items-center gap-2 no-drag ${isMac ? 'pl-[72px]' : ''}`}>
          <svg width="18" height="18" viewBox="0 0 609 609" xmlns="http://www.w3.org/2000/svg" className="shrink-0">
            <defs>
              <linearGradient id="tlg-setup" x1="700" y1="5700" x2="5900" y2="750" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#c084fc"/>
                <stop offset="45%" stopColor="#9333ea"/>
                <stop offset="100%" stopColor="#4c1d95"/>
              </linearGradient>
            </defs>
            <g transform="translate(0,609) scale(0.1,-0.1)" fill="url(#tlg-setup)" stroke="none">
              <path d="M2964 5671 c-20 -9 -918 -521 -1604 -914 -173 -100 -362 -207 -420 -239 -58 -32 -118 -73 -133 -91 -58 -67 -57 -45 -57 -1067 0 -831 2 -938 16 -958 l15 -22 758 0 c417 0 761 3 764 6 12 13 -26 67 -283 399 -64 83 -120 156 -124 163 -5 7 4 32 22 60 16 26 238 396 493 822 254 426 569 951 699 1165 308 506 305 502 290 520 -7 8 -72 48 -144 87 -124 69 -135 73 -201 75 -38 2 -79 -1 -91 -6z"/>
              <path d="M3683 5328 c-18 -23 -833 -1306 -833 -1312 0 -12 83 -15 485 -21 230 -3 420 -7 421 -8 4 -5 451 -755 657 -1102 438 -739 668 -1120 691 -1143 l23 -24 71 36 c91 46 139 88 152 134 14 50 14 2403 0 2453 -20 72 -48 98 -215 193 -766 440 -1414 806 -1427 806 -9 0 -20 -6 -25 -12z"/>
              <path d="M4037 2838 c-25 -33 -443 -702 -467 -747 l-12 -24 -1384 4 c-1247 4 -1385 2 -1399 -12 -44 -44 -21 -170 42 -231 21 -20 203 -132 408 -249 385 -220 1034 -594 1310 -754 88 -51 183 -105 210 -121 28 -15 88 -49 134 -76 158 -90 177 -86 475 84 127 72 416 236 641 363 226 128 507 287 625 354 212 121 250 145 250 163 0 5 -40 73 -88 151 -49 78 -177 286 -284 462 -393 643 -407 664 -430 665 -4 0 -18 -15 -31 -32z"/>
            </g>
          </svg>
          <span className="text-xs font-semibold text-zinc-300">Modly</span>
        </div>
        <div className="flex-1" />
        {!isMac && (
          <div className="flex items-center gap-1 no-drag">
            <button
              onClick={() => window.electron.window.minimize()}
              className="w-7 h-7 flex items-center justify-center rounded hover:bg-zinc-700 text-zinc-500 hover:text-zinc-100 transition-colors"
              aria-label="Minimize"
            >
              <svg width="10" height="1" viewBox="0 0 10 1" fill="currentColor">
                <rect width="10" height="1" />
              </svg>
            </button>
            <button
              onClick={() => window.electron.window.close()}
              className="w-7 h-7 flex items-center justify-center rounded hover:bg-red-600 text-zinc-500 hover:text-white transition-colors"
              aria-label="Close"
            >
              <svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="currentColor" strokeWidth="1.2">
                <line x1="0" y1="0" x2="9" y2="9" />
                <line x1="9" y1="0" x2="0" y2="9" />
              </svg>
            </button>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex flex-col flex-1 items-center justify-center">
        <AppHeader />
        {renderPanel()}
      </div>
    </div>
  )
}

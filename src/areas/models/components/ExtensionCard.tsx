import { Extension, ExtensionVariant } from '@shared/stores/extensionsStore'

export type { Extension, ExtensionVariant }

interface Props {
  ext:          Extension
  installedIds: string[]
  downloading:  Record<string, number>
  loadError?:   string
  disabled?:    boolean
  onInstall:    (variant: ExtensionVariant) => void
  onUninstall:  (extId: string) => void
}

export function ExtensionCard({ ext, installedIds, downloading, loadError, disabled, onInstall, onUninstall }: Props): JSX.Element {
  return (
    <div className="flex flex-col gap-2.5 px-3.5 py-4 rounded-2xl border border-zinc-800 bg-zinc-900/60 hover:border-zinc-700 transition-all">

      {/* Header — icon + name + trust badge + uninstall */}
      <div className="flex items-start gap-2">
        <div className="shrink-0 w-7 h-7 rounded-lg bg-zinc-800 border border-zinc-700/50 flex items-center justify-center text-zinc-400">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/>
            <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
            <line x1="12" y1="22.08" x2="12" y2="12"/>
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <p className="text-xs font-semibold text-zinc-200 truncate leading-tight">{ext.name}</p>
            {ext.trusted ? (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-accent/15 border border-accent/25 text-accent-light text-[10px] font-semibold shrink-0">
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                  <polyline points="9 12 11 14 15 10"/>
                </svg>
                Official
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-amber-950/30 border border-amber-800/30 text-amber-500 text-[10px] font-semibold shrink-0">
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                  <line x1="12" y1="8" x2="12" y2="12"/>
                  <line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                Unverified
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            {ext.version && (
              <span className="text-[10px] text-zinc-500 font-mono">v{ext.version}</span>
            )}
            {ext.author && (
              <span className="text-[10px] text-zinc-600">{ext.author}</span>
            )}
          </div>
        </div>

        {/* Uninstall extension button */}
        <button
          onClick={() => onUninstall(ext.id)}
          disabled={disabled}
          title={disabled ? 'Cannot uninstall while an install is in progress' : 'Uninstall extension'}
          className="shrink-0 p-1 rounded text-zinc-700 hover:text-red-400 hover:bg-red-950/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:text-zinc-700 disabled:hover:bg-transparent"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
            <path d="M10 11v6M14 11v6"/>
            <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
          </svg>
        </button>
      </div>

      {/* Python load error */}
      {loadError && (
        <div className="flex items-start gap-1.5 px-2 py-1.5 rounded-lg bg-red-950/30 border border-red-800/30">
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-red-400 shrink-0 mt-px">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <p className="text-[10px] text-red-400 break-all">{loadError}</p>
        </div>
      )}

      {/* Unverified warning */}
      {!ext.trusted && (
        <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-amber-950/30 border border-amber-800/30">
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-amber-500 shrink-0">
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          <p className="text-[10px] text-amber-500">Unverified source</p>
        </div>
      )}

      {/* Description */}
      {ext.description && (
        <p className="text-[11px] text-zinc-500 leading-relaxed line-clamp-2">{ext.description}</p>
      )}

      {/* Variants */}
      {ext.models.length > 0 && (
        <div className="flex flex-col gap-1.5 pt-1 border-t border-zinc-800/60">
          {ext.models.map((variant) => {
            const installed     = installedIds.includes(variant.id)
            const dlPercent     = downloading[variant.id]
            const isDownloading = dlPercent !== undefined

            return (
              <div key={variant.id} className="flex items-center gap-2">
                {/* Variant name */}
                <span className="text-[11px] text-zinc-400 font-medium w-16 shrink-0 truncate">
                  {variant.name}
                </span>

                {/* Status */}
                <div className="flex-1 min-w-0">
                  {installed ? (
                    <div className="flex items-center gap-1 px-2 py-1 rounded-lg bg-emerald-950/40 border border-emerald-800/30">
                      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-emerald-400 shrink-0">
                        <polyline points="20 6 9 17 4 12"/>
                      </svg>
                      <span className="text-[10px] font-semibold text-emerald-400">Ready</span>
                    </div>
                  ) : isDownloading ? (
                    <div className="flex flex-col gap-0.5">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] text-zinc-500">Downloading…</span>
                        <span className="text-[10px] font-mono text-zinc-400">{dlPercent}%</span>
                      </div>
                      <div className="h-1 rounded-full bg-zinc-800 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-accent transition-all duration-300"
                          style={{ width: `${dlPercent}%` }}
                        />
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => !disabled && onInstall(variant)}
                      disabled={disabled}
                      title={disabled ? 'A download is already in progress' : `Install ${variant.name}`}
                      className={`w-full flex items-center justify-center gap-1 px-2 py-1 rounded-lg border text-[10px] font-semibold transition-all ${
                        !disabled
                          ? 'bg-accent/15 border-accent/25 text-accent-light hover:bg-accent/25 hover:border-accent/40 cursor-pointer'
                          : 'bg-zinc-800/40 border-zinc-700/30 text-zinc-600 cursor-not-allowed'
                      }`}
                    >
                      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                        <polyline points="7 10 12 15 17 10"/>
                        <line x1="12" y1="15" x2="12" y2="3"/>
                      </svg>
                      Install
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

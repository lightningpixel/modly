import React from 'react'

export function Section({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }): JSX.Element {
  return (
    <div>
      <div className="mb-7">
        <h2 className="text-2xl font-bold text-zinc-100">{title}</h2>
        <p className="text-sm text-zinc-500 mt-1">{subtitle}</p>
      </div>
      {children}
    </div>
  )
}

export function Card({ title, description, children }: { title?: string; description?: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="rounded-xl bg-surface-300 border border-zinc-800 overflow-hidden">
      {(title || description) && (
        <div className="px-4 py-3 border-b border-zinc-800/80">
          {title && <p className="text-xs font-semibold text-zinc-200">{title}</p>}
          {description && <p className="text-[11px] text-zinc-500 mt-0.5">{description}</p>}
        </div>
      )}
      <div className="divide-y divide-zinc-800/60">
        {children}
      </div>
    </div>
  )
}

export function Row({ label, description, children }: { label: string; description?: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <p className="text-xs font-medium text-zinc-300">{label}</p>
        {description && <p className="text-[11px] text-zinc-500 mt-0.5">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

export function PathRow({ label, description, value, onBrowse }: {
  label: string
  description?: string
  value: string
  onBrowse?: () => void
}): JSX.Element {
  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between mb-2">
        <div>
          <p className="text-xs font-medium text-zinc-300">{label}</p>
          {description && <p className="text-[11px] text-zinc-500 mt-0.5">{description}</p>}
        </div>
        {onBrowse && (
          <button
            onClick={onBrowse}
            className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors shrink-0 ml-4"
          >
            Browse…
          </button>
        )}
      </div>
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-500 border border-zinc-800">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-zinc-600 shrink-0">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
        <span className="text-[11px] text-zinc-500 truncate font-mono">{value}</span>
      </div>
    </div>
  )
}

export function InfoRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <p className="text-xs font-medium text-zinc-300">{label}</p>
      <span className="text-xs text-zinc-500 font-mono">{value}</span>
    </div>
  )
}

export function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }): JSX.Element {
  return (
    <button
      onClick={() => onChange(!value)}
      className={`relative w-9 h-5 rounded-full transition-colors duration-200 shrink-0 ${value ? 'bg-accent' : 'bg-zinc-700'}`}
    >
      <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${value ? 'translate-x-4' : 'translate-x-0'}`} />
    </button>
  )
}

export function Select({ value, onChange, options }: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}): JSX.Element {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="bg-zinc-800 border border-zinc-700 text-zinc-300 text-xs rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-accent/50 cursor-pointer"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  )
}

export function LinkButton({ label, href }: { label: string; href?: string }): JSX.Element {
  const handleClick = (): void => {
    if (href) window.open(href, '_blank')
  }
  return (
    <button onClick={handleClick} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors">
      {label}
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-zinc-500">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        <polyline points="15 3 21 3 21 9" />
        <line x1="10" y1="14" x2="21" y2="3" />
      </svg>
    </button>
  )
}

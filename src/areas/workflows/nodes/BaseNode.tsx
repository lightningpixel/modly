import { useState, useRef, useLayoutEffect } from 'react'
import { NodeResizer, useReactFlow } from '@xyflow/react'
import type { ReactNode } from 'react'

// ─── Props ────────────────────────────────────────────────────────────────────

export interface BaseNodeProps {
  id:       string
  selected?: boolean
  running?:  boolean

  // Header
  title:  string
  icon?:  ReactNode   // small icon left of title
  badge?: string      // e.g. "built-in"

  // Optional controls — only rendered when prop is provided
  enabled?:         boolean   // shows enable toggle
  showInGenerate?:  boolean   // shows eye toggle
  deletable?:       boolean   // default true
  collapsible?:     boolean   // default false — shows chevron, hides body when collapsed
  defaultExpanded?: boolean   // default true

  // Extra slots
  subheader?: ReactNode   // always visible, sits between header and body (e.g. IO row)
  handles?:   ReactNode   // React Flow handles — rendered at root level

  // Resize
  minWidth?:  number   // default 180
  minHeight?: number   // default 60

  // Body content (hidden when collapsed)
  children?: ReactNode
}

// ─── BaseNode ─────────────────────────────────────────────────────────────────

export default function BaseNode({
  id, selected, running,
  title, icon, badge,
  enabled, showInGenerate,
  deletable       = true,
  collapsible     = false,
  defaultExpanded = true,
  subheader, handles,
  minWidth  = 180,
  minHeight = 60,
  children,
}: BaseNodeProps) {
  const { updateNodeData, deleteElements } = useReactFlow()
  const [expanded, setExpanded] = useState(defaultExpanded)
  const rootRef = useRef<HTMLDivElement>(null)
  const [minW, setMinW] = useState(minWidth)
  const [minH, setMinH] = useState(minHeight)

  useLayoutEffect(() => {
    if (rootRef.current) {
      setMinW(rootRef.current.offsetWidth)
      setMinH(rootRef.current.offsetHeight)
    }
  }, [])

  const isDisabled = enabled === false

  return (
    <div
      ref={rootRef}
      style={{ width: '100%', height: '100%' }}
      className={`relative rounded-xl border bg-zinc-900/95 backdrop-blur-sm shadow-xl transition-all flex flex-col
        ${running    ? 'border-accent shadow-[0_0_16px_rgba(99,102,241,0.35)] animate-pulse'
        : selected   ? 'border-accent/70'
        : isDisabled ? 'border-zinc-800 opacity-50'
        : 'border-zinc-700'}`}
    >
      <NodeResizer
        minWidth={minW} minHeight={minH}
        lineStyle={{ borderColor: 'transparent' }}
        handleStyle={{ background: 'transparent', border: 'none', width: 12, height: 12 }}
      />

      {/* React Flow handles — must live at root level */}
      {handles}

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-start px-3 pt-3 pb-2.5 gap-2 shrink-0">

        {running && (
          <div className="shrink-0 mt-0.5">
            <svg className="animate-spin text-accent" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
            </svg>
          </div>
        )}
        {!running && icon && <div className="shrink-0 mt-0.5">{icon}</div>}

        <div className="flex-1 min-w-0">
          <p className="text-[11px] font-semibold text-zinc-200 leading-tight truncate">{title}</p>
          {badge && (
            <span className="inline-block mt-0.5 text-[8px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-zinc-700/70 text-zinc-400 border border-zinc-600/50">
              {badge}
            </span>
          )}
        </div>

        {/* Eye — visible in Generate page */}
        {showInGenerate !== undefined && (
          <button
            onClick={() => updateNodeData(id, { showInGenerate: !showInGenerate })}
            title={showInGenerate ? 'Visible in Generate' : 'Hidden from Generate'}
            className="nodrag p-0.5 rounded transition-colors shrink-0 mt-0.5"
          >
            {showInGenerate ? (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                <circle cx="12" cy="12" r="3"/>
              </svg>
            ) : (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-zinc-600 hover:text-zinc-400">
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                <line x1="1" y1="1" x2="23" y2="23"/>
              </svg>
            )}
          </button>
        )}

        {/* Enable / disable toggle */}
        {enabled !== undefined && (
          <button
            onClick={() => updateNodeData(id, { enabled: !enabled })}
            title={enabled ? 'Disable' : 'Enable'}
            className="nodrag relative shrink-0 mt-0.5"
            style={{ width: 26, height: 15 }}
          >
            <span className={`absolute inset-0 rounded-full transition-colors ${enabled ? 'bg-accent/70' : 'bg-zinc-700'}`} />
            <span className={`absolute top-[1.5px] w-3 h-3 rounded-full bg-white shadow transition-all ${enabled ? 'left-[11px]' : 'left-[1.5px]'}`} />
          </button>
        )}

        {/* Collapse chevron */}
        {collapsible && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="nodrag p-0.5 rounded text-zinc-600 hover:text-zinc-400 transition-colors shrink-0 mt-0.5"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
              className={`transition-transform ${expanded ? 'rotate-180' : ''}`}>
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>
        )}

        {/* Delete */}
        {deletable && (
          <button
            onClick={() => deleteElements({ nodes: [{ id }] })}
            className="nodrag p-0.5 rounded text-zinc-700 hover:text-red-400 transition-colors shrink-0 mt-0.5"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        )}
      </div>

      {/* ── Sub-header (always visible) ────────────────────────────────────── */}
      {subheader && (
        <div className="shrink-0 border-t border-zinc-800/60">
          {subheader}
        </div>
      )}

      {/* ── Body (collapsible) ─────────────────────────────────────────────── */}
      {children && (!collapsible || expanded) && (
        <div className="border-t border-zinc-800 flex-1 min-h-0 flex flex-col">
          {children}
        </div>
      )}
    </div>
  )
}

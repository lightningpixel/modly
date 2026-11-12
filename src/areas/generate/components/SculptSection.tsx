import { useEffect } from 'react'
import { useAppStore } from '@shared/stores/appStore'
import { fromSliderPosition, toSliderPosition, LOG_SLIDER_STEPS, type ParamControl } from '../meshEditPanel'
import { BRUSH_KINDS, useSculptStore } from '../sculpt/sculptStore'
import { RADIUS_DEFAULT, RADIUS_MAX, RADIUS_MIN, sculptBlock } from '../sculpt/sculptLogic'
import type { BrushKind, SymmetryAxis } from '../sculpt/types'

// "Sculpt" section of the edit panel: enter/leave sculpt mode and set the
// brush. The strokes themselves happen in the viewer (sculpt/SculptLayer).

const BRUSH_LABELS: Record<BrushKind, { label: string; key: string; hint: string }> = {
  grab:    { label: 'Grab',    key: 'G', hint: 'Drag a region of the surface along with the cursor.' },
  smooth:  { label: 'Smooth',  key: 'S', hint: 'Relax bumps and noise. Hold Shift with any brush to smooth.' },
  inflate: { label: 'Inflate', key: 'I', hint: 'Push the surface out along its normals. Ctrl: deflate.' },
  flatten: { label: 'Flatten', key: 'T', hint: 'Pull the surface onto a plane. Ctrl: push it away.' },
}

const AXES: SymmetryAxis[] = ['x', 'y', 'z']

// Log slider for the radius (fraction of the model's size).
const RADIUS_CONTROL: Extract<ParamControl, { kind: 'slider' }> = {
  id: 'radius', label: 'Radius', kind: 'slider', min: RADIUS_MIN, max: RADIUS_MAX, step: 0.001,
  integer: false, scale: 'log', defaultValue: RADIUS_DEFAULT,
}

const SHORTCUTS: [string, string][] = [
  ['Left-drag on mesh', 'Sculpt'],
  ['Drag outside / right / middle', 'Orbit / pan'],
  ['F / Shift+F', 'Bigger / smaller brush'],
  ['Ctrl (hold)', 'Invert (inflate, flatten)'],
  ['Shift (hold)', 'Smooth'],
  ['G S I T', 'Grab, Smooth, Inflate, Flatten'],
  ['Ctrl+Z / Ctrl+Y', 'Undo / redo a stroke'],
  ['Esc', 'Done (saves)'],
]

function Spinner(): JSX.Element {
  return (
    <svg className="animate-spin" width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  )
}

export default function SculptSection({ running }: { running: boolean }): JSX.Element {
  const currentJob = useAppStore((s) => s.currentJob)
  const meshStats = useAppStore((s) => s.meshStats)
  const active = useSculptStore((s) => s.active)
  const brush = useSculptStore((s) => s.brush)
  const params = useSculptStore((s) => s.brushes[s.brush])
  const symmetry = useSculptStore((s) => s.symmetry)
  const status = useSculptStore((s) => s.status)
  const error = useSculptStore((s) => s.error)
  const strokes = useSculptStore((s) => s.history.undo.length)
  const dirty = useSculptStore((s) => s.dirty)
  const { enter, exit, setBrush, setRadius, setStrength, toggleSymmetry } = useSculptStore.getState()

  const generating = currentJob?.status === 'uploading' || currentJob?.status === 'generating'
  const block = sculptBlock({
    meshUrl: currentJob?.status === 'done' ? currentJob.outputUrl : undefined,
    generating,
    triangles: meshStats?.triangles ?? null,
  })
  const saving = status === 'saving'

  // The model became unsculptable (generation started, OBJ loaded, too big…):
  // leave sculpt mode. Pending strokes are handled by the viewer's session.
  const hardBlocked = !!block && !block.transient
  useEffect(() => {
    if (active && hardBlocked) useSculptStore.setState({ active: false })
  }, [active, hardBlocked])

  return (
    <section className="flex flex-col gap-2" aria-label="Sculpt">
      <div className="flex items-center justify-between">
        <p className="text-[10px] text-zinc-500 uppercase tracking-wider">Sculpt</p>
        {active ? (
          <button
            type="button"
            onClick={() => { void exit() }}
            disabled={saving || status === 'preparing'}
            title="Save the strokes and leave sculpt mode (Esc)"
            className="px-2.5 py-1 bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-[11px] rounded-lg transition-colors flex items-center gap-1.5 font-medium"
          >
            {saving ? <><Spinner /> Saving…</> : 'Done'}
          </button>
        ) : (
          <button
            type="button"
            onClick={enter}
            disabled={!!block || running}
            title={block?.reason ?? 'Sculpt the mesh with brushes'}
            className="px-2.5 py-1 bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-[11px] rounded-lg transition-colors flex items-center gap-1.5 font-medium"
          >
            Sculpt
          </button>
        )}
      </div>

      {!active && block && !block.transient && (
        <p className="text-[11px] text-zinc-500">{block.reason}</p>
      )}

      {active && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-2.5 py-2 flex flex-col gap-2.5">
          <div className="grid grid-cols-4 gap-1" role="radiogroup" aria-label="Brush">
            {BRUSH_KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={brush === kind}
                onClick={() => setBrush(kind)}
                title={`${BRUSH_LABELS[kind].hint} (${BRUSH_LABELS[kind].key})`}
                className={`px-1 py-1 rounded-md text-[11px] border transition-colors ${brush === kind
                  ? 'bg-violet-600/20 border-violet-500 text-violet-100'
                  : 'bg-zinc-800 border-zinc-700/50 text-zinc-400 hover:text-zinc-200'}`}
              >
                {BRUSH_LABELS[kind].label}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-zinc-500">{BRUSH_LABELS[brush].hint}</p>

          <label className="flex flex-col gap-1">
            <span className="flex items-center justify-between text-[11px] text-zinc-400">
              Radius <span className="tabular-nums text-zinc-300">{(params.radius * 100).toFixed(1)}% of model</span>
            </span>
            <input
              type="range"
              min={0}
              max={LOG_SLIDER_STEPS}
              step={1}
              value={toSliderPosition(RADIUS_CONTROL, params.radius)}
              onChange={(e) => setRadius(fromSliderPosition(RADIUS_CONTROL, e.currentTarget.valueAsNumber))}
              className="accent-violet-500 cursor-pointer"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="flex items-center justify-between text-[11px] text-zinc-400">
              Strength <span className="tabular-nums text-zinc-300">{Math.round(params.strength * 100)}%</span>
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={params.strength}
              onChange={(e) => setStrength(e.currentTarget.valueAsNumber)}
              className="accent-violet-500 cursor-pointer"
            />
          </label>

          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-zinc-400">Symmetry</span>
            <div className="flex gap-1">
              {AXES.map((axis) => {
                const on = symmetry.includes(axis)
                return (
                  <button
                    key={axis}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleSymmetry(axis)}
                    title={`Mirror strokes across the ${axis.toUpperCase()} axis`}
                    className={`w-7 py-0.5 rounded-md text-[11px] font-medium border transition-colors ${on
                      ? 'bg-violet-600/20 border-violet-500 text-violet-100'
                      : 'bg-zinc-800 border-zinc-700/50 text-zinc-500 hover:text-zinc-200'}`}
                  >
                    {axis.toUpperCase()}
                  </button>
                )
              })}
            </div>
          </div>

          <p className="text-[10px] text-zinc-500">
            {dirty
              ? `${strokes} unsaved stroke${strokes === 1 ? '' : 's'} — saved when you click Done.`
              : 'No unsaved strokes.'}
          </p>
          {error && <p role="alert" className="text-[11px] text-red-300 break-words">{error}</p>}

          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[10px] border-t border-zinc-800 pt-2">
            {SHORTCUTS.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-zinc-400">{k}</dt>
                <dd className="text-zinc-500 text-right">{v}</dd>
              </div>
            ))}
          </dl>

          <p className="text-[10px] text-amber-300/90">Mesh tools are disabled while sculpting. Click Done to save the strokes and use them.</p>
        </div>
      )}
    </section>
  )
}

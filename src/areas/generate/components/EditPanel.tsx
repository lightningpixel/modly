import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '@shared/stores/appStore'
import { useApi } from '@shared/hooks/useApi'
import { ParamFields } from '@shared/components/ui/ParamFields'
import {
  INSPECT_OP_ID,
  apiErrorMessage,
  defaultParamValues,
  groupMeshOps,
  inspectionBadges,
  isMeshUpdate,
  meshPathFromUrl,
  requiresConfirmation,
  stepSummaries,
  summarizeDetails,
  type BadgeState,
  type MeshOpDescriptor,
  type MeshOpResponse,
} from '../meshEditPanel'
import { commitSculpt, useSculptStore } from '../sculpt/sculptStore'
import SculptSection from './SculptSection'

// Side panel listing every mesh-ops registry op (the same ones the chat agent
// runs), with controls generated from each op's params_schema. Ops that write
// a mesh go through applyMeshEdit, so they land on the undo stack exactly like
// an agent edit; analysis ops show their report inline.

type Params = Record<string, unknown>

interface OpResult {
  /** Mesh URL the op ran on. */
  sourceUrl: string
  response?: MeshOpResponse
  error?: string
}

interface Fix {
  op: string
  params?: Params
  reason?: string
}

function Spinner({ size = 11 }: { size?: number }): JSX.Element {
  return (
    <svg className="animate-spin" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  )
}

function Chevron({ open }: { open: boolean }): JSX.Element {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      className={`transition-transform ${open ? 'rotate-180' : ''}`}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}

// ─── Reports ──────────────────────────────────────────────────────────────────

const BADGE_CLASS: Record<BadgeState, string> = {
  ok:      'bg-emerald-500/10 border-emerald-500/30 text-emerald-300',
  bad:     'bg-red-500/10 border-red-500/30 text-red-300',
  unknown: 'bg-zinc-800 border-zinc-700 text-zinc-400',
}

const BADGE_MARK: Record<BadgeState, string> = { ok: '✓', bad: '✗', unknown: '?' }

function fmt(value: unknown, digits = 4): string {
  if (typeof value !== 'number') return '—'
  return Number.isInteger(value) ? value.toLocaleString('en-US') : Number(value.toPrecision(digits)).toString()
}

function InspectionReport({ report }: { report: Record<string, unknown> }): JSX.Element {
  const dims = Array.isArray(report.dimensions) ? report.dimensions.map((d) => fmt(d)).join(' × ') : '—'
  const selfHits = report.self_intersecting_face_count
  const stats: [string, string][] = [
    ['Faces', fmt(report.face_count)],
    ['Vertices', fmt(report.vertex_count)],
    ['Parts', fmt(report.component_count)],
    ['Holes', `${fmt(report.hole_count)}${report.boundary_edge_count ? ` (${fmt(report.boundary_edge_count)} open edges)` : ''}`],
    ['Non-manifold edges', fmt(report.non_manifold_edge_count)],
    ['Degenerate faces', fmt(report.degenerate_face_count)],
    ['Self-intersecting faces', selfHits === null ? 'not checked' : fmt(selfHits)],
    ['Dimensions', dims],
    ['Volume', report.volume == null ? 'n/a (not closed)' : fmt(report.volume)],
    ['UVs', report.has_uvs === true ? 'yes' : report.has_uvs === false ? 'no' : 'unknown'],
    ['Normals', report.has_normals === true ? 'yes' : report.has_normals === false ? 'no' : 'unknown'],
  ]
  const issues = Array.isArray(report.issues) ? (report.issues as unknown[]).map(String) : []

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap gap-1">
        {inspectionBadges(report).map((badge) => (
          <span key={badge.label} className={`px-1.5 py-0.5 rounded-md border text-[10px] font-medium ${BADGE_CLASS[badge.state]}`}>
            {BADGE_MARK[badge.state]} {badge.label}
          </span>
        ))}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[10px]">
        {stats.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-zinc-500">{k}</dt>
            <dd className="text-zinc-300 text-right tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      {issues.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-[10px] text-amber-300/90">
          {issues.map((issue) => <li key={issue}>• {issue}</li>)}
        </ul>
      )}
    </div>
  )
}

function DetailRows({ details }: { details: Record<string, unknown> }): JSX.Element | null {
  const steps = stepSummaries(details)
  const rows = summarizeDetails(details)
  if (steps.length === 0 && rows.length === 0) return null
  return (
    <div className="flex flex-col gap-1.5">
      {steps.length > 0 && (
        <ol className="flex flex-col gap-0.5 text-[10px] text-zinc-300">
          {steps.map((step, i) => <li key={i}>{i + 1}. {step}</li>)}
        </ol>
      )}
      {rows.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[10px]">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-zinc-500">{k}</dt>
              <dd className="text-zinc-300 text-right break-words">{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

// ─── Panel ────────────────────────────────────────────────────────────────────

export default function EditPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const apiUrl = useAppStore((s) => s.apiUrl)
  const currentJob = useAppStore((s) => s.currentJob)
  const applyMeshEdit = useAppStore((s) => s.applyMeshEdit)
  const { listMeshOps, runMeshOp } = useApi()

  const [ops, setOps] = useState<MeshOpDescriptor[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [params, setParams] = useState<Record<string, Params>>({})
  const [expanded, setExpanded] = useState<string | null>(null)
  // Op awaiting in-panel confirmation, with the params it will run with.
  const [confirming, setConfirming] = useState<{ opId: string; values: Params } | null>(null)
  const [running, setRunning] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, OpResult>>({})
  const [inspection, setInspection] = useState<{ sourceUrl: string; report: Record<string, unknown> } | null>(null)

  const isGenerating = currentJob?.status === 'uploading' || currentJob?.status === 'generating'
  const meshUrl = currentJob?.status === 'done' ? currentJob.outputUrl : undefined
  // Ops are locked while sculpting: they would run on the file without the strokes.
  const sculpting = useSculptStore((s) => s.active)
  const canRun = !!meshUrl && !isGenerating && running === null && !sculpting

  useEffect(() => {
    let cancelled = false
    setLoadError(null)
    listMeshOps()
      .then((list) => { if (!cancelled) setOps(list) })
      .catch((err) => { if (!cancelled) setLoadError(apiErrorMessage(err)) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- listMeshOps is rebuilt every render; refetch on API change or retry only
  }, [apiUrl, reloadKey])

  // Results and reports belong to one model: drop them when another is loaded.
  const jobId = currentJob?.id
  useEffect(() => {
    setResults({})
    setInspection(null)
    setConfirming(null)
  }, [jobId])

  const opById = useCallback((id: string) => ops?.find((o) => o.id === id), [ops])

  function valuesFor(op: MeshOpDescriptor): Params {
    return params[op.id] ?? defaultParamValues(op.params_schema)
  }

  function setParam(op: MeshOpDescriptor, id: string, value: unknown) {
    setParams((current) => ({ ...current, [op.id]: { ...(current[op.id] ?? defaultParamValues(op.params_schema)), [id]: value } }))
  }

  async function run(op: MeshOpDescriptor, values: Params) {
    if (!meshUrl || running !== null) return
    setConfirming(null)
    setRunning(op.id)
    setResults((current) => { const next = { ...current }; delete next[op.id]; return next })
    // Pending sculpt strokes go into the file first, so the op sees them.
    if (!(await commitSculpt())) { setRunning(null); return }
    const sourceUrl = useAppStore.getState().currentJob?.outputUrl ?? meshUrl
    try {
      const response = await runMeshOp(op.id, meshPathFromUrl(sourceUrl), values)
      // The viewer may have moved on (undo, another model) while the op ran:
      // applying would silently drop that change, so discard the result.
      if (useAppStore.getState().currentJob?.outputUrl !== sourceUrl) {
        setResults((current) => ({ ...current, [op.id]: { sourceUrl, error: 'The mesh changed while this ran; the result was discarded.' } }))
        return
      }
      if (isMeshUpdate(response)) applyMeshEdit(response.url)
      if (op.id === INSPECT_OP_ID) setInspection({ sourceUrl, report: response })
      else if (response.report && typeof response.report === 'object') {
        // suggest_fixes carries a full inspection report too.
        setInspection({ sourceUrl, report: response.report as Record<string, unknown> })
      }
      setResults((current) => ({ ...current, [op.id]: { sourceUrl, response } }))
    } catch (err) {
      setResults((current) => ({ ...current, [op.id]: { sourceUrl, error: apiErrorMessage(err) } }))
    } finally {
      setRunning(null)
    }
  }

  function requestRun(op: MeshOpDescriptor, values: Params = valuesFor(op)) {
    if (requiresConfirmation(op)) { setConfirming({ opId: op.id, values }); return }
    void run(op, values)
  }

  const inspectOp = ops?.find((o) => o.id === INSPECT_OP_ID)
  const groups = ops ? groupMeshOps(ops) : []

  return (
    <aside className="w-72 shrink-0 flex flex-col border-l border-zinc-800 bg-surface-400 overflow-hidden" aria-label="Mesh edit panel">
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
        <p className="text-[10px] text-zinc-500 uppercase tracking-wider">Edit mesh</p>
        <button
          type="button"
          onClick={onClose}
          title="Close"
          className="w-6 h-6 flex items-center justify-center rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-4">
        {!meshUrl && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
            <p className="text-[11px] text-zinc-400">
              {isGenerating ? 'Generating… tools unlock once the mesh is ready.' : 'Generate, import or open a mesh to edit it.'}
            </p>
          </div>
        )}

        {loadError && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 flex flex-col gap-2">
            <p role="alert" className="text-[11px] text-red-300">Could not load the mesh tools: {loadError}</p>
            <button
              type="button"
              onClick={() => setReloadKey((k) => k + 1)}
              className="self-start px-2.5 py-1 text-[11px] text-zinc-300 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors"
            >
              Retry
            </button>
          </div>
        )}

        {!ops && !loadError && (
          <div className="flex items-center gap-2 text-[11px] text-zinc-500"><Spinner /> Loading tools…</div>
        )}

        <SculptSection running={running !== null} />

        {/* Mesh health: inspect_mesh as an inline report */}
        {inspectOp && (
          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <p className="text-[10px] text-zinc-500 uppercase tracking-wider">Mesh health</p>
              <button
                type="button"
                onClick={() => requestRun(inspectOp)}
                disabled={!canRun}
                className="px-2.5 py-1 bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-[11px] rounded-lg transition-colors flex items-center gap-1.5 font-medium"
              >
                {running === INSPECT_OP_ID ? <><Spinner /> Inspecting…</> : inspection ? 'Re-inspect' : 'Inspect'}
              </button>
            </div>
            <ParamFields
              schema={inspectOp.params_schema}
              values={valuesFor(inspectOp)}
              onChange={(id, v) => setParam(inspectOp, id, v)}
              disabled={running !== null}
            />
            {results[INSPECT_OP_ID]?.error && (
              <p role="alert" className="text-[11px] text-red-300">{results[INSPECT_OP_ID].error}</p>
            )}
            {inspection && (
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-2.5 py-2 flex flex-col gap-2">
                {inspection.sourceUrl !== meshUrl && (
                  <p className="text-[10px] text-amber-300">The mesh changed since this report — re-inspect.</p>
                )}
                <InspectionReport report={inspection.report} />
              </div>
            )}
          </section>
        )}

        {groups.map((group) => (
          <section key={group.category || 'other'} className="flex flex-col gap-1">
            <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-0.5">{group.label}</p>
            {group.ops.map((op) => {
              const open = expanded === op.id
              const hasParams = op.params_schema.length > 0
              const result = results[op.id]
              const isAnalysis = group.category === 'analysis'
              const actionLabel = isAnalysis ? 'Run' : 'Apply'
              return (
                <div key={op.id} className="rounded-lg border border-zinc-800 bg-zinc-900/60">
                  <div className="flex items-center gap-1.5 pl-2.5 pr-1.5 py-1.5">
                    <button
                      type="button"
                      onClick={() => setExpanded(open ? null : op.id)}
                      disabled={!hasParams}
                      aria-expanded={hasParams ? open : undefined}
                      className="flex-1 min-w-0 flex items-center gap-1.5 text-left text-xs text-zinc-200 disabled:cursor-default"
                    >
                      <span className="truncate">{op.label}</span>
                      {op.destructive && (
                        <span className="shrink-0 px-1 rounded text-[9px] uppercase tracking-wide bg-amber-500/10 text-amber-300 border border-amber-500/30">destructive</span>
                      )}
                      {hasParams && <span className="ml-auto text-zinc-500"><Chevron open={open} /></span>}
                    </button>
                    <button
                      type="button"
                      onClick={() => requestRun(op)}
                      disabled={!canRun}
                      className="shrink-0 px-2 py-1 bg-zinc-800 hover:bg-violet-600 disabled:hover:bg-zinc-800 disabled:text-zinc-600 text-zinc-200 hover:text-white text-[11px] rounded-md transition-colors flex items-center gap-1"
                    >
                      {running === op.id ? <><Spinner size={10} /> Running…</> : actionLabel}
                    </button>
                  </div>

                  {open && hasParams && (
                    <div className="px-2.5 pb-2.5 pt-1 border-t border-zinc-800 flex flex-col gap-2">
                      <ParamFields schema={op.params_schema} values={valuesFor(op)} onChange={(id, v) => setParam(op, id, v)} disabled={running !== null} />
                      {params[op.id] && (
                        <button
                          type="button"
                          onClick={() => setParams((current) => { const next = { ...current }; delete next[op.id]; return next })}
                          className="self-end text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
                        >
                          Reset to defaults
                        </button>
                      )}
                    </div>
                  )}

                  {confirming?.opId === op.id && (
                    <div className="mx-2.5 mb-2.5 rounded-lg border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 flex flex-col gap-2">
                      <p className="text-[11px] text-amber-200">
                        {op.undoable
                          ? `${op.label} is destructive and may discard data from the mesh. Apply it?`
                          : `${op.label} can't be undone. Apply it?`}
                      </p>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => setConfirming(null)}
                          className="flex-1 px-2 py-1 text-[11px] text-zinc-400 hover:text-zinc-200 bg-zinc-800 hover:bg-zinc-700 rounded-md transition-colors"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => { void run(op, confirming.values) }}
                          disabled={!canRun}
                          className="flex-1 px-2 py-1 text-[11px] text-white bg-amber-600 hover:bg-amber-500 disabled:bg-zinc-700 disabled:text-zinc-500 rounded-md transition-colors font-medium"
                        >
                          {actionLabel} anyway
                        </button>
                      </div>
                    </div>
                  )}

                  {result && (
                    <div className="px-2.5 pb-2.5 flex flex-col gap-1.5">
                      {result.error && <p role="alert" className="text-[11px] text-red-300 break-words">{result.error}</p>}
                      {result.response && (
                        <OpResultView
                          response={result.response}
                          stale={!isMeshUpdate(result.response) && result.sourceUrl !== meshUrl}
                          canRun={canRun}
                          opById={opById}
                          onRunFix={(fixOp, fixParams) => requestRun(fixOp, { ...defaultParamValues(fixOp.params_schema), ...fixParams })}
                        />
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </section>
        ))}

        {ops && groups.length === 0 && !inspectOp && (
          <p className="text-[11px] text-zinc-500">No mesh tools are registered.</p>
        )}
      </div>
    </aside>
  )
}

function OpResultView({ response, stale, canRun, opById, onRunFix }: {
  response: MeshOpResponse
  stale: boolean
  canRun: boolean
  opById: (id: string) => MeshOpDescriptor | undefined
  onRunFix: (op: MeshOpDescriptor, params: Params) => void
}): JSX.Element {
  if (isMeshUpdate(response)) {
    return (
      <div className="flex flex-col gap-1">
        <p className="text-[10px] text-emerald-300">Applied — undo with Ctrl+Z.</p>
        <DetailRows details={response} />
      </div>
    )
  }

  // suggest_fixes: { report, fixes, notes } — the report goes to Mesh health.
  if (Array.isArray(response.fixes)) {
    const fixes = response.fixes as Fix[]
    const notes = Array.isArray(response.notes) ? (response.notes as unknown[]).map(String) : []
    return (
      <div className="flex flex-col gap-1.5">
        {stale && <p className="text-[10px] text-amber-300">The mesh changed since these suggestions.</p>}
        {fixes.length === 0 && notes.length === 0 && (
          <p className="text-[10px] text-emerald-300">No fixes needed — no problems detected.</p>
        )}
        {fixes.map((fix, i) => {
          const fixOp = opById(fix.op)
          return (
            <div key={`${fix.op}-${i}`} className="flex items-start gap-2 rounded-md bg-zinc-950/40 px-2 py-1.5">
              <div className="flex-1 min-w-0">
                <p className="text-[11px] text-zinc-200">{fixOp?.label ?? fix.op}</p>
                {fix.reason && <p className="text-[10px] text-zinc-500">{fix.reason}</p>}
              </div>
              {fixOp && (
                <button
                  type="button"
                  onClick={() => onRunFix(fixOp, fix.params ?? {})}
                  disabled={!canRun}
                  className="shrink-0 px-2 py-0.5 bg-zinc-800 hover:bg-violet-600 disabled:hover:bg-zinc-800 disabled:text-zinc-600 text-zinc-200 hover:text-white text-[10px] rounded-md transition-colors"
                >
                  Apply
                </button>
              )}
            </div>
          )
        })}
        {notes.map((note) => <p key={note} className="text-[10px] text-zinc-400">{note}</p>)}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1">
      {stale && <p className="text-[10px] text-amber-300">The mesh changed since this ran.</p>}
      <DetailRows details={response} />
    </div>
  )
}

// Pure bookkeeping for a workflow run's history record (see shared/types/runs.ts).
// The renderer executes workflows, so it owns their record and reports it with
// PUT /workflow-runs/{id}; the store wires these helpers to the run lifecycle.
// Every helper returns a new record. `now` is epoch seconds.

import type { RunRecord, RunStatus } from '../../shared/types/runs'

export type WorkflowRunRecord = Omit<RunRecord, 'kind' | 'duration_s'>

/** Matches the backend cap (services/run_history.py MAX_STEPS). */
export const MAX_RECORD_STEPS = 200

const TERMINAL: ReadonlySet<RunStatus> = new Set(['done', 'error', 'cancelled', 'interrupted'])

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL.has(status)
}

interface WorkflowLike {
  id:    string
  name:  string
  nodes: { id: string; type: string; data: { extensionId?: string; enabled?: boolean; params?: Record<string, unknown> } }[]
}

/** The params a run used: each enabled extension node's id, extension and params. */
export function workflowRunParams(workflow: WorkflowLike): Record<string, unknown> {
  const nodes: Record<string, unknown> = {}
  for (const node of workflow.nodes) {
    if (node.type !== 'extensionNode' || !node.data.enabled) continue
    nodes[node.id] = { extension_id: node.data.extensionId ?? null, params: node.data.params ?? {} }
  }
  return { nodes }
}

export function newWorkflowRunRecord(
  id: string,
  workflow: WorkflowLike,
  inputs: Record<string, unknown>,
  now: number,
): WorkflowRunRecord {
  return {
    id,
    status:        'running',
    workflow_id:   workflow.id,
    workflow_name: workflow.name,
    inputs,
    params:        workflowRunParams(workflow),
    steps:         [],
    created_at:    now,
    started_at:    now,
  }
}

/** Close the open step (if any) with `status`. */
export function endRecordStep(record: WorkflowRunRecord, status: RunStatus, now: number): WorkflowRunRecord {
  const last = record.steps[record.steps.length - 1]
  if (!last || last.ended_at != null) return record
  return { ...record, steps: [...record.steps.slice(0, -1), { ...last, status, ended_at: now }] }
}

/** Open a step for a node; a step left open is closed as done first. */
export function startRecordStep(record: WorkflowRunRecord, name: string, nodeId: string, now: number): WorkflowRunRecord {
  const closed = endRecordStep(record, 'done', now)
  if (closed.steps.length >= MAX_RECORD_STEPS) return closed
  return { ...closed, steps: [...closed.steps, { name, node_id: nodeId, status: 'running', started_at: now }] }
}

export function finishWorkflowRunRecord(
  record: WorkflowRunRecord,
  status: RunStatus,
  now: number,
  outcome: { error?: string; outputPath?: string } = {},
): WorkflowRunRecord {
  const closed = endRecordStep(record, status, now)
  return {
    ...closed,
    status,
    ended_at:    now,
    error:       outcome.error ?? closed.error ?? null,
    output_path: outcome.outputPath ?? closed.output_path ?? null,
  }
}

/** A finished run the user resumes (re-running a Wait branch) is running again. */
export function reopenWorkflowRunRecord(record: WorkflowRunRecord): WorkflowRunRecord {
  if (!isTerminalRunStatus(record.status)) return record
  return { ...record, status: 'running', ended_at: null, error: null }
}

/** Workspace-relative path of a `/workspace/...` URL, else the absolute path as-is. */
export function runOutputPath(outputUrl?: string, outputPath?: string): string | undefined {
  // toWorkspaceUrl does not percent-encode, so the rest of the URL is the path itself.
  if (outputUrl?.startsWith('/workspace/')) return outputUrl.slice('/workspace/'.length)
  return outputPath
}

/** What `inputs.image` holds when the run got its image as data, not as a file. */
export const ATTACHED_IMAGE_INPUT = '(attached image)'

/**
 * A run's inputs: the image file of each Image node (`image` is the first,
 * `images` lists them all when there are several). An image handed over as
 * data replaces those files, so it is recorded as attached.
 */
export function workflowRunInputs(workflow: WorkflowLike, attachedImage: boolean): Record<string, unknown> {
  if (attachedImage) return { image: ATTACHED_IMAGE_INPUT }
  const images: string[] = []
  for (const node of workflow.nodes) {
    if (node.type !== 'imageNode') continue
    const filePath = node.data.params?.filePath
    if (typeof filePath === 'string' && filePath.trim() !== '' && !images.includes(filePath)) images.push(filePath)
  }
  if (images.length === 0) return {}
  return images.length === 1 ? { image: images[0] } : { image: images[0], images }
}

/** The step the runner is on, as the Queue page shows it ("Step 2/4 · Generate Mesh"). */
export interface LiveRunCurrentStep {
  /** 1-based position of the step in the current pass (main run or Wait branch). */
  index:    number
  /** Steps in the current pass; 0 when unknown. */
  total:    number
  name:     string
  /** What the step is doing right now, e.g. "Generating…". */
  detail:   string
  /** 0-100. */
  progress: number
}

/** The workflow run this window is executing, with its live progress. */
export interface LiveWorkflowRun {
  runId:        string
  workflowId:   string | null
  workflowName: string
  status:       RunStatus
  /** Running but waiting on the user (a Wait branch, a paused loop). */
  paused:       boolean
  startedAt:    number
  endedAt:      number | null
  inputs:       Record<string, unknown>
  /** Steps run so far, in order; the open one is `running`. */
  steps:        RunRecord['steps']
  current:      LiveRunCurrentStep | null
  outputPath:   string | null
  error:        string | null
}

/** The runner's progress fields this needs (WorkflowRunState). */
interface RunProgress {
  status:        'idle' | 'running' | 'paused' | 'done' | 'error'
  blockIndex:    number
  blockTotal:    number
  blockProgress: number
  blockStep:     string
}

export function toLiveWorkflowRun(record: WorkflowRunRecord, progress: RunProgress): LiveWorkflowRun {
  const open = record.status === 'running' ? record.steps[record.steps.length - 1] : undefined
  const current = open && open.ended_at == null
    ? {
        index:    Math.max(1, progress.blockIndex + 1),
        total:    Math.max(0, progress.blockTotal),
        name:     open.name,
        detail:   progress.blockStep,
        progress: Math.max(0, Math.min(100, progress.blockProgress)),
      }
    : null
  return {
    runId:        record.id,
    workflowId:   record.workflow_id ?? null,
    workflowName: record.workflow_name ?? 'Workflow',
    status:       record.status,
    paused:       record.status === 'running' && progress.status === 'paused',
    startedAt:    record.started_at ?? record.created_at,
    endedAt:      record.ended_at ?? null,
    inputs:       record.inputs,
    steps:        record.steps,
    current,
    outputPath:   record.output_path ?? null,
    error:        record.error ?? null,
  }
}

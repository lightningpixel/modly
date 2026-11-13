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

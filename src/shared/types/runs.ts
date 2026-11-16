// Persisted run history -- mirrors api/schemas/runs.py (RunRecord). One record per
// generation, workflow or mesh-op run, listed by GET /workflow-runs. This is the
// shape the provenance model (T-F1) is meant to reuse rather than a second store.
// Timestamps are epoch seconds; output_path is workspace-relative when the output
// lives in the workspace, absolute otherwise.

export type RunKind = 'generation' | 'workflow' | 'mesh_op'
/** 'interrupted' = still in flight when the backend stopped; terminal. */
export type RunStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled' | 'interrupted'

export interface RunStep {
  name:        string
  node_id?:    string | null
  status:      RunStatus
  started_at:  number
  ended_at?:   number | null
}

export interface RunRecord {
  id:             string
  kind:           RunKind
  status:         RunStatus
  model_id?:      string | null
  workflow_id?:   string | null
  workflow_name?: string | null
  op_id?:         string | null
  inputs:         Record<string, unknown>
  params:         Record<string, unknown>
  steps:          RunStep[]
  error?:         string | null
  output_path?:   string | null
  created_at:     number
  started_at?:    number | null
  ended_at?:      number | null
  /** Computed by the backend; null while the run has not ended. */
  duration_s?:    number | null
}

export interface RunRecordPage {
  runs:   RunRecord[]
  total:  number
  limit:  number
  offset: number
}

import { useWorkflowRunStore } from './workflowRunStore'
import type { WaitState } from './workflowRunStore'

export interface WaitButtonModel {
  waitState:   WaitState | undefined
  canContinue: boolean
  isRunning:   boolean
  label:       'Retry' | 'Continue'
  buttonClass: string
  statusText:  string
  onContinue:  () => void
}

// Shared derivation for the Wait Continue/Retry control, used by both the
// canvas node (WaitNode) and the params panel (WaitParamRow). Keeps the two
// renderings in sync — they differ only in markup/sizing, not in logic.
export function useWaitButton(nodeId: string): WaitButtonModel {
  const waitState       = useWorkflowRunStore((s) => s.waitStates[nodeId])
  const runningBranchId = useWorkflowRunStore((s) => s.runningBranchId)
  const status          = useWorkflowRunStore((s) => s.runState.status)
  const continueRun     = useWorkflowRunStore((s) => s.continueRun)

  const otherBranchRunning = runningBranchId !== null && runningBranchId !== nodeId
  // Pre-phase: shared nodes (e.g. Generate Mesh) still running before any branch hands off.
  const inPrePhase  = status === 'running' && runningBranchId === null
  const isRunning   = waitState === 'running'
  // A pre-phase failure aborts the run before any handoff (status → 'error' while
  // this Wait is still 'pending'): it never became runnable, so no Continue.
  const runAborted  = status === 'error' && waitState === 'pending'
  const canContinue = (waitState === 'pending' || waitState === 'done' || waitState === 'error') && !otherBranchRunning && !inPrePhase && !runAborted
  const label: 'Retry' | 'Continue' = waitState === 'done' || waitState === 'error' ? 'Retry' : 'Continue'

  const buttonClass = waitState === 'error'
    ? 'bg-red-500/15 border-red-500/30 text-red-400 hover:bg-red-500/25'
    : waitState === 'done'
    ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/25'
    : 'bg-amber-500/15 border-amber-500/30 text-amber-400 hover:bg-amber-500/25'

  const statusText =
    waitState === 'blocked' ? 'Waiting for the previous step to finish…' :
    waitState === 'running' ? 'This step is running…' :
    waitState === 'done'    ? 'This step finished. Retry runs it again without remaking earlier results.' :
    waitState === 'error'   ? 'This step stopped. Fix the answer or setting, then click Retry.' :
    waitState === 'pending' && runAborted ? 'An earlier step stopped. Fix that error and start again.' :
    waitState === 'pending' && inPrePhase ? 'Waiting for earlier steps…' :
    waitState === 'pending' && otherBranchRunning ? 'Another step is running…' :
    waitState === 'pending' ? 'Ready. Click Continue to run this step.' :
    'Click Continue when you are ready for this step.'

  return { waitState, canContinue, isRunning, label, buttonClass, statusText, onContinue: () => continueRun(nodeId) }
}

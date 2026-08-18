/**
 * What an earlier assistant turn is allowed to claim when it goes back to the model.
 *
 * A turn that applied nothing but says "the workflow has been updated" is, in the
 * next request, indistinguishable from a turn that really did update it. A local
 * model reads its own transcript as precedent: in a first-run session it claimed
 * three edits in a row without calling a single tool, each claim propped up by
 * the last. Marking the turns that changed nothing removes the precedent.
 */

/** An action the app applied. Only a payload means the app state actually moved —
 *  a lookup, or a tool call rejected by validation, carries none. */
export interface AppliedAction { payload?: unknown }

export function appliedSomething(actions: AppliedAction[] | undefined): boolean {
  return !!actions?.some((a) => a.payload)
}

export const NO_CHANGE_MARK = '[App: this reply changed nothing.]'

/** The assistant content to send back, with the mark added when the turn moved
 *  nothing. Assistant turns only — a user message is never annotated. */
export function markUnappliedTurn(
  role:    string,
  content: string,
  actions: AppliedAction[] | undefined,
): string {
  if (role !== 'assistant' || appliedSomething(actions)) return content
  if (content.includes(NO_CHANGE_MARK)) return content
  return content ? `${content}\n${NO_CHANGE_MARK}` : content
}

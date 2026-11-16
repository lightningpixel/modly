/**
 * Native OS notification (Windows toast / macOS Notification Center / Linux) for
 * events worth surfacing even when the user isn't looking at the app — e.g. a
 * generation or workflow run finishing while they're in another window. Plays
 * each platform's own default notification sound (the toast isn't `silent`).
 *
 * Skipped when the app window already has focus: the user is looking right at
 * it, so a toast on top would just be noise.
 */
async function notifyIfUnfocused(title: string, body: string): Promise<void> {
  if (typeof document !== 'undefined' && document.hasFocus()) return
  try {
    await window.electron.notifications.show(title, body)
  } catch {
    // Notifications not available (e.g. unsupported platform)
  }
}

export function showCompletionNotification(body: string, title = 'Modly'): Promise<void> {
  return notifyIfUnfocused(title, body)
}

const MAX_ERROR_BODY = 120

export interface RunErrorInput {
  /** Notification title, e.g. "Generation failed". */
  title:      string
  /** What failed — the model id or workflow name — prefixed to the message. */
  name?:      string
  error:      unknown
  /** The user stopped the run themselves: nothing to tell them. */
  cancelled?: boolean
}

/**
 * Decide whether a failed run deserves a notification and with what text: none
 * for a user cancellation, otherwise the run's name plus the first line of the
 * error (tracebacks and `Error: ` prefixes trimmed), short enough for a toast.
 */
export function buildRunErrorNotification(input: RunErrorInput): { title: string; body: string } | null {
  if (input.cancelled) return null
  const raw = input.error instanceof Error ? input.error.message : String(input.error ?? '')
  const firstLine = raw.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? ''
  const message = firstLine.replace(/^(Error:\s*)+/, '') || 'Unknown error'
  const full = input.name ? `${input.name}: ${message}` : message
  const body = full.length > MAX_ERROR_BODY ? `${full.slice(0, MAX_ERROR_BODY - 1)}…` : full
  return { title: input.title, body }
}

export function showRunErrorNotification(input: RunErrorInput): Promise<void> {
  const notification = buildRunErrorNotification(input)
  return notification ? notifyIfUnfocused(notification.title, notification.body) : Promise.resolve()
}

/**
 * Native OS notification (Windows toast / macOS Notification Center / Linux) for
 * events worth surfacing even when the user isn't looking at the app — e.g. a
 * generation or workflow run finishing while they're in another window. Plays
 * each platform's own default notification sound (the toast isn't `silent`).
 *
 * Skipped when the app window already has focus: the user is looking right at
 * it, so a toast on top would just be noise.
 */
export async function showCompletionNotification(body: string, title = 'Modly'): Promise<void> {
  if (typeof document !== 'undefined' && document.hasFocus()) return
  try {
    await window.electron.notifications.show(title, body)
  } catch {
    // Notifications not available (e.g. unsupported platform)
  }
}

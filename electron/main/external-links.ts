/**
 * What may be handed to shell.openExternal.
 *
 * openExternal asks the OS to open the URL with whatever handles that scheme,
 * so `file:///C:/…/payload.exe` runs the payload and a custom scheme registered
 * by another installed application does whatever that application does. The
 * renderer can reach it (`shell:openExternal`), and the URLs it passes are not
 * always its own: an extension manifest carries a `source`, the registry
 * carries links, and the agent writes text the user clicks on.
 *
 * So the scheme is allow-listed rather than filtered: only the ones a link in a
 * document is expected to use.
 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

export function isSafeExternalUrl(url: unknown): boolean {
  if (typeof url !== 'string' || url.length > 2048) return false
  try {
    return ALLOWED_PROTOCOLS.has(new URL(url).protocol)
  } catch {
    return false   // not a URL at all - a bare path, or something crafted
  }
}

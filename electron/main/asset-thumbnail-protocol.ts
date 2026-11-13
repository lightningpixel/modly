import { app, protocol } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { resolveThumbnailUrl, THUMBNAIL_PROTOCOL } from './asset-thumbnail-cache'

/** Dedicated folder: userData/cache collides with Chromium's own disk cache on Windows. */
export function getThumbnailsDir(): string {
  return join(app.getPath('userData'), 'thumbnails')
}

/** Must run before `app.whenReady()` resolves. */
export function registerThumbnailScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: THUMBNAIL_PROTOCOL, privileges: { standard: true, secure: true } },
  ])
}

/**
 * Serves cached thumbnails as `modly-thumb://thumbnails/<file>.webp`. Works for
 * both the dev server (http) and packaged (file://) renderer origins, which a
 * plain file:// URL would not. Only names matching the cache's own pattern
 * resolve, so the scheme cannot reach anything else on disk.
 */
export function handleThumbnailProtocol(): void {
  protocol.handle(THUMBNAIL_PROTOCOL, async (request) => {
    const filePath = resolveThumbnailUrl(getThumbnailsDir(), request.url)
    if (!filePath) return new Response(null, { status: 400 })
    try {
      const body = await readFile(filePath)
      return new Response(body, {
        headers: {
          'content-type': 'image/webp',
          // File names embed the source version, so a URL's content never changes.
          'cache-control': 'public, max-age=31536000, immutable',
        },
      })
    } catch {
      return new Response(null, { status: 404 })
    }
  })
}

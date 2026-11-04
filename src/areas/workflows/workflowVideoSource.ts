const VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi'])

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:\//.test(value) || value.startsWith('//')
}

function isSafeRelativePath(value: string): boolean {
  if (!value || value !== value.trim() || value.includes('\u0000')) return false
  if (isAbsolutePath(value) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
      || /%(?:25|2e|2f|5c|00)/i.test(value) || /%(?![0-9a-f]{2})/i.test(value)) return false
  return value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
}

export function normalizeVideoSource(
  rawPath: string | undefined,
  workspaceDir: string,
): { workspacePath: string; absolutePath: string } | undefined {
  const workspacePath = rawPath?.replace(/\\/g, '/')
  if (!workspacePath || !isSafeRelativePath(workspacePath)) return undefined
  const extension = workspacePath.split('.').pop()?.toLowerCase()
  if (!extension || !VIDEO_EXTENSIONS.has(extension)) return undefined
  const root = workspaceDir.replace(/\\/g, '/').replace(/\/+$/, '')
  return { workspacePath, absolutePath: `${root}/${workspacePath}` }
}

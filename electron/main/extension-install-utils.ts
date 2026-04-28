export interface InstallManifest {
  id?: string
  type?: 'model' | 'process'
  entry?: string
  generator_class?: string
  nodes?: Array<{ id?: string }>
}

export interface ValidatedInstallManifest {
  id: string
  isProcess: boolean
  isPythonProcess: boolean
  entryFile: string
  hasNodes: boolean
}

export function validateInstallManifest(
  manifest: InstallManifest,
  opts: {
    hasEntryFile: (entryFile: string) => boolean
    hasGeneratorFile: () => boolean
  },
  sourceLabel: string,
): ValidatedInstallManifest {
  if (!manifest.id) throw new Error('manifest.json: required field "id" missing')

  const isProcess = manifest.type === 'process'
  const entryFile = manifest.entry ?? 'processor.js'
  const nodes = Array.isArray(manifest.nodes) ? manifest.nodes.filter((node) => node?.id) : []

  if (isProcess) {
    if (!opts.hasEntryFile(entryFile)) {
      throw new Error(`manifest.json: entry file "${entryFile}" missing from ${sourceLabel}`)
    }
  } else {
    if (!opts.hasGeneratorFile()) throw new Error(`generator.py missing from ${sourceLabel}`)
    if (!manifest.generator_class) throw new Error('manifest.json: required field "generator_class" missing')
  }

  return {
    id: manifest.id,
    isProcess,
    isPythonProcess: isProcess && entryFile.endsWith('.py'),
    entryFile,
    hasNodes: nodes.length > 0,
  }
}

export function isSetupFailureFatal(kind: {
  isProcess: boolean
  isPythonProcess: boolean
}): boolean {
  return !kind.isProcess || kind.isPythonProcess
}

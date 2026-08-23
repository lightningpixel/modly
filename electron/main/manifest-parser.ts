/**
 * Reads an extension's manifest.json into the shape the app uses.
 *
 * This is the trust boundary: everything here comes from third-party JSON, so a
 * field can be missing, null, or the wrong type, and none of that may break the
 * neighbouring fields. Kept out of ipc-handlers.ts — and free of electron — so
 * the parsing can be exercised directly on a manifest.
 */

export function isTrustedSource(source: string | undefined, trustedRepos: Set<string>): boolean {
  if (!source) return false
  return trustedRepos.has(source.toLowerCase().replace(/\/$/, ''))
}

export type ParsedManifest = {
  id?: string; name?: string; displayName?: string; version?: string
  description?: string; author?: string | { name?: string }
  source?: string; generator_class?: string
  // extension type
  type?:  'model' | 'process'
  entry?: string
  // Optional top-level fallbacks — applied to each node if not set on the node
  params_schema?:  unknown[]
  param_defaults?: Record<string, unknown>
  // Already the shape the Python side reads (extension_process.py,
  // generator_registry.py): a single-node extension states its cost once, at
  // the top. Inherited by every node that does not state its own.
  vram_gb?:        number
  nodes?: {
    id:                string
    name?:             string
    description?:      string
    // Declared as plain strings on purpose: this is parsed JSON, so anything
    // can be in there. coercePortType() is what narrows it to a known type.
    input?:            string
    inputs?:           string[]
    input_labels?:     string[]
    output?:           string
    terminal?:         boolean
    // Optional, and read defensively: a manifest may declare it, omit it, or
    // give it the wrong type without breaking the fields around it.
    vram_gb?:          number
    params_schema?:    unknown[]
    param_defaults?:   Record<string, unknown>
    hf_repo?:          string
    download_check?:   string
    hf_skip_prefixes?: string[]
    hf_include_prefixes?: string[]
  }[]
}

// Port types the app knows how to draw and type-check. An unknown string used
// to flow straight through and land as `undefined` downstream, which preflight
// treats as a wildcard — so a single typo in a manifest silently disabled every
// type check on that node. Coerce to a safe default and say so in the log.
const DATA_TYPES = ['mesh', 'image', 'text', 'audio'] as const
type DataPortType = typeof DATA_TYPES[number]

function coercePortType(
  value:    string | undefined,
  fallback: DataPortType,
  where:    string,
  warn:     (message: string) => void,
): DataPortType {
  if (value === undefined) return fallback
  if ((DATA_TYPES as readonly string[]).includes(value)) return value as DataPortType
  warn(
    `[manifest] ${where}: unknown port type "${value}" — expected one of ${DATA_TYPES.join(', ')}. ` +
    `Falling back to "${fallback}".`,
  )
  return fallback
}

export function parseExtensionManifest(
  parsed:       ParsedManifest,
  fallbackId:   string,
  trustedRepos: Set<string>,
  builtin  = false,
  warn: (message: string) => void = () => {},
) {
  const common = {
    id:          parsed.id          ?? fallbackId,
    name:        parsed.displayName ?? parsed.name ?? fallbackId,
    version:     parsed.version,
    description: parsed.description,
    author:      typeof parsed.author === 'string' ? parsed.author : parsed.author?.name,
    trusted:     builtin || isTrustedSource(parsed.source, trustedRepos),
    source:      parsed.source,
    builtin,
  }

  const extLabel = parsed.id ?? fallbackId
  // Manifests are third-party JSON: a field can be a string, null, or absent.
  const positiveNumber = (v: unknown): number | undefined =>
    typeof v === 'number' && v > 0 ? v : undefined

  const nodes = (parsed.nodes ?? []).map(n => ({
    id:             n.id,
    name:           n.name ?? n.id,
    // Per node, because the agent reads it per node: one line covering both a
    // generator and its texture pass describes neither.
    description:    n.description ?? parsed.description,
    input:          coercePortType(n.input, 'image', `${extLabel}/${n.id} input`, warn),
    inputs:         n.inputs?.map((t, i) => coercePortType(t, 'image', `${extLabel}/${n.id} inputs[${i}]`, warn)),
    inputLabels:    n.input_labels,
    output:         coercePortType(n.output, 'mesh', `${extLabel}/${n.id} output`, warn),
    terminal:       n.terminal ?? false,
    vramGb:         positiveNumber(n.vram_gb) ?? positiveNumber(parsed.vram_gb),
    paramsSchema:   n.params_schema ?? parsed.params_schema ?? [],
    paramDefaults:  { ...(parsed.param_defaults ?? {}), ...(n.param_defaults ?? {}) },
    hfRepo:         n.hf_repo,
    downloadCheck:  n.download_check,
    hfSkipPrefixes: n.hf_skip_prefixes,
    hfIncludePrefixes: n.hf_include_prefixes,
  }))

  if (parsed.type === 'process') {
    return { ...common, type: 'process' as const, entry: parsed.entry ?? 'processor.js', nodes }
  }

  return { ...common, type: 'model' as const, nodes }
}

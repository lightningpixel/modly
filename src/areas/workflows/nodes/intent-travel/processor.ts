import crypto = require('crypto')
import fs     = require('fs')
import path   = require('path')

interface ProcessInput {
  filePath?: string
  text?: string
  nodeId?: string
}

interface ProcessResult {
  filePath?: string
}

interface ProcessContext {
  workspaceDir: string
  progress:     (pct: number, label: string) => void
}

interface IntentContext {
  sourceImage?: string | null
  project?: string | null
  extraDetails?: string | null
  movement?: string | null
  styleName?: string | null
  stylePrompt?: string | null
  workflowId?: string | null
  workflowName?: string | null
}

type JsonObject = Record<string, unknown>

const SCHEMA = 'modly.intent.v1'
const APPEND_ONLY_LISTS = ['artist_words', 'style_choices', 'findings', 'stage_events'] as const

function now(): string {
  return new Date().toISOString()
}

function entry(kind: string, fields: JsonObject = {}): JsonObject {
  return { id: crypto.randomUUID(), kind, at: now(), ...fields }
}

function sidecarPath(assetPath: string): string {
  return assetPath.replace(/\.[^./\\]+$/, '') + '.tags.json'
}

function readObject(filePath: string, missingOk: boolean): JsonObject {
  if (!fs.existsSync(filePath)) {
    if (missingOk) return {}
    throw new Error(`Artist context is missing: ${filePath}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch (error) {
    throw new Error(`Artist context cannot be read from ${filePath}: ${String(error)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Artist context is not a JSON object: ${filePath}`)
  }
  return parsed as JsonObject
}

function writeObjectAtomic(filePath: string, value: JsonObject): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', 'utf-8')
    fs.renameSync(temporary, filePath)
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text.length > 0 ? text : null
}

function requireIntent(sidecar: JsonObject, assetPath: string): JsonObject {
  const intent = sidecar.intent
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) {
    throw new Error(`Artist context is missing beside ${assetPath}`)
  }
  const record = intent as JsonObject
  if (record.schema !== SCHEMA || typeof record.intent_id !== 'string') {
    throw new Error(`Artist context beside ${assetPath} has an unsupported format`)
  }
  for (const key of APPEND_ONLY_LISTS) {
    if (!Array.isArray(record[key])) {
      throw new Error(`Artist context beside ${assetPath} has no ${key} history`)
    }
  }
  if (!record.request || typeof record.request !== 'object' || Array.isArray(record.request)) {
    throw new Error(`Artist context beside ${assetPath} has no request`)
  }
  return JSON.parse(JSON.stringify(record)) as JsonObject
}

function word(kind: 'movement' | 'context', text: string, source: string): JsonObject {
  return entry(kind, { text, source, origin: 'artist' })
}

function startRecord(assetPath: string, context: IntentContext): void {
  const metadataPath = sidecarPath(assetPath)
  const sidecar = readObject(metadataPath, true)
  if (sidecar.intent) {
    throw new Error(`Refusing to replace artist context in ${metadataPath}`)
  }

  const extraDetails = nonEmpty(context.extraDetails)
  const movement = nonEmpty(context.movement)
  const styleName = nonEmpty(context.styleName)
  const stylePrompt = nonEmpty(context.stylePrompt)
  const project = nonEmpty(context.project)
  const words: JsonObject[] = []
  if (movement) words.push(word('movement', movement, 'request.movement'))
  if (extraDetails) words.push(word('context', extraDetails, 'request.extra_details'))
  const movementWord = words.find((row) => row.kind === 'movement')
  const created = now()
  const record: JsonObject = {
    schema: SCHEMA,
    intent_id: crypto.randomUUID(),
    created_at: created,
    updated_at: created,
    request: {
      what_word_id: null,
      movement_word_id: movementWord?.id ?? null,
      source_image: nonEmpty(context.sourceImage),
      project,
    },
    artist_words: words,
    style_choices: styleName || stylePrompt
      ? [entry('style', {
          stage: 'request',
          name: styleName,
          prompt: stylePrompt,
        })]
      : [],
    findings: [],
    stage_events: [
      entry('created', {
        stage: 'request',
        asset: assetPath,
        note: 'Artist request captured',
        workflow: {
          id: nonEmpty(context.workflowId),
          name: nonEmpty(context.workflowName),
        },
      }),
    ],
  }
  sidecar.intent = record
  if (sidecar.project == null) sidecar.project = project
  writeObjectAtomic(metadataPath, sidecar)
}

function rows(record: JsonObject, key: typeof APPEND_ONLY_LISTS[number]): JsonObject[] {
  return (record[key] as JsonObject[]).map((row) => JSON.parse(JSON.stringify(row)) as JsonObject)
}

function mergeIntent(older: JsonObject, newer: JsonObject): JsonObject {
  if (older.intent_id !== newer.intent_id) {
    throw new Error('Cannot merge artist context from different requests')
  }
  if (JSON.stringify(older.request) !== JSON.stringify(newer.request)) {
    throw new Error('Copies of the artist request disagree')
  }
  const merged = JSON.parse(JSON.stringify(newer)) as JsonObject
  for (const key of APPEND_ONLY_LISTS) {
    const byId = new Map<string, JsonObject>()
    for (const row of [...rows(older, key), ...rows(newer, key)]) {
      const id = nonEmpty(row.id)
      if (!id) throw new Error(`Artist context ${key} entry has no id`)
      const prior = byId.get(id)
      if (prior && JSON.stringify(prior) !== JSON.stringify(row)) {
        throw new Error(`Artist context ${key} entry ${id} has conflicting contents`)
      }
      if (!prior) byId.set(id, row)
    }
    merged[key] = [...byId.values()]
  }
  merged.created_at = String(older.created_at) < String(newer.created_at)
    ? older.created_at
    : newer.created_at
  merged.updated_at = String(older.updated_at) > String(newer.updated_at)
    ? older.updated_at
    : newer.updated_at
  return merged
}

function carryRecord(sourceAsset: string, destinationAsset: string, params: JsonObject): void {
  const sourceSidecar = readObject(sidecarPath(sourceAsset), false)
  const sourceIntent = requireIntent(sourceSidecar, sourceAsset)
  const destinationPath = sidecarPath(destinationAsset)
  const destination = readObject(destinationPath, true)
  destination.intent = destination.intent
    ? mergeIntent(requireIntent(destination, destinationAsset), sourceIntent)
    : sourceIntent

  const carried = destination.intent as JsonObject
  ;(carried.stage_events as JsonObject[]).push(entry('carried', {
    stage: nonEmpty(params.stage) ?? 'unknown',
    from_asset: sourceAsset,
    to_asset: destinationAsset,
    details: params.details && typeof params.details === 'object' ? params.details : {},
  }))
  carried.updated_at = now()
  if (destination.project == null) {
    const request = carried.request as JsonObject
    destination.project = sourceSidecar.project ?? request.project ?? null
  }
  writeObjectAtomic(destinationPath, destination)
}

function stageSource(input: ProcessInput, params: JsonObject, context: ProcessContext): string {
  const originalPath = nonEmpty(input.filePath)
  const encoded = nonEmpty(input.text)
  if (!originalPath && !encoded) {
    throw new Error('Artist context needs the source image')
  }

  const suffix = originalPath ? (path.extname(originalPath) || '.png') : '.png'
  const runDir = path.join(context.workspaceDir, 'Workflows', 'intent-sources', crypto.randomUUID())
  fs.mkdirSync(runDir, { recursive: true })
  const staged = path.join(runDir, `source${suffix}`)
  if (originalPath) {
    if (!fs.existsSync(originalPath)) throw new Error(`Source image does not exist: ${originalPath}`)
    fs.copyFileSync(originalPath, staged)
  } else {
    const base64 = encoded!.includes(';base64,') ? encoded!.split(';base64,', 2)[1] : encoded!
    fs.writeFileSync(staged, Buffer.from(base64, 'base64'))
  }
  startRecord(staged, (params.context ?? {}) as IntentContext)
  return staged
}

const processor = async (
  input: ProcessInput,
  params: JsonObject,
  context: ProcessContext,
): Promise<ProcessResult> => {
  if (input.nodeId === 'start') {
    context.progress(20, 'Remembering your request…')
    const staged = stageSource(input, params, context)
    context.progress(100, 'Request remembered')
    return { filePath: staged }
  }

  const source = nonEmpty(input.filePath)
  const destination = nonEmpty(params.destinationPath)
  if (!source || !destination) {
    throw new Error('Carrying artist context needs both stage input and output')
  }
  context.progress(50, 'Carrying artist context…')
  carryRecord(source, destination, params)
  context.progress(100, 'Artist context carried')
  return { filePath: destination }
}

export = processor

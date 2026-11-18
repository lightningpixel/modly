// Agent conversations on disk: one JSON file per conversation in
// <userData>/agent/conversations/{id}.json.

import { join } from 'path'
import { randomUUID } from 'crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'fs/promises'

export interface ConversationSummary {
  id: string
  title: string
  updatedAt: number
}

export interface Conversation extends ConversationSummary {
  createdAt: number
  messages: unknown[]
}

export const CONVERSATION_ID_RE = /^[a-z0-9-]{1,64}$/

/** Ids name files on disk: anything else could escape the conversations folder. */
export function isValidConversationId(id: unknown): id is string {
  return typeof id === 'string' && CONVERSATION_ID_RE.test(id)
}

/** Shape check for a conversation read from disk or received over IPC. */
export function isConversation(value: unknown): value is Conversation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const c = value as Record<string, unknown>
  return isValidConversationId(c.id)
    && typeof c.title === 'string'
    && typeof c.createdAt === 'number'
    && typeof c.updatedAt === 'number'
    && Array.isArray(c.messages)
}

/** Newest first; ties keep a stable order by id. */
export function sortSummaries<T extends ConversationSummary>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => (b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id))
}

/** Windows antivirus or indexers briefly lock a freshly written file. */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
const RENAME_ATTEMPTS = 3
const RENAME_RETRY_MS = 50
/** A temp file this old belongs to no write in flight: a crash left it behind. */
export const ORPHAN_TMP_AGE_MS = 60_000

export interface ConversationStorageOptions {
  /** Injectable for tests. */
  rename?: (from: string, to: string) => Promise<void>
  retryDelayMs?: number
  now?: () => number
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export function createConversationStorage(dir: string, options: ConversationStorageOptions = {}) {
  const renameFile = options.rename ?? rename
  const retryDelayMs = options.retryDelayMs ?? RENAME_RETRY_MS
  const now = options.now ?? Date.now
  const fileFor = (id: string): string => join(dir, `${id}.json`)

  async function readConversation(id: string): Promise<Conversation | null> {
    if (!isValidConversationId(id)) return null
    try {
      const parsed: unknown = JSON.parse(await readFile(fileFor(id), 'utf-8'))
      return isConversation(parsed) && parsed.id === id ? parsed : null
    } catch {
      return null
    }
  }

  async function renameWithRetry(from: string, to: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await renameFile(from, to)
        return
      } catch (err) {
        const code = (err as NodeJS.ErrnoException | null)?.code
        if (attempt >= RENAME_ATTEMPTS || !code || !TRANSIENT_RENAME_CODES.has(code)) throw err
        await sleep(retryDelayMs * attempt)
      }
    }
  }

  /** Best effort: temp files left by a crash between write and rename. */
  async function removeOrphanTmpFiles(files: readonly string[]): Promise<void> {
    for (const file of files) {
      if (!file.endsWith('.tmp')) continue
      const path = join(dir, file)
      try {
        if (now() - (await stat(path)).mtimeMs >= ORPHAN_TMP_AGE_MS) await rm(path, { force: true })
      } catch {
        // Gone already, or locked: the next listing tries again.
      }
    }
  }

  return {
    async list(): Promise<ConversationSummary[]> {
      let files: string[]
      try {
        files = await readdir(dir)
      } catch {
        return []
      }
      await removeOrphanTmpFiles(files)
      const summaries: ConversationSummary[] = []
      for (const file of files) {
        if (!file.endsWith('.json')) continue
        const c = await readConversation(file.slice(0, -'.json'.length))
        if (c) summaries.push({ id: c.id, title: c.title, updatedAt: c.updatedAt })
      }
      return sortSummaries(summaries)
    },

    read: readConversation,

    async save(conversation: unknown): Promise<void> {
      if (!isConversation(conversation)) throw new Error('Invalid conversation')
      await mkdir(dir, { recursive: true })
      const target = fileFor(conversation.id)
      // Write then rename: a crash mid-write never leaves a truncated file.
      const tmp = `${target}.${randomUUID()}.tmp`
      await writeFile(tmp, JSON.stringify(conversation), 'utf-8')
      try {
        await renameWithRetry(tmp, target)
      } catch (err) {
        await rm(tmp, { force: true })
        throw err
      }
    },

    async remove(id: string): Promise<void> {
      if (!isValidConversationId(id)) throw new Error('Invalid conversation id')
      await rm(fileFor(id), { force: true })
    },
  }
}

import type { Workflow } from '@shared/types/electron.d'

// Events of POST /agent/chat/stream, one JSON object per SSE `data:` line.

export interface AgentActionPayload {
  type: string
  url?: string
  face_count?: number
  workflow_id?: string
  workflow_name?: string
  workflow?: Omit<Workflow, 'id' | 'createdAt' | 'updatedAt'>
}

export interface AgentAction {
  tool: string
  result: string
  payload?: AgentActionPayload | null
}

export type AgentEvent =
  | { type: 'token'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_start'; id: string; tool: string; arguments: Record<string, unknown> }
  | { type: 'tool_done'; id: string; tool: string; result: string; payload: AgentActionPayload | null }
  | { type: 'done'; message: string; actions: AgentAction[]; thinking: string | null; error: boolean }

function parseBlock(block: string): AgentEvent | null {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n')
  if (!data) return null
  try {
    return JSON.parse(data) as AgentEvent
  } catch {
    return null
  }
}

/** Splits SSE text into events; a chunk may end in the middle of one. */
export function createSseParser(): { push: (chunk: string) => AgentEvent[]; end: () => AgentEvent[] } {
  let buffer = ''
  return {
    push(chunk) {
      buffer += chunk.replace(/\r\n?/g, '\n')
      const blocks = buffer.split('\n\n')
      buffer = blocks.pop() ?? ''
      return blocks.map(parseBlock).filter((e): e is AgentEvent => e !== null)
    },
    end() {
      const rest = parseBlock(buffer)
      buffer = ''
      return rest ? [rest] : []
    },
  }
}

/** Yields the events of a streamed agent response as they arrive. */
export async function* readAgentEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<AgentEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const parser = createSseParser()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      yield* parser.push(decoder.decode(value, { stream: true }))
    }
    yield* parser.push(decoder.decode())
    yield* parser.end()
  } finally {
    reader.releaseLock()
  }
}

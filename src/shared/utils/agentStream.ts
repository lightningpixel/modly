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

/** Why a guardrail ended the tool loop; `message` says what to do next. */
export interface ToolStop {
  code: 'tool_budget_exhausted' | 'tool_timeout'
  tool: string
  limit: number // tool calls for the budget, seconds for the timeout
  message: string
}

export interface AgentAction {
  tool: string
  result: string
  payload?: AgentActionPayload | null
  error?: ToolStop | null
}

export type AgentEvent =
  | { type: 'token'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_start'; id: string; tool: string; arguments: Record<string, unknown> }
  | { type: 'tool_done'; id: string; tool: string; result: string; payload: AgentActionPayload | null; error?: ToolStop | null }
  | { type: 'done'; message: string; actions: AgentAction[]; thinking: string | null; error: boolean; stopped?: ToolStop | null }

/** Bounds of the request's `tool_budget` (calls per turn) and `tool_timeout` (seconds per call). */
export const TOOL_LIMITS = {
  budget:  { min: 1, max: 100,  default: 10 },
  timeout: { min: 5, max: 3600, default: 120 },
} as const

export function clampToolLimit(kind: keyof typeof TOOL_LIMITS, value: number): number {
  const { min, max, default: fallback } = TOOL_LIMITS[kind]
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

export function toolStopTitle(stop: ToolStop): string {
  return stop.code === 'tool_timeout'
    ? `${stop.tool.replace(/_/g, ' ')} timed out (${stop.limit} s)`
    : `Tool budget reached (${stop.limit} calls)`
}

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

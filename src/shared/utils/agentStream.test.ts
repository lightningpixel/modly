import assert from 'node:assert/strict'
import test from 'node:test'

import { clampToolLimit, createSseParser, readAgentEvents, TOOL_LIMITS, toolStopTitle } from './agentStream.ts'

const line = (event: object): string => `data: ${JSON.stringify(event)}\n\n`

test('an event cut across chunks is emitted once complete', () => {
  const parser = createSseParser()
  const text = line({ type: 'token', text: 'Hello' })

  assert.deepEqual(parser.push(text.slice(0, 12)), [])
  assert.deepEqual(parser.push(text.slice(12)), [{ type: 'token', text: 'Hello' }])
})

test('several events in one chunk all come out, in order', () => {
  const parser = createSseParser()

  const events = parser.push(line({ type: 'token', text: 'a' }) + line({ type: 'thinking', text: 'b' }))

  assert.deepEqual(events.map((e) => e.type), ['token', 'thinking'])
})

test('CRLF separators and a final event without a blank line are handled', () => {
  const parser = createSseParser()

  assert.deepEqual(parser.push('data: {"type":"token","text":"x"}\r\n\r\ndata: {"type":"token","text":"y"}'), [
    { type: 'token', text: 'x' },
  ])
  assert.deepEqual(parser.end(), [{ type: 'token', text: 'y' }])
})

test('malformed and non-data lines are skipped', () => {
  const parser = createSseParser()

  assert.deepEqual(parser.push(': keep-alive\n\ndata: {not json\n\n' + line({ type: 'token', text: 'ok' })), [
    { type: 'token', text: 'ok' },
  ])
})

test('a client_tool event passes through with its call id, arguments and confirm flag', () => {
  const parser = createSseParser()
  const event = {
    type: 'client_tool',
    id: 'call_1',
    call_id: 'c-42',
    tool: 'uninstall_extension',
    arguments: { extension_id: 'triposr' },
    confirm: true,
  }
  const done = { type: 'tool_done', id: 'call_1', tool: 'uninstall_extension', result: 'ok', payload: null }

  const events = parser.push(line(event) + line(done))

  assert.deepEqual(events, [event, done])
  const [parsed] = events
  assert.ok(parsed.type === 'client_tool' && parsed.call_id === 'c-42' && parsed.confirm)
})

test('a generate_from_image payload keeps its model id', () => {
  const parser = createSseParser()
  const payload = { type: 'generate_from_image', model_id: 'sf3d/main' }

  const [event] = parser.push(line({ type: 'tool_done', id: 't', tool: 'generate_from_image', result: 'queued', payload }))

  assert.ok(event.type === 'tool_done')
  assert.deepEqual(event.payload, payload)
})

test('a response body is read into events, multi-byte characters intact', async () => {
  const bytes = new TextEncoder().encode(line({ type: 'token', text: 'é→' }) + line({ type: 'done', message: 'é→', actions: [], thinking: null, error: false }))
  // Split inside the multi-byte "é" so the decoder has to carry it over.
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, 31))
      controller.enqueue(bytes.slice(31))
      controller.close()
    },
  })

  const events = []
  for await (const event of readAgentEvents(body)) events.push(event)

  assert.deepEqual(events.map((e) => e.type), ['token', 'done'])
  assert.deepEqual(events[0], { type: 'token', text: 'é→' })
})

test('a tool-loop stop gets a short title for its code', () => {
  const stop = { tool: 'repair_mesh', message: 'm' }

  assert.equal(toolStopTitle({ ...stop, code: 'tool_budget_exhausted', limit: 10 }), 'Tool budget reached (10 calls)')
  assert.equal(toolStopTitle({ ...stop, code: 'tool_timeout', limit: 120 }), 'repair mesh timed out (120 s)')
})

test('tool limits are kept within what the API accepts', () => {
  assert.equal(clampToolLimit('budget', 0), TOOL_LIMITS.budget.min)
  assert.equal(clampToolLimit('budget', 7.6), 8)
  assert.equal(clampToolLimit('budget', 1e6), TOOL_LIMITS.budget.max)
  assert.equal(clampToolLimit('timeout', 1), TOOL_LIMITS.timeout.min)
  assert.equal(clampToolLimit('timeout', 90), 90)
  assert.equal(clampToolLimit('timeout', Number.NaN), TOOL_LIMITS.timeout.default)
})

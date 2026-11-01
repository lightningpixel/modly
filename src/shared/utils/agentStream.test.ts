import assert from 'node:assert/strict'
import test from 'node:test'

import { createSseParser, readAgentEvents } from './agentStream.ts'

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

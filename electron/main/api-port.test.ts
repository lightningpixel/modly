import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

async function load() {
  return import(new URL('./api-port.ts', import.meta.url).href)
}

function listen(host = '127.0.0.1', port = 0): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    // Read and drop: a never-read socket stays paused, misses the client's FIN,
    // and server.close() then waits for ever.
    const server = createServer((socket) => socket.resume())
    server.once('error', reject)
    server.listen(port, host, () => resolve({ server, port: (server.address() as { port: number }).port }))
  })
}

const close = (server: Server) => new Promise<void>((r) => server.close(() => r()))

function fakeDeps(state: { free: Set<number>; modly?: Set<number> }) {
  const killed: number[] = []
  const logs: string[] = []
  return {
    killed,
    logs,
    deps: {
      isFree: async (p: number) => state.free.has(p),
      isModly: async (p: number) => state.modly?.has(p) ?? false,
      kill: (p: number) => { killed.push(p); state.free.add(p) },
      osPort: async () => 50123,
      log: (m: string) => logs.push(m),
      wait: async () => {},
    },
  }
}

test('candidatePorts: preferred first, then 8765, then the next ports', async () => {
  const { candidatePorts } = await load()
  assert.deepEqual(candidatePorts(8765, 3), [8765, 8766, 8767, 8768])
  assert.deepEqual(candidatePorts(8767, 3), [8767, 8765, 8766, 8768])
})

test('pickPort keeps the preferred port when it is free', async () => {
  const { pickPort } = await load()
  const { deps, killed } = fakeDeps({ free: new Set([8765, 8766]) })
  assert.equal(await pickPort(8765, deps), 8765)
  assert.deepEqual(killed, [])
})

test('pickPort reclaims the port from an old Modly backend', async () => {
  const { pickPort } = await load()
  const { deps, killed } = fakeDeps({ free: new Set([8766]), modly: new Set([8765]) })
  assert.equal(await pickPort(8765, deps), 8765)
  assert.deepEqual(killed, [8765])
})

test('pickPort leaves another program alone and moves to the next port', async () => {
  const { pickPort } = await load()
  const { deps, killed, logs } = fakeDeps({ free: new Set([8767]) })
  assert.equal(await pickPort(8765, deps), 8767)
  assert.deepEqual(killed, [])
  assert.equal(logs.length, 2)
})

test('pickPort only reclaims the preferred port, not a Modly on a fallback port', async () => {
  const { pickPort } = await load()
  const { deps, killed } = fakeDeps({ free: new Set([8767]), modly: new Set([8766]) })
  assert.equal(await pickPort(8765, deps), 8767)
  assert.deepEqual(killed, [])
})

test('pickPort gives up on a Modly backend that does not die', async () => {
  const { pickPort } = await load()
  const { deps } = fakeDeps({ free: new Set([8766]), modly: new Set([8765]) })
  deps.kill = () => {} // stays alive
  assert.equal(await pickPort(8765, deps), 8766)
})

test('pickPort asks the OS when every candidate is taken', async () => {
  const { pickPort } = await load()
  const { deps } = fakeDeps({ free: new Set() })
  assert.equal(await pickPort(8765, deps), 50123)
})

test('looksLikeModlyHealth accepts current and old Modly backends only', async () => {
  const { looksLikeModlyHealth } = await load()
  assert.equal(looksLikeModlyHealth({ status: 'ok', service: 'modly' }), true)
  assert.equal(looksLikeModlyHealth({ status: 'ok' }), true) // before "service" existed
  assert.equal(looksLikeModlyHealth({ status: 'ok', version: '2.1' }), false)
  assert.equal(looksLikeModlyHealth({ status: 'ok', service: 'other' }), false)
  assert.equal(looksLikeModlyHealth({ status: 'down' }), false)
  assert.equal(looksLikeModlyHealth('ok'), false)
  assert.equal(looksLikeModlyHealth(null), false)
})

test('isPortFree sees a real listener, and the port once it is released', async () => {
  const { isPortFree } = await load()
  const { server, port } = await listen()
  assert.equal(await isPortFree('127.0.0.1', port), false)
  await close(server)
  assert.equal(await isPortFree('127.0.0.1', port), true)
})

test('isPortFree sees a listener bound on all interfaces (the Docker case)', async () => {
  const { isPortFree } = await load()
  const { server, port } = await listen('0.0.0.0')
  try {
    assert.equal(await isPortFree('127.0.0.1', port), false)
  } finally {
    await close(server)
  }
})

test('isModlyBackend asks /health and rejects a non-Modly server', async () => {
  const { isModlyBackend } = await load()
  const http = await import('node:http')
  const serve = (body: unknown) => new Promise<{ srv: import('node:http').Server; port: number }>((resolve) => {
    const srv = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)) })
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: (srv.address() as { port: number }).port }))
  })
  const modly = await serve({ status: 'ok', service: 'modly' })
  const other = await serve({ hello: 'world' })
  try {
    assert.equal(await isModlyBackend('127.0.0.1', modly.port), true)
    assert.equal(await isModlyBackend('127.0.0.1', other.port), false)
    const { server, port } = await listen() // raw TCP, never answers HTTP
    try { assert.equal(await isModlyBackend('127.0.0.1', port), false) } finally { await close(server) }
  } finally {
    for (const { srv } of [modly, other]) { srv.closeAllConnections(); srv.close() }
  }
})

test('parseNetstatListener finds the listener whatever the state language', async () => {
  const { parseNetstatListener } = await load()
  const netstat = [
    '',
    'Connexions actives',
    '',
    '  Proto  Adresse locale         Adresse distante       État',
    '  TCP    127.0.0.1:52000        127.0.0.1:8765         ESTABLISHED     900',
    '  TCP    127.0.0.1:18765        0.0.0.0:0              LISTENING       111',
    '  TCP    0.0.0.0:8765           0.0.0.0:0              ABHÖREN         4321',
    '  TCP    [::]:8765              [::]:0                 LISTENING       4321',
  ].join('\r\n')
  assert.equal(parseNetstatListener(netstat, 8765), '4321')
  assert.equal(parseNetstatListener(netstat, 9999), null)
})

test('findPortHolder names a real listening process', async () => {
  const { findPortHolder } = await load()
  const { server, port } = await listen()
  try {
    const holder = findPortHolder(port)
    assert.ok(holder?.endsWith(` (PID ${process.pid})`), holder ?? 'null')
    assert.match(holder ?? '', /node/i)
  } finally {
    await close(server)
  }
})

test('osAssignedPort returns a port that is free', async () => {
  const { osAssignedPort, isPortFree } = await load()
  const port = await osAssignedPort('127.0.0.1')
  assert.ok(port > 0)
  assert.equal(await isPortFree('127.0.0.1', port), true)
})

test('the port file is written and removed', async () => {
  const { writePortFile, removePortFile, PORT_FILE } = await load()
  const dir = mkdtempSync(join(tmpdir(), 'modly-port-'))
  try {
    writePortFile(dir, 8766)
    assert.equal(readFileSync(join(dir, PORT_FILE), 'utf8'), '8766')
    removePortFile(dir)
    assert.equal(existsSync(join(dir, PORT_FILE)), false)
    removePortFile(dir) // already gone: no throw
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

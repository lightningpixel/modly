import assert from 'node:assert/strict'
import test from 'node:test'

async function load() {
  return import(new URL('./startup-error.ts', import.meta.url).href)
}

// Real uvicorn output on a French Windows when the port is taken.
const WIN_IN_USE = [
  'INFO:     Started server process [1080]',
  'INFO:     Waiting for application startup.',
  'INFO:     Application startup complete.',
  "ERROR:    [Errno 10048] error while attempting to bind on address ('127.0.0.1', 8765): une seule utilisation de chaque adresse de socket (protocole/adresse réseau/port) est habituellement autorisée",
  'INFO:     Waiting for application shutdown.',
  'INFO:     Application shutdown complete.',
].join('\r\n')

test('detectPortProblem matches the errno whatever the OS language', async () => {
  const { detectPortProblem } = await load()
  assert.equal(detectPortProblem(WIN_IN_USE), 'in-use')
  assert.equal(detectPortProblem("ERROR:    [Errno 98] error while attempting to bind on address ('127.0.0.1', 8765): address already in use"), 'in-use')
  assert.equal(detectPortProblem("ERROR:    [Errno 48] error while attempting to bind on address ('127.0.0.1', 8765): address already in use"), 'in-use')
  assert.equal(detectPortProblem("ERROR:    [Errno 10013] error while attempting to bind on address ('127.0.0.1', 8765): accès refusé"), 'forbidden')
  assert.equal(detectPortProblem('ModuleNotFoundError: No module named fastapi'), null)
  // An errno that merely contains 48 or 98 is not a port conflict.
  assert.equal(detectPortProblem('[Errno 4898] something else'), null)
})

test('a port conflict names the port and the program holding it', async () => {
  const { describeStartupFailure } = await load()
  const msg = describeStartupFailure({ port: 8765, exitCode: 1, stderr: WIN_IN_USE, portHolder: 'com.docker.backend.exe (PID 4321)' })
  assert.match(msg, /^Port 8765 is already in use by com\.docker\.backend\.exe \(PID 4321\)\./)
  assert.doesNotMatch(msg, /exited unexpectedly/)

  const unknown = describeStartupFailure({ port: 8765, exitCode: 1, stderr: WIN_IN_USE, portHolder: null })
  assert.match(unknown, /^Port 8765 is already in use by another program\./)
})

test('a reserved port explains the Windows excluded range', async () => {
  const { describeStartupFailure } = await load()
  const msg = describeStartupFailure({ port: 8765, exitCode: 1, stderr: '[Errno 10013] error while attempting to bind' })
  assert.match(msg, /does not allow Modly to use port 8765/)
  assert.match(msg, /excludedportrange/)
})

test('any other crash shows the end of the traceback, without INFO lines', async () => {
  const { describeStartupFailure } = await load()
  const stderr = [
    'INFO:     Started server process [1]',
    'Traceback (most recent call last):',
    '  File "main.py", line 3, in <module>',
    '    import torch',
    "ModuleNotFoundError: No module named 'torch'",
    '',
  ].join('\n')
  const msg = describeStartupFailure({ port: 8765, exitCode: 1, stderr })
  assert.equal(msg, [
    'The Python backend stopped during startup (exit code 1):',
    '',
    'Traceback (most recent call last):',
    '  File "main.py", line 3, in <module>',
    '    import torch',
    "ModuleNotFoundError: No module named 'torch'",
  ].join('\n'))
})

test('no stderr and no exit code still gives a sentence', async () => {
  const { describeStartupFailure } = await load()
  assert.equal(describeStartupFailure({ port: 8765, exitCode: null, stderr: '' }), 'The Python backend stopped during startup.')
})

test('a spawn failure says the backend could not be launched', async () => {
  const { describeStartupFailure } = await load()
  const msg = describeStartupFailure({ port: 8765, exitCode: null, spawnError: 'spawn python.exe EACCES', stderr: '' })
  assert.match(msg, /^Could not launch the Python backend: spawn python\.exe EACCES/)
  assert.match(msg, /antivirus/) // shows the antivirus hint in the setup ErrorPanel
})

test('appendTail keeps only the end and relevantLines caps the count', async () => {
  const { appendTail, relevantLines } = await load()
  assert.equal(appendTail('abcdef', 'gh', 5), 'defgh')
  assert.equal(appendTail('ab', 'c', 5), 'abc')
  const many = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
  assert.deepEqual(relevantLines(many, 3), ['line 37', 'line 38', 'line 39'])
})

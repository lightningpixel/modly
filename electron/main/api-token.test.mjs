import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Loads the module against a throwaway home directory.
 *
 * The token file lives at `homedir()/.modly/api-token`, and these tests write
 * and delete it. Pointed at the real home they clobber the token of a Modly
 * that happens to be running: every local client of the API — the MCP server,
 * the CLI, the eval harness — reads that file, and they all start answering 401
 * until the app is restarted. Measured: one `npm run test:node` during a session
 * left the running app with no token file at all.
 *
 * `os.homedir()` reads USERPROFILE on Windows and HOME elsewhere, and it reads
 * them at call time, so setting both before the module is built is enough.
 */
function loadModule() {
  const home = mkdtempSync(join(tmpdir(), 'modly-token-home-'))
  process.env.USERPROFILE = home
  process.env.HOME = home
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-token-test-')), 'api-token.cjs')
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve('electron/main/api-token.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return require(outfile)
}

const REAL_HOME = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME }
test.after(() => {
  process.env.USERPROFILE = REAL_HOME.USERPROFILE
  process.env.HOME = REAL_HOME.HOME
})

test('the token is stable within a launch', () => {
  const mod = loadModule()
  assert.equal(mod.getApiToken(), mod.getApiToken())
})

test('a token is long and hex - guessable would defeat the point', () => {
  const token = loadModule().getApiToken()
  assert.match(token, /^[0-9a-f]{64}$/)
})

test('two launches do not share a token', () => {
  // Fresh module instance = fresh process, as far as the token is concerned.
  assert.notEqual(loadModule().getApiToken(), loadModule().getApiToken())
})

test('the token file holds exactly the token, and goes away on quit', () => {
  const mod = loadModule()
  const path = mod.apiTokenFilePath()
  assert.equal(path, join(homedir(), '.modly', 'api-token'))

  assert.equal(existsSync(path), false)

  mod.writeApiTokenFile()
  assert.equal(readFileSync(path, 'utf8'), mod.getApiToken())
  mod.removeApiTokenFile()
  assert.equal(existsSync(path), false)
})

test('removing a token file that is not there is not an error', () => {
  const mod = loadModule()
  mod.removeApiTokenFile()
  mod.removeApiTokenFile()
})

test('the header name is lowercase - Electron normalises what it injects', () => {
  assert.equal(loadModule().API_TOKEN_HEADER, 'x-modly-token')
})

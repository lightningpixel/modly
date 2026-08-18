import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Same bundling trick as vramFit.test.mjs — a pure helper, no React deps.
function loadModule() {
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-agentgrade-test-')), 'agentGrade.cjs')
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve('src/shared/components/ui/agentGrade.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return require(outfile)
}

const { agentGrade } = loadModule()

test('a model without a tier gets no badge at all', () => {
  assert.equal(agentGrade(undefined), null)
  assert.equal(agentGrade({}), null)
  assert.equal(agentGrade({ agent_tier: 'brilliant' }), null)   // unknown tier, not a badge
})

test('a measured model shows its own score', () => {
  const g = agentGrade({ agent_tier: 'excellent', agent_score: 0.98, agent_source: 'measured' })
  assert.equal(g.label, 'Agent: excellent (98%)')
  assert.match(g.title, /Modly's tool-calling suite/)
})

test('an unmeasured model never borrows the credibility of a measurement', () => {
  const g = agentGrade({ agent_tier: 'solid', agent_score: 0.9, agent_source: 'estimate' })
  assert.equal(g.label, 'Agent: solid')            // no percentage
  assert.match(g.title, /not measured in Modly/)
})

test('the note is carried into the tooltip', () => {
  const g = agentGrade({ agent_tier: 'limited', agent_source: 'estimate', agent_note: 'older generation' })
  assert.match(g.title, /older generation/)
  assert.equal(g.label, 'Agent: limited')
})

test('each tier gets its own colour', () => {
  const classes = ['excellent', 'solid', 'limited'].map((t) => agentGrade({ agent_tier: t }).className)
  assert.equal(new Set(classes).size, 3)
})

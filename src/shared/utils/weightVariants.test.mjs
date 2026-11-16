import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

function loadModule() {
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-weight-variants-test-')), 'weightVariants.cjs')
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve('src/shared/utils/weightVariants.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return require(outfile)
}

const { withWeightVariantAvailability, isMissingWeightVariant } = loadModule()

const variants = {
  param: 'gguf_quant',
  default: 'Q5_K_M',
  options: [{ id: 'Q4_K_M', label: 'Q4_K_M' }, { id: 'Q5_K_M', label: 'Q5_K_M' }],
}

const quantParam = {
  id: 'gguf_quant',
  label: 'Quantization',
  type: 'select',
  default: 'Q5_K_M',
  options: [
    { value: 'Q4_K_M', label: 'Q4_K_M' },
    { value: 'Q5_K_M', label: 'Q5_K_M' },
    { value: 'auto', label: 'Auto' },
  ],
}

test('labels declared variants that are not installed and keeps their values', () => {
  const marked = withWeightVariantAvailability(quantParam, variants, ['Q5_K_M'])
  assert.deepEqual(marked.options.map((option) => option.label), ['Q4_K_M (not installed)', 'Q5_K_M', 'Auto'])
  assert.deepEqual(marked.options.map((option) => option.value), ['Q4_K_M', 'Q5_K_M', 'auto'])
})

test('returns the param untouched when availability is unknown or the param selects nothing', () => {
  assert.equal(withWeightVariantAvailability(quantParam, variants, undefined), quantParam)
  assert.equal(withWeightVariantAvailability(quantParam, undefined, []), quantParam)
  const steps = { id: 'steps', label: 'Steps', type: 'int', default: 25 }
  assert.equal(withWeightVariantAvailability(steps, variants, []), steps)
})

test('flags a selected variant only when availability is known and it is not installed', () => {
  assert.equal(isMissingWeightVariant('gguf_quant', 'Q4_K_M', variants, ['Q5_K_M']), true)
  assert.equal(isMissingWeightVariant('gguf_quant', 'Q5_K_M', variants, ['Q5_K_M']), false)
  assert.equal(isMissingWeightVariant('gguf_quant', 'auto', variants, []), false)
  assert.equal(isMissingWeightVariant('steps', 'Q4_K_M', variants, []), false)
  assert.equal(isMissingWeightVariant('gguf_quant', 'Q4_K_M', variants, undefined), false)
  assert.equal(isMissingWeightVariant('gguf_quant', 'Q4_K_M', undefined, []), false)
})

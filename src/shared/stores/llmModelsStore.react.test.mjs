import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { setupDom, loadModule, mount } from '../../../scripts/react-test-env.mjs'

setupDom()
const React = createRequire(import.meta.url)('react')

/** A fresh module per test: the catalog store caches across calls by design, so
 *  a shared instance would make each test depend on the ones before it. */
const freshHook = () => loadModule('src/shared/stores/llmModelsStore.ts').useLlmModels

/** Counts every request the hook makes, and answers with a fixed catalog. */
function countingFetch() {
  const calls = []
  globalThis.fetch = (url) => {
    calls.push(String(url))
    return Promise.resolve({ json: () => Promise.resolve({ models: [{ id: 'qwen3-4b', downloaded: true }] }) })
  }
  return calls
}

test('the hook fetches the catalog once, however many times it renders', async () => {
  const useLlmModels = freshHook()
  const calls = countingFetch()
  const Probe = () => { useLlmModels(); return null }

  const view = await mount(React.createElement(Probe))
  await view.rerender()
  await view.rerender()
  await view.flush()

  assert.equal(calls.length, 1)
  await view.unmount()
})

test('refresh and the model list keep their identity across renders', async () => {
  // The regression: `refresh` was rebuilt on every render, so any caller
  // holding it in a dependency array re-ran its effect forever.
  const useLlmModels = freshHook()
  countingFetch()
  const seen = []
  const Probe = () => { seen.push(useLlmModels()); return null }

  const view = await mount(React.createElement(Probe))
  await view.flush()
  await view.rerender()

  const last = seen[seen.length - 1]
  const previous = seen[seen.length - 2]
  assert.equal(last.refresh, previous.refresh)
  assert.equal(last.models, previous.models)
  await view.unmount()
})

test('a consumer that refreshes from an effect settles instead of looping', async () => {
  // Exactly the shape of ModelLibraryModal: an effect keyed on `refresh` that
  // stores something in state. With an unstable `refresh` this rendered — and
  // fetched — without end; the modal flickered for as long as it was open.
  const useLlmModels = freshHook()
  const calls = countingFetch()
  let renders = 0

  const Modal = () => {
    const { refresh } = useLlmModels()
    const [, setStatus] = React.useState(null)
    renders++
    // Fails fast and says why: an unstable `refresh` makes this loop forever,
    // and a test that hangs for a minute before dying explains nothing.
    if (renders > 50) throw new Error('render loop — the effect keeps re-running')
    React.useEffect(() => { void refresh(); setStatus({ checkedAt: renders }) }, [refresh])
    return null
  }

  const view = await mount(React.createElement(Modal))
  await view.flush()
  await view.flush()

  assert.equal(calls.length, 2)  // the hook's own load, plus one forced refresh
  assert.ok(renders < 10, `expected a handful of renders, got ${renders}`)
  await view.unmount()
})

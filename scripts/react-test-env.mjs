/**
 * Minimal React test environment for `node --test`.
 *
 * The repo tests everything except the UI layer, which is exactly where the
 * bugs the user actually sees have come from: a hook returning a fresh callback
 * on every render made a modal re-run its effect forever, flickering and
 * hammering the API. That class of bug is invisible to a type-checker and to
 * store-level tests — it only exists once a component renders more than once.
 *
 * Deliberately built on jsdom + react-dom directly rather than a testing
 * library: what we need is "render, re-render, count the effects", not queries
 * and user events.
 */
import { JSDOM } from 'jsdom'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Install a DOM into the globals React expects. Call once, at module scope. */
export function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  const { window } = dom

  // Node 24 defines some of these (`navigator`) as getter-only on globalThis,
  // so a plain assignment throws — go through defineProperty for all of them.
  const define = (name, value) =>
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })

  define('window', window)
  define('document', window.document)
  define('navigator', window.navigator)
  define('localStorage', window.localStorage)
  define('requestAnimationFrame', (cb) => setTimeout(() => cb(Date.now()), 0))
  define('cancelAnimationFrame', (id) => clearTimeout(id))
  // React 18 refuses to run `act` without it, and warns on every update.
  define('IS_REACT_ACT_ENVIRONMENT', true)
  for (const name of ['HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'getComputedStyle']) {
    define(name, window[name])
  }
  return dom
}

/**
 * Bundle a source module and load it as CommonJS.
 *
 * `react` and `react-dom` stay external so the module under test and the test
 * file share one React instance — two copies produce "invalid hook call",
 * which reads as a bug in the code under test and is not one.
 */
export function loadModule(entryPath) {
  // Inside the project, not the system temp dir: the bundle keeps `react` as a
  // bare require, and that only resolves from a path under this node_modules.
  const cacheRoot = resolve('node_modules/.cache/modly-react-tests')
  mkdirSync(cacheRoot, { recursive: true })
  const outfile = join(mkdtempSync(join(cacheRoot, 'm-')), 'module.cjs')
  const result = buildSync({
    entryPoints: [resolve(entryPath)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    // The path aliases from tsconfig.web.json — esbuild applies them to
    // sub-paths too, so `@shared/stores/x` resolves like it does in the app.
    alias: {
      '@':       resolve('src'),
      '@shared': resolve('src/shared'),
      '@areas':  resolve('src/areas'),
      '@main':   resolve('electron/main'),
    },
    write: false,
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return createRequire(import.meta.url)(outfile)
}

/**
 * Render `element`, and hand back a way to re-render it with the same root —
 * which is the whole point: a hook that misbehaves does so on the SECOND render.
 */
export async function mount(element) {
  const require = createRequire(import.meta.url)
  const { createRoot } = require('react-dom/client')
  const React = require('react')
  const { cloneElement } = React
  // React 18.3 moved `act` onto the React export and deprecated the test-utils
  // one, which warns on every call.
  const act = React.act ?? require('react-dom/test-utils').act

  // Through globalThis: these are globals this module installed itself in
  // setupDom(), not ambient browser ones.
  const container = globalThis.document.createElement('div')
  globalThis.document.body.appendChild(container)
  const root = createRoot(container)

  await act(async () => { root.render(element) })

  return {
    container,
    /** Re-render. The element is cloned by default: handed the very same
     *  element object, React bails out and nothing re-renders — which silently
     *  turns a re-render test into a no-op. */
    rerender: async (next) => {
      await act(async () => { root.render(next ?? cloneElement(element)) })
    },
    /** Let effects, promises and state updates settle. */
    flush: async () => { await act(async () => { await Promise.resolve() }) },
    /** Run something that updates React state — a click, a keypress, a store
     *  write — and settle. Outside act(), React warns and the assertions run
     *  against a tree that has not re-rendered yet. */
    act: async (fn) => { await act(async () => { await fn() }) },
    unmount: async () => {
      await act(async () => { root.unmount() })
      container.remove()
    },
  }
}

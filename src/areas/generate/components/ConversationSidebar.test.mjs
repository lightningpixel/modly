import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { setupDom, loadModule, mount } from '../../../../scripts/react-test-env.mjs'

setupDom()
const React = createRequire(import.meta.url)('react')

// One module instance for the whole file: the sidebar and the chat store it
// drives have to be the same copy, and remounting is enough to isolate tests.
const { default: ConversationSidebar, __chat } = loadModule('src/areas/generate/components/ConversationSidebar.test-entry.ts')

const noop = () => {}
const openSidebar = (props = {}) =>
  mount(React.createElement(ConversationSidebar, { open: true, onClose: noop, onLeave: noop, ...props }))

/** Reset to a single blank conversation between tests. */
function resetChat() {
  const s = __chat.getState()
  for (const c of [...s.conversations]) __chat.getState().deleteConversation(c.id)
  __chat.getState().clear()
}

const rows = (container) => [...container.querySelectorAll('aside .group')]
const titleOf = (row) => row.querySelector('button').textContent
const click = (view, el) => view.act(() => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))

test('it lists every conversation, marking the open one', async () => {
  resetChat()
  __chat.getState().setMessages([{ id: 'u1', role: 'user', content: 'thread A' }])
  __chat.getState().newConversation()
  __chat.getState().setMessages([{ id: 'u2', role: 'user', content: 'thread B' }])

  const view = await openSidebar()
  const listed = rows(view.container).map(titleOf)

  assert.deepEqual(listed, ['thread B', 'thread A'])   // newest first
  await view.unmount()
})

test('an unnamed conversation is listed under a placeholder, not a blank row', async () => {
  resetChat()
  const view = await openSidebar()

  assert.deepEqual(rows(view.container).map(titleOf), ['New conversation'])
  await view.unmount()
})

test('clicking a row opens that conversation and closes the drawer', async () => {
  resetChat()
  __chat.getState().setMessages([{ id: 'u1', role: 'user', content: 'thread A' }])
  const first = __chat.getState().activeId
  __chat.getState().newConversation()
  __chat.getState().setMessages([{ id: 'u2', role: 'user', content: 'thread B' }])

  let closed = 0
  let left = 0
  const view = await openSidebar({ onClose: () => closed++, onLeave: () => left++ })
  await view.flush()

  const rowA = rows(view.container).find((r) => titleOf(r) === 'thread A')
  await click(view, rowA.querySelector('button'))

  assert.equal(__chat.getState().activeId, first)
  assert.equal(__chat.getState().messages[0].content, 'thread A')
  assert.equal(closed, 1)
  assert.equal(left, 1)
  await view.unmount()
})

test('renaming a row writes the name and stops editing', async () => {
  resetChat()
  __chat.getState().setMessages([{ id: 'u1', role: 'user', content: 'auto title' }])

  const view = await openSidebar()
  const [row] = rows(view.container)
  await click(view, row.querySelector('button[title="Rename"]'))

  const input = view.container.querySelector('aside input')
  assert.ok(input, 'the row should turn into a text field')

  await view.act(() => {
    setInputValue(input, 'Low-poly duck')
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })

  assert.equal(__chat.getState().conversations[0].title, 'Low-poly duck')
  assert.equal(view.container.querySelector('aside input'), null)
  await view.unmount()
})

test('a rename survives the click that dismisses the drawer', async () => {
  // mousedown runs before the browser moves focus, so closing on it unmounts the
  // field before its onBlur can commit — the typed name used to vanish.
  resetChat()
  __chat.getState().setMessages([{ id: 'u1', role: 'user', content: 'auto title' }])

  let closed = 0
  const view = await openSidebar({ onClose: () => closed++ })
  await click(view, rows(view.container)[0].querySelector('button[title="Rename"]'))

  const input = view.container.querySelector('aside input')
  await view.act(() => { setInputValue(input, 'Low-poly duck') })
  await view.act(() => {
    view.container.querySelector('div.z-40')
      .dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }))
  })

  assert.equal(__chat.getState().conversations[0].title, 'Low-poly duck')
  assert.equal(closed, 1)
  await view.unmount()
})

test('Escape discards an edit in progress, and closes the drawer otherwise', async () => {
  resetChat()
  __chat.getState().setMessages([{ id: 'u1', role: 'user', content: 'auto title' }])

  let closed = 0
  const view = await openSidebar({ onClose: () => closed++ })
  const escape = () => view.act(() => {
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })

  await click(view, rows(view.container)[0].querySelector('button[title="Rename"]'))
  await view.act(() => { setInputValue(view.container.querySelector('aside input'), 'discarded') })
  await escape()
  assert.equal(__chat.getState().conversations[0].title, 'auto title')
  assert.equal(view.container.querySelector('aside input'), null)
  assert.equal(closed, 0, 'the first Escape only left the edit')

  await escape()
  assert.equal(closed, 1)
  await view.unmount()
})

test('deleting the open conversation keeps the drawer on a usable one', async () => {
  resetChat()
  __chat.getState().setMessages([{ id: 'u1', role: 'user', content: 'to delete' }])

  const view = await openSidebar()
  await click(view, rows(view.container)[0].querySelector('button[title="Delete"]'))

  // Never left without a conversation, and the drawer still renders one row.
  assert.equal(__chat.getState().conversations.length, 1)
  assert.deepEqual(__chat.getState().messages, [])
  assert.equal(rows(view.container).length, 1)
  await view.unmount()
})

test('closed, it renders nothing at all', async () => {
  resetChat()
  const view = await mount(React.createElement(ConversationSidebar, { open: false, onClose: noop, onLeave: noop }))

  assert.equal(view.container.querySelector('aside'), null)
  await view.unmount()
})

// ─── helpers ─────────────────────────────────────────────────────────────────

/** React tracks input state through its own value setter — assigning `.value`
 *  directly updates the DOM without ever telling React. */
function setInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, value)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
}

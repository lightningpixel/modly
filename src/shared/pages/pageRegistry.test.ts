import test from 'node:test'
import assert from 'node:assert/strict'
import { PAGES, PAGE_GROUPS, PAGE_IDS, getPage, isPage, pagesByGroup, type PageDefinition } from './pageRegistry'
import { useNavStore } from '../stores/navStore'

const page = (id: string, group: PageDefinition['group']): PageDefinition => ({
  id, label: id, group, icon: [], load: async () => ({ default: () => null }), wrapperClass: '',
})

test('page ids are unique and every page has a known group, a label and an icon', () => {
  assert.equal(new Set(PAGE_IDS).size, PAGES.length)
  for (const p of PAGES) {
    assert.ok(PAGE_GROUPS.includes(p.group), p.id)
    assert.ok(p.label, p.id)
    assert.ok(p.icon.length > 0, p.id)
    assert.equal(typeof p.load, 'function', p.id)
  }
})

test('the pages keep their ids, labels and sidebar order', () => {
  assert.deepEqual(
    pagesByGroup().map((s) => [s.group, s.pages.map((p) => `${p.id}:${p.label}`)]),
    [
      ['create', ['generate:Generate', 'workflows:Workflows']],
      ['manage', ['library:Library']],
      ['system', ['models:Extensions', 'settings:Settings']],
    ],
  )
})

test('pagesByGroup follows PAGE_GROUPS order, keeps registry order inside a group, and skips empty groups', () => {
  const sections = pagesByGroup([page('b', 'system'), page('a', 'create'), page('h', 'home'), page('c', 'create')])
  assert.deepEqual(sections.map((s) => [s.group, s.pages.map((p) => p.id)]), [
    ['home', ['h']],
    ['create', ['a', 'c']],
    ['system', ['b']],
  ])
})

test('isPage and getPage', () => {
  assert.ok(isPage('models'))
  assert.ok(!isPage('nope'))
  assert.ok(!isPage(undefined))
  assert.equal(getPage('models').label, 'Extensions')
})

test('navigate sets the page and its params, and a plain navigate clears stale params', () => {
  const nav = useNavStore.getState()
  nav.navigate('workflows', { run: 'r1' })
  assert.equal(useNavStore.getState().currentPage, 'workflows')
  assert.deepEqual(useNavStore.getState().params, { run: 'r1' })
  nav.navigate('settings')
  assert.equal(useNavStore.getState().params, null)
})

test('openExtension is navigate to the Extensions page on that extension', () => {
  useNavStore.getState().openExtension('hunyuan')
  assert.equal(useNavStore.getState().currentPage, 'models')
  assert.deepEqual(useNavStore.getState().params, { extension: 'hunyuan' })
  useNavStore.getState().clearParams()
  assert.equal(useNavStore.getState().params, null)
})

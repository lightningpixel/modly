import type { ComponentType } from 'react'

// The app's pages, in one place. The sidebar, the page switch, the navigation
// store and the agent all read this list: adding a page is one entry here.
//
// Plain data on purpose (no JSX, components loaded on demand), so the stores
// and the agent's tools can import it, and so can the node tests.

export type PageGroup = 'home' | 'create' | 'manage' | 'system'

/** Sidebar order; a group with no page is skipped. */
export const PAGE_GROUPS: readonly PageGroup[] = ['home', 'create', 'manage', 'system']

/** One child of a 24×24 stroked SVG icon, as [tag, attributes]. */
export type IconShape = readonly [
  tag: 'path' | 'rect' | 'circle' | 'line' | 'polyline' | 'polygon',
  attrs: Readonly<Record<string, string | number>>,
]

export interface PageDefinition {
  id: string
  /** Sidebar label and tooltip. */
  label: string
  group: PageGroup
  icon: readonly IconShape[]
  /** The page component, loaded the first time the page opens. */
  load: () => Promise<{ default: ComponentType }>
  /** Classes of the element the page renders into. */
  wrapperClass: string
}

export const PAGES = [
  {
    id: 'generate',
    label: 'Generate',
    group: 'create',
    icon: [['path', { d: 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5' }]],
    load: () => import('@areas/generate/GeneratePage'),
    wrapperClass: 'flex flex-1 overflow-hidden',
  },
  {
    id: 'workflows',
    label: 'Workflows',
    group: 'create',
    icon: [
      ['rect', { x: 3, y: 3, width: 6, height: 5, rx: 1 }],
      ['rect', { x: 3, y: 11, width: 6, height: 5, rx: 1 }],
      ['rect', { x: 3, y: 19, width: 6, height: 2, rx: 1 }],
      ['path', { d: 'M9 5.5h3.5a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9' }],
      ['rect', { x: 13.5, y: 3, width: 7.5, height: 16, rx: 1 }],
    ],
    load: () => import('@areas/workflows/WorkflowsPage'),
    wrapperClass: 'flex flex-1 overflow-hidden',
  },
  {
    id: 'models',
    label: 'Extensions',
    group: 'system',
    icon: [
      ['path', { d: 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z' }],
      ['polyline', { points: '3.27 6.96 12 12.01 20.73 6.96' }],
      ['line', { x1: 12, y1: 22.08, x2: 12, y2: 12 }],
    ],
    load: () => import('@areas/models/ModelsPage'),
    wrapperClass: 'flex-1 overflow-y-auto',
  },
  {
    id: 'settings',
    label: 'Settings',
    group: 'system',
    icon: [
      ['circle', { cx: 12, cy: 12, r: 3 }],
      ['path', { d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' }],
    ],
    load: () => import('@areas/settings/SettingsPage'),
    wrapperClass: 'flex-1 overflow-hidden',
  },
] as const satisfies readonly PageDefinition[]

export type Page = (typeof PAGES)[number]['id']

export const PAGE_IDS: readonly Page[] = PAGES.map((p) => p.id)

export function isPage(value: unknown): value is Page {
  return typeof value === 'string' && (PAGE_IDS as readonly string[]).includes(value)
}

export function getPage(id: Page): PageDefinition {
  // Every Page id comes from PAGES, so the lookup always finds one.
  return PAGES.find((p) => p.id === id) as PageDefinition
}

/** The sidebar's sections: each group that has pages, in PAGE_GROUPS order. */
export function pagesByGroup(
  pages: readonly PageDefinition[] = PAGES,
): { group: PageGroup; pages: PageDefinition[] }[] {
  return PAGE_GROUPS
    .map((group) => ({ group, pages: pages.filter((p) => p.group === group) }))
    .filter((section) => section.pages.length > 0)
}

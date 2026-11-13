import { createElement, Fragment } from 'react'
import { useNavStore } from '@shared/stores/navStore'
import { pagesByGroup, type IconShape, type Page } from '@shared/pages/pageRegistry'

const SECTIONS = pagesByGroup()

function PageIcon({ shapes }: { shapes: readonly IconShape[] }): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      {shapes.map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }))}
    </svg>
  )
}

export default function Sidebar(): JSX.Element {
  const currentPage = useNavStore((s) => s.currentPage)
  const navigate    = useNavStore((s) => s.navigate)

  return (
    <aside className="flex flex-col w-14 bg-surface-500 border-r border-zinc-800 py-2">
      {SECTIONS.map((section, i) => (
        <Fragment key={section.group}>
          {i > 0 && <div role="separator" className="mx-3 my-1.5 h-px bg-zinc-800" />}
          {section.pages.map((page) => {
            const active = currentPage === page.id
            return (
              <button
                key={page.id}
                title={page.label}
                aria-current={active ? 'page' : undefined}
                onClick={() => navigate(page.id as Page)}
                className={`
                  relative flex flex-col items-center justify-center gap-1 h-12 mx-1 my-0.5 rounded
                  transition-colors text-[9px] leading-none
                  ${active
                    ? 'bg-accent/20 text-accent-light'
                    : 'text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800'}
                `}
              >
                <PageIcon shapes={page.icon} />
                {page.label}
              </button>
            )
          })}
        </Fragment>
      ))}
    </aside>
  )
}

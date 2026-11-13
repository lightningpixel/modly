import { Suspense, lazy, type ComponentType, type LazyExoticComponent } from 'react'
import { useNavStore } from '@shared/stores/navStore'
import { PAGES, getPage, type Page, type PageDefinition } from '@shared/pages/pageRegistry'

// One lazy component per registered page, made once.
const COMPONENTS = {} as Record<Page, LazyExoticComponent<ComponentType>>
for (const page of PAGES as readonly PageDefinition[]) COMPONENTS[page.id as Page] = lazy(page.load)

export default function Router(): JSX.Element {
  const currentPage = useNavStore((s) => s.currentPage)
  const PageComponent = COMPONENTS[currentPage]

  return (
    <Suspense fallback={null}>
      <div className={getPage(currentPage).wrapperClass}>
        <PageComponent />
      </div>
    </Suspense>
  )
}

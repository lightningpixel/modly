import TopBar from './TopBar'
import Sidebar from './Sidebar'
import Router from '@shared/router/Router'

export default function MainLayout(): JSX.Element {

  return (
    <div className="flex flex-col h-full bg-surface-500">
      <TopBar />

      <div className="flex flex-1 overflow-hidden">
        <Sidebar />

        <main className="flex flex-1 overflow-hidden">
          <Router />
        </main>
      </div>
    </div>
  )
}

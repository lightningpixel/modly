import TopBar from './TopBar'
import Sidebar from './Sidebar'
import Router from '@shared/router/Router'
import AgentPanel from '@shared/components/agent/AgentPanel'

export default function MainLayout(): JSX.Element {

  return (
    <div className="flex flex-col h-full bg-surface-500">
      <TopBar />

      <div className="flex flex-1 overflow-hidden">
        <Sidebar />

        <main className="flex flex-1 min-w-0 overflow-hidden">
          <Router />
        </main>

        <AgentPanel />
      </div>
    </div>
  )
}

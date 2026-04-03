import { useNavStore, type Page } from '@shared/stores/navStore'

const NAV_ITEMS: { id: Page; label: string; icon: JSX.Element }[] = [
  {
    id: 'generate',
    label: 'Generate',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
      </svg>
    )
  },
  {
    id: 'workflows',
    label: 'Workflows',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="3" width="6" height="5" rx="1" />
        <rect x="3" y="11" width="6" height="5" rx="1" />
        <rect x="3" y="19" width="6" height="2" rx="1" />
        <path d="M9 5.5h3.5a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9" />
        <rect x="13.5" y="3" width="7.5" height="16" rx="1" />
      </svg>
    )
  },
  {
    id: 'models',
    label: 'Extensions',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
        <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
        <line x1="12" y1="22.08" x2="12" y2="12" />
      </svg>
    )
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    )
  }
]

export default function Sidebar(): JSX.Element {
  const { currentPage, navigate } = useNavStore()

  return (
    <aside className="flex flex-col w-14 bg-surface-500 border-r border-zinc-800 py-2">
      {NAV_ITEMS.map((item) => {
        const active = currentPage === item.id
        return (
          <button
            key={item.id}
            title={item.label}
            onClick={() => navigate(item.id)}
            className={`
              relative flex flex-col items-center justify-center gap-1 h-12 mx-1 my-0.5 rounded
              transition-colors text-[9px] leading-none
              ${active
                ? 'bg-accent/20 text-accent-light'
                : 'text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800'}
            `}
          >
            {item.icon}
            {item.label}
          </button>
        )
      })}
    </aside>
  )
}

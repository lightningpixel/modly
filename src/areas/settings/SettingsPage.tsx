import { useTranslation } from 'react-i18next'
import { useState } from 'react'
import { StorageSection }      from './components/StorageSection'
import { AboutSection }        from './components/AboutSection'
import { LogsSection }         from './components/LogsSection'
import { IntegrationsSection } from './components/IntegrationsSection'
import { LanguageSection }     from './components/LanguageSection'

type Section = 'storage' | 'integrations' | 'logs' | 'about' | 'language'

function useSettingsSections() {
  const { t } = useTranslation()
  return [
  {
    id: 'storage' as const,
    label: t('settings.storage'),
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <ellipse cx="12" cy="5" rx="9" ry="3" />
        <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
        <line x1="3" y1="12" x2="21" y2="12" />
      </svg>
    )
  },
  {
    id: 'integrations' as const,
    label: t('settings.integrations'),
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="2" y="7" width="20" height="14" rx="2" ry="2"/>
        <path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"/>
      </svg>
    )
  },
  {
    id: 'logs' as const,
    label: t('settings.logs'),
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
        <polyline points="10 9 9 9 8 9" />
      </svg>
    )
  },
  {
    id: 'about' as const,
    label: t('settings.about'),
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
    )
  },
  {
    id: 'language' as const,
    label: t('settings.language'),
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M5 8l-2 9m16-9l2 9M9.135 4h5.73a2 2 0 011.976 2.184l-.6 3.616m0 0a2 2 0 01-1.973 1.6H6.667a2 2 0 01-1.973-1.6m12 0H6.667m1.5 5a1 1 0 100 2m6 0a1 1 0 100 2" />
      </svg>
    )
  }
  ] as const
}

// ─── Page shell ───────────────────────────────────────────────────────────────

export default function SettingsPage(): JSX.Element {
  const { t } = useTranslation()
  const SECTIONS = useSettingsSections()
  const [section, setSection] = useState<Section>('storage')

  return (
    <div className="flex h-full">

      {/* Left nav */}
      <nav className="w-52 shrink-0 border-r border-zinc-800 bg-surface-400 py-5 px-3 flex flex-col gap-0.5">
        <p className="text-[10px] font-semibold text-zinc-600 uppercase tracking-wider px-3 mb-3">{t('settings.title')}</p>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            onClick={() => setSection(s.id)}
            className={`
              flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-[13px] text-left transition-colors
              ${section === s.id
                ? 'bg-accent/15 text-accent-light'
                : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60'}
            `}
          >
            <span className={section === s.id ? 'text-accent-light' : 'text-zinc-600'}>{s.icon}</span>
            {s.label}
          </button>
        ))}
      </nav>

      {/* Content */}
      <div className="flex-1 overflow-y-auto bg-surface-400">
        <div className="p-8">
          {section === 'storage'      && <StorageSection />}
          {section === 'integrations' && <IntegrationsSection />}
          {section === 'logs'         && <LogsSection />}
          {section === 'about'        && <AboutSection />}
          {section === 'language'     && <LanguageSection />}
        </div>
      </div>

    </div>
  )
}

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Section, Card, Row, Select } from '@shared/ui'

export function LanguageSection(): JSX.Element {
  const { t, i18n } = useTranslation()
  const [language, setLanguage] = useState<'en' | 'es'>(i18n.language as 'en' | 'es')
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')

  useEffect(() => {
    window.electron.settings.get().then((s) => {
      setLanguage(s.language || 'en')
    })
  }, [])

  async function handleLanguageChange(newLanguage: string) {
    const lang = newLanguage as 'en' | 'es'
    setLanguage(lang)
    setStatus('saving')
    try {
      await i18n.changeLanguage(lang)
      await window.electron.settings.set({ language: lang })
      setStatus('saved')
      setTimeout(() => setStatus('idle'), 2500)
    } catch {
      setStatus('error')
      setTimeout(() => setStatus('idle'), 3000)
    }
  }

  return (
    <Section title={t('language.title')} subtitle={t('language.subtitle')}>
      <div className="grid grid-cols-2 gap-4">
        <Card>
          <Row label={t('language.label')}>
            <Select
              value={language}
              onChange={handleLanguageChange}
              options={[
                { value: 'en', label: t('language.english') },
                { value: 'es', label: t('language.spanish') },
              ]}
            />
          </Row>
          {status === 'saved' && (
            <div className="px-4 py-2 text-[11px] text-emerald-400">
              ✓ {t('integrations.saved')}
            </div>
          )}
          {status === 'error' && (
            <div className="px-4 py-2 text-[11px] text-red-400">
              ✗ {t('storage.somethingWentWrong')}
            </div>
          )}
        </Card>
      </div>
    </Section>
  )
}

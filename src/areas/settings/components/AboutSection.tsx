import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Section, Card, Row, LinkButton } from '@shared/ui'

export function AboutSection(): JSX.Element {
  const { t } = useTranslation()
  const [version, setVersion] = useState<string>('')

  useEffect(() => {
    window.electron.app.info().then(({ version }) => setVersion(version))
  }, [])

  return (
    <Section title={t('about.title')} subtitle={t('about.subtitle')}>
      <div className="grid grid-cols-2 gap-4">

        <Card>
          <Row label={t('about.modly')} description={t('about.modlyDescription')}>
            <span className="text-xs font-mono text-zinc-400">{version ? `v${version}` : '—'}</span>
          </Row>
          <Row label={t('about.documentation')} description={t('about.documentationDescription')}>
            <LinkButton label={t('about.docLink')} href="https://modly3d.app" />
          </Row>
          <Row label={t('about.github')} description={t('about.githubDescription')}>
            <LinkButton label={t('about.githubLink')} href="https://github.com/lightningpixel/modly" />
          </Row>
        </Card>

        <Card>
          <Row label={t('about.discord')} description={t('about.discordDescription')}>
            <LinkButton label={t('about.discordLink')} href="https://discord.gg/FjzjRgweVk" />
          </Row>
          <Row label={t('about.licenses')} description={t('about.licensesDescription')}>
            <LinkButton label={t('about.licensesLink')} href="https://github.com/lightningpixel/modly/blob/main/LICENSE" />
          </Row>
        </Card>

      </div>
    </Section>
  )
}

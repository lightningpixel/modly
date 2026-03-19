import { useEffect, useState } from 'react'
import { Section, Card, Row, LinkButton } from '@shared/ui'

export function AboutSection(): JSX.Element {
  const [version, setVersion] = useState<string>('')

  useEffect(() => {
    window.electron.app.info().then(({ version }) => setVersion(version))
  }, [])

  return (
    <Section title="About" subtitle="Application information and useful resources.">
      <div className="grid grid-cols-2 gap-4">

        <Card>
          <Row label="Modly" description="Local 3D mesh generation app.">
            <span className="text-xs font-mono text-zinc-400">{version ? `v${version}` : '—'}</span>
          </Row>
          <Row label="Documentation" description="Guides and API reference.">
            <LinkButton label="Open" href="https://modly3d.app" />
          </Row>
          <Row label="GitHub" description="Source code and issues.">
            <LinkButton label="Open" href="https://github.com/lightningpixel/modly" />
          </Row>
        </Card>

        <Card>
          <Row label="Discord" description="Community support.">
            <LinkButton label="Join" href="https://discord.gg/FjzjRgweVk" />
          </Row>
          <Row label="Open-source licenses" description="Third-party licenses used in this app.">
            <LinkButton label="View" href="https://github.com/lightningpixel/modly/blob/main/LICENSE" />
          </Row>
        </Card>

      </div>
    </Section>
  )
}

import { useAppStore } from '@shared/stores/appStore'
import { Section, Card, Row, Toggle } from '@shared/ui'

export function ApplicationSection(): JSX.Element {
  const { showRamIndicator, setShowRamIndicator, showVramIndicator, setShowVramIndicator } = useAppStore()

  return (
    <Section title="Application" subtitle="General application settings.">
      <Card title="Interface">
        <Row
          label="RAM indicator"
          description="Show live memory usage in the top bar."
        >
          <Toggle value={showRamIndicator} onChange={setShowRamIndicator} />
        </Row>
        <Row
          label="VRAM indicator"
          description="Show live GPU memory usage in the top bar (NVIDIA only)."
        >
          <Toggle value={showVramIndicator} onChange={setShowVramIndicator} />
        </Row>
      </Card>
    </Section>
  )
}

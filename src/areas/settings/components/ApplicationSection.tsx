import { useState } from 'react'
import { useAppStore } from '@shared/stores/appStore'
import { readStartPage, writeStartPage, type StartPage } from '@shared/pages/startPage'
import { Section, Card, Row, Toggle, SegmentedControl } from '@shared/ui'

const START_PAGE_OPTIONS: { value: StartPage; label: string }[] = [
  { value: 'home', label: 'Home' },
  { value: 'generate', label: 'Generate' },
]

export function ApplicationSection(): JSX.Element {
  const { showRamIndicator, setShowRamIndicator, showVramIndicator, setShowVramIndicator } = useAppStore()
  const [startPage, setStartPage] = useState<StartPage>(readStartPage)

  function changeStartPage(page: StartPage) {
    setStartPage(page)
    writeStartPage(page)
  }

  return (
    <Section title="Application" subtitle="General application settings.">
      <Card title="Interface">
        <Row
          label="Start page"
          description="The page Modly opens on."
        >
          <SegmentedControl value={startPage} onChange={changeStartPage} options={START_PAGE_OPTIONS} ariaLabel="Start page" />
        </Row>
        <Row
          label="RAM indicator"
          description="Show live memory usage in the top bar."
        >
          <Toggle value={showRamIndicator} onChange={setShowRamIndicator} />
        </Row>
        <Row
          label="VRAM indicator"
          description="Show live GPU memory usage in the top bar. NVIDIA only; counts every app using the GPU."
        >
          <Toggle value={showVramIndicator} onChange={setShowVramIndicator} />
        </Row>
      </Card>
    </Section>
  )
}

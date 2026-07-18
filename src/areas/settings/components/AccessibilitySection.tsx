import { useAppStore } from '@shared/stores/appStore'
import { Section, Card, Row, Toggle, SegmentedControl } from '@shared/ui'

export function AccessibilitySection(): JSX.Element {
  const { useAtkinsonFont, setUseAtkinsonFont, uiScale, setUiScale } = useAppStore()

  return (
    <Section title="Accessibility" subtitle="Make Modly easier to read and use.">
      <div className="grid grid-cols-2 gap-4">

        <Card title="Display Font" description="Use a more legible typeface, helpful for dyslexia and low vision.">
          <Row
            label="Atkinson Hyperlegible"
            description="Replace the default font with a typeface designed for readability."
          >
            <Toggle value={useAtkinsonFont} onChange={setUseAtkinsonFont} />
          </Row>
        </Card>

        <Card title="Interface Scale" description="Zoom the whole interface up or down.">
          <Row
            label="Scale"
            description="Applies to all text, icons, and spacing."
          >
            <SegmentedControl
              ariaLabel="Interface scale"
              value={uiScale}
              onChange={setUiScale}
              options={[
                { value: 'small',      label: 'Small'      },
                { value: 'medium',     label: 'Medium'     },
                { value: 'large',      label: 'Large'      },
                { value: 'very-large', label: 'Very Large' },
              ]}
            />
          </Row>
        </Card>

      </div>
    </Section>
  )
}

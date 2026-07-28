import { useAppStore, UI_ZOOM_PRESETS } from '@shared/stores/appStore'
import { Section, Card, Row, Toggle } from '@shared/ui'

export function AccessibilitySection(): JSX.Element {
  const { useAtkinsonFont, setUseAtkinsonFont, uiZoomFactor, setUiZoomFactor } = useAppStore()

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
            label={`Scale — ${Math.round(uiZoomFactor * 100)}%`}
            description="Applies to all text, icons and spacing, and is kept when you restart. Ctrl or Cmd with + and - changes it too, in smaller steps; Ctrl or Cmd with 0 returns to 100%."
          >
            {/* Buttons rather than a four-way switch: the keyboard shortcut can
                land between the presets, and a switch would have to lie about
                which one is selected. The percentage above always tells the
                truth. */}
            <div className="flex gap-1" role="group" aria-label="Interface scale">
              {UI_ZOOM_PRESETS.map(({ label, factor }) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => setUiZoomFactor(factor)}
                  aria-pressed={Math.abs(uiZoomFactor - factor) < 0.005}
                  className={
                    'px-2 py-1 text-xs rounded border transition-colors ' +
                    (Math.abs(uiZoomFactor - factor) < 0.005
                      ? 'border-violet-500 text-violet-300 bg-violet-500/10'
                      : 'border-neutral-700 text-neutral-400 hover:text-neutral-200')
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          </Row>
        </Card>

      </div>
    </Section>
  )
}

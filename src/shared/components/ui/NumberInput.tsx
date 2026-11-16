import { useRef, useState } from 'react'

/**
 * Text-based numeric inputs for extension params. They keep the raw text the
 * user is typing (so "-", "0." or "1," don't get swallowed) and only emit once
 * it parses. External value changes (e.g. reset) re-sync the text.
 */

export function IntInput({ value, onChange, className }: { value: number; onChange: (v: number) => void; className: string }) {
  const [text, setText] = useState(String(value))
  const prevValue = useRef(value)
  if (prevValue.current !== value && parseInt(text, 10) !== value) {
    prevValue.current = value
    setText(String(value))
  }
  return (
    <input
      type="text"
      inputMode="numeric"
      value={text}
      onChange={(e) => {
        const raw = e.target.value
        if (raw !== '' && raw !== '-' && !/^-?\d+$/.test(raw)) return
        setText(raw)
        const n = parseInt(raw, 10)
        if (!isNaN(n)) { prevValue.current = n; onChange(n) }
      }}
      className={className}
    />
  )
}

/**
 * Float input. When the param declares both `min` and `max`, a range slider is
 * shown next to the text field; typed values are clamped to those bounds.
 */
export function FloatInput({ value, onChange, className, min, max, step, label }: {
  value:     number
  onChange:  (v: number) => void
  className: string
  min?:      number
  max?:      number
  step?:     number
  label:     string
}) {
  const [text, setText] = useState(String(value))
  const prevValue = useRef(value)
  if (prevValue.current !== value && parseFloat(text.replace(',', '.')) !== value) {
    prevValue.current = value
    setText(String(value))
  }

  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n))
  const emit = (n: number) => {
    const clamped = clamp(n)
    prevValue.current = clamped
    onChange(clamped)
  }

  const textInput = (
    <input
      type="text"
      inputMode="decimal"
      value={text}
      onChange={(e) => {
        const raw = e.target.value.replace(',', '.')
        if (raw !== '' && raw !== '-' && raw !== '.' && !/^-?\d*\.?\d*$/.test(raw)) return
        setText(e.target.value)
        const num = parseFloat(raw)
        if (!isNaN(num)) emit(num)
      }}
      // Show the clamped value once the user is done typing an out-of-range one.
      onBlur={() => { if (parseFloat(text.replace(',', '.')) !== value) setText(String(value)) }}
      className={className}
    />
  )

  if (min === undefined || max === undefined || max <= min) return textInput

  return (
    <div className="flex items-center gap-1.5 w-full">
      <input
        type="range"
        min={min}
        max={max}
        step={step && step > 0 ? step : (max - min) / 100}
        value={Number.isFinite(value) ? clamp(value) : min}
        onChange={(e) => {
          const num = e.currentTarget.valueAsNumber
          if (Number.isFinite(num)) { setText(String(num)); emit(num) }
        }}
        aria-label={label}
        // nodrag: inside a React Flow node, dragging the thumb would move the node.
        className="nodrag min-w-0 flex-1 accent-accent cursor-pointer"
      />
      <div className="w-16 shrink-0">{textInput}</div>
    </div>
  )
}

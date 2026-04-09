import { useRef } from 'react'

interface ColorPickerProps {
  value: string
  onChange: (color: string) => void
  size?: 'sm' | 'md'
}

export function ColorPicker({ value, onChange, size = 'sm' }: ColorPickerProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)

  const dim = size === 'sm' ? 'w-5 h-5' : 'w-6 h-6'

  return (
    <button
      type="button"
      onClick={() => inputRef.current?.click()}
      className={`${dim} rounded border border-zinc-600 hover:border-zinc-400 transition-colors shrink-0 relative overflow-hidden`}
      style={{ backgroundColor: value }}
      title={value}
    >
      {/* Checkerboard behind transparent colors */}
      <span
        className="absolute inset-0 -z-10"
        style={{
          backgroundImage:
            'linear-gradient(45deg, #555 25%, transparent 25%),' +
            'linear-gradient(-45deg, #555 25%, transparent 25%),' +
            'linear-gradient(45deg, transparent 75%, #555 75%),' +
            'linear-gradient(-45deg, transparent 75%, #555 75%)',
          backgroundSize: '6px 6px',
          backgroundPosition: '0 0, 0 3px, 3px -3px, -3px 0',
        }}
      />
      <input
        ref={inputRef}
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="absolute opacity-0 w-0 h-0 pointer-events-none"
        tabIndex={-1}
      />
    </button>
  )
}

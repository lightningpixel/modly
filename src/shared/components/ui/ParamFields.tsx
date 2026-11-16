import { useEffect, useState } from 'react'
import { Tooltip } from './Tooltip'
import {
  LOG_SLIDER_STEPS,
  coerceNumber,
  fromSliderPosition,
  paramControl,
  toSliderPosition,
  type MeshOpParamSchema,
  type ParamControl,
} from '@areas/generate/meshEditPanel'

// Controls generated from an op's params_schema (mesh ops, image ops): the
// same param dict format everywhere, so one renderer.

const INPUT_CLASS =
  'bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1 text-xs text-zinc-200 focus:outline-none focus:border-violet-500 transition-colors disabled:opacity-50'

/** Number text field that commits (clamped) on blur or Enter. */
function NumberField({ control, value, onChange, disabled }: {
  control: Extract<ParamControl, { kind: 'slider' | 'number' }>
  value: number
  onChange: (v: number) => void
  disabled: boolean
}): JSX.Element {
  const [text, setText] = useState(String(value))
  useEffect(() => { setText(String(value)) }, [value])

  function commit() {
    const parsed = Number(text.replace(',', '.'))
    if (text.trim() === '' || !Number.isFinite(parsed)) { setText(String(value)); return }
    const next = coerceNumber(control, parsed)
    setText(String(next))
    if (next !== value) onChange(next)
  }

  return (
    <input
      type="text"
      inputMode={control.integer ? 'numeric' : 'decimal'}
      value={text}
      disabled={disabled}
      aria-label={control.label}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') commit() }}
      className={`${INPUT_CLASS} w-20 shrink-0 text-right tabular-nums`}
    />
  )
}

export function ParamField({ control, value, onChange, disabled }: {
  control: ParamControl
  value: unknown
  onChange: (v: unknown) => void
  disabled: boolean
}): JSX.Element {
  const label = (
    <div className="flex items-center gap-1">
      <span className="text-[11px] text-zinc-400">{control.label}</span>
      {control.tooltip && (
        <Tooltip content={control.tooltip}>
          <span className="text-zinc-600 hover:text-accent-light cursor-default select-none text-[10px]">ⓘ</span>
        </Tooltip>
      )}
    </div>
  )

  switch (control.kind) {
    case 'toggle': {
      const on = value === true
      return (
        <div className="flex items-center justify-between gap-2">
          {label}
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label={control.label}
            disabled={disabled}
            onClick={() => onChange(!on)}
            className={`w-8 h-[18px] rounded-full transition-colors relative shrink-0 disabled:opacity-50 ${on ? 'bg-accent' : 'bg-zinc-700'}`}
          >
            <span className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-all ${on ? 'left-[16px]' : 'left-[2px]'}`} />
          </button>
        </div>
      )
    }
    case 'select':
      return (
        <div className="flex flex-col gap-1">
          {label}
          <select
            value={String(value)}
            disabled={disabled}
            aria-label={control.label}
            onChange={(e) => {
              const option = control.options.find((o) => String(o.value) === e.target.value)
              if (option) onChange(option.value)
            }}
            className={`${INPUT_CLASS} w-full`}
          >
            {control.options.map((o) => (
              <option key={String(o.value)} value={String(o.value)}>{o.label}</option>
            ))}
          </select>
        </div>
      )
    case 'slider': {
      const numeric = typeof value === 'number' ? value : control.defaultValue
      const log = control.scale === 'log'
      return (
        <div className="flex flex-col gap-1">
          {label}
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={log ? 0 : control.min}
              max={log ? LOG_SLIDER_STEPS : control.max}
              step={log ? 1 : control.step}
              value={toSliderPosition(control, numeric)}
              disabled={disabled}
              aria-label={control.label}
              onChange={(e) => onChange(fromSliderPosition(control, e.currentTarget.valueAsNumber))}
              className="min-w-0 flex-1 accent-violet-500 cursor-pointer disabled:cursor-default"
            />
            <NumberField control={control} value={numeric} onChange={onChange} disabled={disabled} />
          </div>
        </div>
      )
    }
    case 'number':
      return (
        <div className="flex items-center justify-between gap-2">
          {label}
          <NumberField
            control={control}
            value={typeof value === 'number' ? value : control.defaultValue}
            onChange={onChange}
            disabled={disabled}
          />
        </div>
      )
    case 'text':
      return (
        <div className="flex flex-col gap-1">
          {label}
          <input
            type="text"
            value={String(value ?? '')}
            disabled={disabled}
            aria-label={control.label}
            onChange={(e) => onChange(e.target.value)}
            className={`${INPUT_CLASS} w-full`}
          />
        </div>
      )
  }
}

/** One control per entry of `schema`; nothing when the op takes no params. */
export function ParamFields({ schema, values, onChange, disabled, className = 'flex flex-col gap-2.5' }: {
  schema: MeshOpParamSchema[]
  values: Record<string, unknown>
  onChange: (id: string, value: unknown) => void
  disabled: boolean
  className?: string
}): JSX.Element | null {
  if (schema.length === 0) return null
  return (
    <div className={className}>
      {schema.map((param) => {
        const control = paramControl(param)
        return (
          <ParamField
            key={param.id}
            control={control}
            value={values[param.id] ?? control.defaultValue}
            onChange={(v) => onChange(param.id, v)}
            disabled={disabled}
          />
        )
      })}
    </div>
  )
}

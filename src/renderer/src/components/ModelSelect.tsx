import { useEffect, useRef, useState } from 'react'
import type { AgentModelCapability } from '@shared/types'
import { formatModelLabel } from '@renderer/lib/runtime-label'

const CUSTOM_MODEL = '__custom__'

interface ModelSelectProps {
  label: string
  value: string
  suggestions: ReadonlyArray<AgentModelCapability>
  fieldClassName: string
  disabled?: boolean
  onChange: (value: string) => void
}

export function ModelSelect({ label, value, suggestions, fieldClassName, disabled = false, onChange }: ModelSelectProps): React.JSX.Element {
  const isKnown = !value || suggestions.some((model) => model.id === value)
  const [customOpen, setCustomOpen] = useState(!isKnown)
  const preserveBlankCustom = useRef(false)
  const selected = customOpen ? CUSTOM_MODEL : value
  const customLabel = `${label.replace(/\s+model$/i, '')} custom model ID`

  useEffect(() => {
    if (!value && preserveBlankCustom.current) {
      preserveBlankCustom.current = false
      return
    }
    setCustomOpen(Boolean(value) && !isKnown)
  }, [isKnown, value])

  const choose = (next: string): void => {
    if (next === CUSTOM_MODEL) {
      setCustomOpen(true)
      if (suggestions.some((model) => model.id === value)) {
        preserveBlankCustom.current = true
        onChange('')
      }
      return
    }
    setCustomOpen(false)
    onChange(next)
  }

  return (
    <div className="model-select-stack">
      <label className={fieldClassName}>
        <span>{label}</span>
        <select aria-label={label} value={selected} onChange={(event) => choose(event.target.value)} disabled={disabled}>
          <option value="">CLI default</option>
          {suggestions.map((model) => <option value={model.id} key={model.id}>{model.label || formatModelLabel(model.id)}</option>)}
          <option value={CUSTOM_MODEL}>Custom model ID...</option>
        </select>
      </label>
      {customOpen && (
        <label className={`${fieldClassName} model-custom-field`}>
          <span>{customLabel}</span>
          <input
            aria-label={customLabel}
            value={value === CUSTOM_MODEL ? '' : value}
            placeholder="Exact CLI model ID"
            onChange={(event) => onChange(event.target.value)}
            disabled={disabled}
          />
        </label>
      )}
    </div>
  )
}

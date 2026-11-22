import type { LucideIcon } from 'lucide-react'
import { useId } from 'react'

interface Option<T extends string> {
  id: T
  label: string
  icon?: LucideIcon
  detail?: string
}

export function OptionGroup<T extends string>({
  label,
  value,
  onChange,
  options,
  disabled = false,
}: {
  label: string
  value: T | null
  onChange: (value: T) => void
  options: readonly Option<T>[]
  disabled?: boolean
}) {
  const name = useId()
  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="ui-label mb-2">{label}</legend>
      <div className={options.length === 2 ? 'grid grid-cols-2 gap-2' : 'grid grid-cols-3 gap-2'}>
        {options.map(({ id, label: optionLabel, icon: Icon, detail }) => (
          <label key={id} className="option-card">
            <input
              type="radio"
              name={name}
              value={id}
              checked={value === id}
              onChange={() => onChange(id)}
              aria-labelledby={name + id}
              aria-describedby={detail ? name + id + '-detail' : undefined}
              className="sr-only"
            />
            {Icon && <Icon aria-hidden="true" />}
            <span id={name + id}>{optionLabel}</span>
            {detail && <span id={name + id + '-detail'} className="option-description">{detail}</span>}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

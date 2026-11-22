import { TALKATIVENESS_OPTIONS, Talkativeness } from '../lib/voicePreferences'
import { optionCardClass } from './optionStyles'

export interface TalkativenessPickerProps {
  value: Talkativeness
  onChange: (value: Talkativeness) => void
}

function LevelBars({ level, active }: { level: number; active: boolean }) {
  return (
    <span className="flex h-4 items-end gap-[3px]" aria-hidden="true">
      {[1, 2, 3].map((bar) => (
        <span
          key={bar}
          className={`w-[3px] rounded-full transition-colors ${
            bar <= level ? (active ? 'bg-accent' : 'bg-zinc-500') : 'bg-zinc-200'
          }`}
          style={{ height: `${4 + bar * 3}px` }}
        />
      ))}
    </span>
  )
}

/** Brief / Standard / Detailed selector for how much is said about each mistake. */
export function TalkativenessPicker({ value, onChange }: TalkativenessPickerProps) {
  return (
    <div role="radiogroup" aria-label="Talkativeness" className="grid grid-cols-3 gap-2">
      {TALKATIVENESS_OPTIONS.map((option) => {
        const selected = value === option.id
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={option.label}
            onClick={() => onChange(option.id)}
            className={optionCardClass(selected)}
          >
            <LevelBars level={option.level} active={selected} />
            <span className="text-xs font-medium text-zinc-900">{option.label}</span>
          </button>
        )
      })}
    </div>
  )
}

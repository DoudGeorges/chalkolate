import { Check } from 'lucide-react'
import { AlertMode } from '../lib/categoryColors'
import { ALERT_MODE_OPTIONS } from './alertModeOptions'
import { VoiceSettings, VoiceSettingsProps } from './VoiceSettings'

export interface SettingsContentProps
  extends Omit<VoiceSettingsProps, 'preferences' | 'onChange' | 'voiceOnly'> {
  alertMode: AlertMode
  onChangeAlertMode: (mode: AlertMode) => void
  voicePreferences: VoiceSettingsProps['preferences']
  onChangeVoicePreferences: VoiceSettingsProps['onChange']
}

/** Settings tab body of the right side panel: alert mode, voice, and how much it talks. */
export function SettingsContent({
  alertMode,
  onChangeAlertMode,
  voicePreferences,
  onChangeVoicePreferences,
  ...voiceProps
}: SettingsContentProps) {
  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <span className="block text-[11px] font-medium uppercase tracking-wider text-zinc-500">
          Alert mode
        </span>
        <div role="radiogroup" aria-label="Alert mode" className="space-y-1.5">
          {ALERT_MODE_OPTIONS.map((option) => {
            const Icon = option.icon
            const selected = alertMode === option.id
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onChangeAlertMode(option.id)}
                className={`flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
                  selected
                    ? 'border-accent bg-accent/[0.06] text-zinc-900'
                    : 'border-line bg-white text-zinc-700 hover:border-zinc-300 hover:bg-zinc-50'
                }`}
              >
                <Icon
                  className={`mt-0.5 h-4 w-4 shrink-0 ${selected ? 'text-accent' : 'text-zinc-500'}`}
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium">{option.label}</span>
                    {selected && (
                      <Check className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
                    )}
                  </div>
                  <p className="mt-0.5 text-[11px] leading-snug text-zinc-500">
                    {option.description}
                  </p>
                </div>
              </button>
            )
          })}
        </div>
      </section>

      {alertMode === 'visual_only' ? (
        <p className="rounded-lg border border-line bg-zinc-50 px-3 py-2.5 text-[11px] leading-snug text-zinc-500">
          Voice settings are hidden while alerts are visual only.
        </p>
      ) : (
        <div className="border-t border-line pt-4">
          <VoiceSettings
            preferences={voicePreferences}
            onChange={onChangeVoicePreferences}
            {...voiceProps}
          />
        </div>
      )}
    </div>
  )
}

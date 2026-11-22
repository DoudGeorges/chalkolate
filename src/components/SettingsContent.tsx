import { AlertMode } from '../lib/categoryColors'
import { Talkativeness } from '../lib/voicePreferences'
import { AnswerFormat } from '../api/schemas'
import { ALERT_MODE_OPTIONS } from './alertModeOptions'
import { optionCardClass } from './optionStyles'
import { TalkativenessPicker } from './TalkativenessPicker'
import { VoiceSettings, VoiceSettingsProps } from './VoiceSettings'

export interface SettingsContentProps {
  alertMode: AlertMode
  onChangeAlertMode: (mode: AlertMode) => void
  talkativeness: Talkativeness
  onChangeTalkativeness: (value: Talkativeness) => void
  answerFormat: AnswerFormat
  onChangeAnswerFormat: (format: AnswerFormat) => void
  /** ElevenLabs voice picker; hidden in visual-only mode. */
  voiceSettings: VoiceSettingsProps
}

const ANSWER_FORMATS = [
  ['exact', 'Exact', '√2/2'],
  ['fraction', 'Fractions', '3/8'],
  ['decimal3', '3 decimals', '0.375'],
] as const

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="block text-[11px] font-medium uppercase tracking-wider text-zinc-500">
      {children}
    </span>
  )
}

/** Settings tab body of the right side panel: alert mode, voice, how much is said, answer format. */
export function SettingsContent({
  alertMode,
  onChangeAlertMode,
  talkativeness,
  onChangeTalkativeness,
  answerFormat,
  onChangeAnswerFormat,
  voiceSettings,
}: SettingsContentProps) {
  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <SectionLabel>Alert mode</SectionLabel>
        <div role="radiogroup" aria-label="Alert mode" className="grid grid-cols-3 gap-2">
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
                className={optionCardClass(selected)}
              >
                <Icon
                  className={`h-4 w-4 ${selected ? 'text-accent' : 'text-zinc-500'}`}
                  aria-hidden="true"
                />
                <span className="text-xs font-medium text-zinc-900">{option.label}</span>
              </button>
            )
          })}
        </div>
      </section>

      {alertMode !== 'visual_only' && (
        <div className="border-t border-line pt-4">
          <VoiceSettings {...voiceSettings} />
        </div>
      )}

      {alertMode !== 'visual_only' && (
        <section className="space-y-2 border-t border-line pt-4">
          <SectionLabel>Spoken detail</SectionLabel>
          <TalkativenessPicker value={talkativeness} onChange={onChangeTalkativeness} />
        </section>
      )}

      <section className="space-y-2 border-t border-line pt-4">
        <SectionLabel>Answer format</SectionLabel>
        <div role="radiogroup" aria-label="Answer format" className="grid grid-cols-3 gap-2">
          {ANSWER_FORMATS.map(([format, label, example]) => (
            <button
              key={format}
              type="button"
              role="radio"
              aria-checked={answerFormat === format}
              onClick={() => onChangeAnswerFormat(format)}
              className={optionCardClass(answerFormat === format)}
            >
              <span className="text-xs font-medium text-zinc-900">{label}</span>
              <span className="text-[11px] text-zinc-500">{example}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}

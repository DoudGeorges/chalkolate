import type { AnswerFormat } from '../api/schemas'
import { AlertMode } from '../lib/categoryColors'
import { ALERT_MODE_OPTIONS } from './alertModeOptions'
import { OptionGroup } from './OptionGroup'
import { SpeechStylePicker } from './SpeechStylePicker'
import { VoiceSettings, VoiceSettingsProps } from './VoiceSettings'

export interface SettingsContentProps {
  alertMode: AlertMode
  onChangeAlertMode: (mode: AlertMode) => void
  answerFormat: AnswerFormat
  onChangeAnswerFormat: (format: AnswerFormat) => void
  voiceSettings: VoiceSettingsProps
}

const ANSWER_FORMATS = [
  { id: 'exact', label: 'Exact', detail: '√2/2' },
  { id: 'fraction', label: 'Fraction', detail: '3/8' },
  { id: 'decimal3', label: '3 decimals', detail: '0.375' },
] as const

export function SettingsContent({
  alertMode,
  onChangeAlertMode,
  answerFormat,
  onChangeAnswerFormat,
  voiceSettings,
}: SettingsContentProps) {
  const usesVoice = alertMode !== 'visual_only'
  return (
    <div className="space-y-5">
      <OptionGroup label="Alerts" value={alertMode} onChange={onChangeAlertMode} options={ALERT_MODE_OPTIONS} />
      {usesVoice && (
        <>
          <SpeechStylePicker
            value={voiceSettings.preferences.speechStyle}
            onChange={(speechStyle) => voiceSettings.onChange({ speechStyle })}
          />
          <VoiceSettings {...voiceSettings} />
        </>
      )}
      <div className="border-t border-line pt-5">
        <OptionGroup label="Number format" value={answerFormat} onChange={onChangeAnswerFormat} options={ANSWER_FORMATS} />
      </div>
    </div>
  )
}

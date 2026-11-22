import { AlertMode } from '../lib/categoryColors'
import { ALERT_MODE_OPTIONS } from './alertModeOptions'
import { OptionGroup } from './OptionGroup'
import { SpeechStylePicker } from './SpeechStylePicker'
import { VoiceSettings, VoiceSettingsProps } from './VoiceSettings'

export interface SettingsContentProps {
  alertMode: AlertMode
  onChangeAlertMode: (mode: AlertMode) => void
  voiceSettings: VoiceSettingsProps
}

export function SettingsContent({
  alertMode,
  onChangeAlertMode,
  voiceSettings,
}: SettingsContentProps) {
  const usesVoice = alertMode !== 'visual_only'
  return (
    <div className="space-y-5">
      <OptionGroup label="Feedback" value={alertMode} onChange={onChangeAlertMode} options={ALERT_MODE_OPTIONS} />
      {usesVoice && (
        <>
          <SpeechStylePicker
            value={voiceSettings.preferences.speechStyle}
            onChange={(speechStyle) => voiceSettings.onChange({ speechStyle })}
          />
          <VoiceSettings {...voiceSettings} />
        </>
      )}
    </div>
  )
}

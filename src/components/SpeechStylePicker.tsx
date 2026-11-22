import type { SpeechStyle } from '../lib/voicePreferences'
import { OptionGroup } from './OptionGroup'

const SPEECH_STYLES = [
  { id: 'student', label: 'Student', detail: 'Correction and reason' },
  { id: 'professor', label: 'Professor', detail: 'Correction only' },
] as const

export function SpeechStylePicker({ value, onChange }: {
  value: SpeechStyle
  onChange: (style: SpeechStyle) => void
}) {
  return <OptionGroup label="Spoken feedback" value={value} onChange={onChange} options={SPEECH_STYLES} layout="choice" />
}

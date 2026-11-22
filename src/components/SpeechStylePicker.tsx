import type { SpeechStyle } from '../lib/voicePreferences'
import { OptionGroup } from './OptionGroup'

const SPEECH_STYLES = [
  { id: 'professor', label: 'Professor', detail: 'Correction only' },
  { id: 'student', label: 'Student', detail: 'Correction and reason' },
] as const

export function SpeechStylePicker({ value, onChange }: {
  value: SpeechStyle
  onChange: (style: SpeechStyle) => void
}) {
  return <OptionGroup label="Detail" value={value} onChange={onChange} options={SPEECH_STYLES} />
}

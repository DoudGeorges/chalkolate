import { GraduationCap, Presentation } from 'lucide-react'
import type { SpeechStyle } from '../lib/voicePreferences'
import { OptionGroup } from './OptionGroup'

const SPEECH_STYLES = [
  { id: 'professor', label: 'Professor', detail: 'Corrections only', icon: Presentation },
  { id: 'student', label: 'Student', detail: 'Corrections and explanations', icon: GraduationCap },
] as const

export function SpeechStylePicker({ value, onChange }: {
  value: SpeechStyle
  onChange: (style: SpeechStyle) => void
}) {
  return <OptionGroup label="Detail" value={value} onChange={onChange} options={SPEECH_STYLES} />
}

import { AudioLines, Eye, Volume2 } from 'lucide-react'
import { AlertMode } from '../lib/categoryColors'

export const ALERT_MODE_OPTIONS: ReadonlyArray<{
  id: AlertMode
  label: string
  icon: typeof Volume2
}> = [
  { id: 'voice_visual', label: 'Voice + Visual', icon: Volume2 },
  { id: 'visual_only', label: 'Visual only', icon: Eye },
  { id: 'voice_only', label: 'Voice only', icon: AudioLines },
]

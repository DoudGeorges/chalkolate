import { AudioLines, Eye, Volume2 } from 'lucide-react'
import { AlertMode } from '../lib/categoryColors'

export const ALERT_MODE_OPTIONS: ReadonlyArray<{
  id: AlertMode
  label: string
  description: string
  /** Short line for compact cards (welcome guide). */
  short: string
  icon: typeof Volume2
}> = [
  {
    id: 'voice_visual',
    label: 'Voice + Visual',
    description: 'Board highlights, findings list, and spoken alerts',
    short: 'Spoken alerts and highlights',
    icon: Volume2,
  },
  {
    id: 'visual_only',
    label: 'Visual only',
    description: 'Board highlights and findings list without speech',
    short: 'Highlights, no speech',
    icon: Eye,
  },
  {
    id: 'voice_only',
    label: 'Voice only',
    description: 'Spoken alerts only with a clean board view',
    short: 'Spoken alerts, clean board',
    icon: AudioLines,
  },
]

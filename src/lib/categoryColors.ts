import { ErrorCategory } from '../api/schemas'

export type AlertMode = 'visual_only' | 'voice_visual' | 'voice_only'

export const CATEGORY_COLORS: Record<ErrorCategory, string> = {
  math: '#c9405b',
  physics: '#a96312',
  spelling: '#22749c',
  factual: '#8057a2',
}

export const CATEGORY_LABELS: Record<ErrorCategory, string> = {
  math: 'Math',
  physics: 'Physics',
  spelling: 'Spelling',
  factual: 'Factual',
}

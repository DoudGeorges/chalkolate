import { ErrorCategory } from '../api/schemas'

export type AlertMode = 'visual_only' | 'voice_visual' | 'voice_only'

export const CATEGORY_COLORS: Record<ErrorCategory, string> = {
  math: '#f43f5e',
  physics: '#f59e0b',
  spelling: '#38bdf8',
}

export const CATEGORY_LABELS: Record<ErrorCategory, string> = {
  math: 'Math',
  physics: 'Physics',
  spelling: 'Spelling',
}

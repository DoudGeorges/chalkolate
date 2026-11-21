import { ErrorCategory } from '../api/schemas'

export type AlertMode = 'visual_only' | 'voice_visual' | 'voice_only'

export const CATEGORY_COLORS: Record<ErrorCategory, string> = {
  math: '#f43f5e',
  physics: '#f59e0b',
  chemistry: '#f59e0b',
  engineering: '#f59e0b',
  code: '#f43f5e',
  logic: '#f43f5e',
  concept: '#f59e0b',
  notation: '#f43f5e',
  grammar: '#38bdf8',
  spelling: '#38bdf8',
}

export const CATEGORY_LABELS: Record<ErrorCategory, string> = {
  math: 'Math',
  physics: 'Physics',
  chemistry: 'Chemistry',
  engineering: 'Engineering',
  code: 'Code',
  logic: 'Logic',
  concept: 'Concept',
  notation: 'Notation',
  grammar: 'Grammar',
  spelling: 'Spelling',
}

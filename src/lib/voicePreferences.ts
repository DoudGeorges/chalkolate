/**
 * User-adjustable voice settings: which ElevenLabs voice speaks and how much it says
 * about each mistake. Persisted in localStorage (no secrets).
 */

export type Talkativeness = 'brief' | 'standard' | 'detailed'

export interface VoicePreferences {
  /** ElevenLabs voice ID from `/api/voices`, or 'default' for the backend-configured voice. */
  elevenLabsVoice: string
  talkativeness: Talkativeness
}

/**
 * Talkativeness controls how much is said about each mistake. Every new mistake is
 * still announced at every level; only the length of the announcement changes.
 */
export const TALKATIVENESS_OPTIONS: ReadonlyArray<{
  id: Talkativeness
  label: string
  description: string
  level: number
}> = [
  {
    id: 'brief',
    label: 'Brief',
    description: 'Just the mistake and the fix, like “Math mistake. Should be 2x.”',
    level: 1,
  },
  {
    id: 'standard',
    label: 'Standard',
    description: 'One sentence describing each mistake',
    level: 2,
  },
  {
    id: 'detailed',
    label: 'Detailed',
    description: 'Describes each mistake and explains why it is wrong',
    level: 3,
  },
]

export const DEFAULT_VOICE_PREFERENCES: VoicePreferences = {
  elevenLabsVoice: 'default',
  talkativeness: 'standard',
}

export const VOICE_PREFERENCES_STORAGE_KEY = 'chalkolate.voicePreferences.v1'

/** Matches the backend SpeechRequest text limit. */
export const MAX_SPOKEN_TEXT_CHARS = 240

/** Values saved by earlier versions of the setting. */
const LEGACY_TALKATIVENESS: Record<string, Talkativeness> = {
  every: 'standard',
  key: 'brief',
  minimal: 'brief',
}

export function sanitizeVoicePreferences(raw: unknown): VoicePreferences {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_VOICE_PREFERENCES }
  const obj = raw as Partial<Record<keyof VoicePreferences, unknown>>
  let talkativeness = DEFAULT_VOICE_PREFERENCES.talkativeness
  if (typeof obj.talkativeness === 'string') {
    if (TALKATIVENESS_OPTIONS.some((o) => o.id === obj.talkativeness)) {
      talkativeness = obj.talkativeness as Talkativeness
    } else if (obj.talkativeness in LEGACY_TALKATIVENESS) {
      talkativeness = LEGACY_TALKATIVENESS[obj.talkativeness] ?? talkativeness
    }
  }
  return {
    elevenLabsVoice:
      typeof obj.elevenLabsVoice === 'string' &&
      /^[A-Za-z0-9_-]{1,128}$/.test(obj.elevenLabsVoice)
        ? obj.elevenLabsVoice
        : DEFAULT_VOICE_PREFERENCES.elevenLabsVoice,
    talkativeness,
  }
}

export function loadVoicePreferences(): VoicePreferences {
  try {
    const stored = window.localStorage.getItem(VOICE_PREFERENCES_STORAGE_KEY)
    return sanitizeVoicePreferences(stored ? JSON.parse(stored) : null)
  } catch {
    return { ...DEFAULT_VOICE_PREFERENCES }
  }
}

export function saveVoicePreferences(prefs: VoicePreferences): void {
  try {
    window.localStorage.setItem(VOICE_PREFERENCES_STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // Storage may be unavailable (private mode / quota); preferences stay in memory.
  }
}

function endSentence(text: string): string {
  const trimmed = text.trim()
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

/** Trims to `max` chars at a sentence or word boundary so speech never cuts mid-word. */
export function fitSpokenText(text: string, max = MAX_SPOKEN_TEXT_CHARS): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  const slice = clean.slice(0, max)
  const sentenceEnd = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('? '), slice.lastIndexOf('! '))
  if (sentenceEnd >= max * 0.5) return slice.slice(0, sentenceEnd + 1)
  const wordEnd = slice.lastIndexOf(' ')
  return endSentence(wordEnd > 0 ? slice.slice(0, wordEnd).replace(/[,;:]$/, '') : slice)
}

/** Alert sentence followed by the explanation, kept within the speech length limit. */
export function buildDetailedText(alert: string, explanation?: string): string {
  const head = endSentence(alert)
  const why = explanation?.trim()
  if (!why) return fitSpokenText(head)
  return fitSpokenText(`${head} ${endSentence(why)}`)
}

const CATEGORY_PHRASES: Record<string, string> = {
  math: 'Math',
  physics: 'Physics',
  spelling: 'Spelling',
  chemistry: 'Chemistry',
  engineering: 'Engineering',
  programming: 'Code',
}

/** Longest correction read verbatim in Brief mode; longer ones are skipped. */
const BRIEF_CORRECTION_MAX_CHARS = 40

/** Short announcement: the kind of mistake plus the fix when the fix is short. */
export function buildBriefText(category?: string, correction?: string): string {
  const kind = (category && CATEGORY_PHRASES[category]) || 'Possible'
  const head = `${kind} mistake.`
  const fix = correction?.replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '')
  if (fix && fix.length <= BRIEF_CORRECTION_MAX_CHARS) {
    return `${head} Should be ${fix}.`
  }
  return head
}

export interface SpeakableIssueText {
  spoken_alert: string
  explanation?: string
  category?: string
  correction_text?: string
}

/** Builds what is said about one mistake at the chosen talkativeness level. */
export function composeSpokenText(issue: SpeakableIssueText, level: Talkativeness): string {
  const alert = issue.spoken_alert.trim()
  if (level === 'brief') return buildBriefText(issue.category, issue.correction_text)
  if (level === 'detailed') return alert ? buildDetailedText(alert, issue.explanation) : ''
  return alert
}

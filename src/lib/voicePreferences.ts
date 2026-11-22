export type SpeechStyle = 'student' | 'professor'

export interface VoicePreferences {
  /** An account voice ID, or 'default' for the configured voice. */
  elevenLabsVoice: string
  speechStyle: SpeechStyle
}

export const DEFAULT_VOICE_PREFERENCES: VoicePreferences = {
  elevenLabsVoice: 'default',
  speechStyle: 'professor',
}

const VOICE_PREFERENCES_STORAGE_KEY = 'chalkolate.voicePreferences.v2'
const LEGACY_VOICE_PREFERENCES_STORAGE_KEY = 'chalkolate.voicePreferences.v1'

export function sanitizeVoicePreferences(raw: unknown): VoicePreferences {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_VOICE_PREFERENCES }
  const { elevenLabsVoice, speechStyle, talkativeness } = raw as Record<string, unknown>
  // Only the former Detailed preset appended an explanation.
  const usedShortAlerts = typeof talkativeness === 'string'
    && ['brief', 'standard', 'every', 'key', 'minimal'].includes(talkativeness)
  return {
    elevenLabsVoice: typeof elevenLabsVoice === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(elevenLabsVoice)
      ? elevenLabsVoice
      : DEFAULT_VOICE_PREFERENCES.elevenLabsVoice,
    speechStyle: speechStyle === 'student' || speechStyle === 'professor'
      ? speechStyle
      : usedShortAlerts ? 'professor' : DEFAULT_VOICE_PREFERENCES.speechStyle,
  }
}

export function loadVoicePreferences(): VoicePreferences {
  try {
    const stored = window.localStorage.getItem(VOICE_PREFERENCES_STORAGE_KEY)
    if (stored) {
      return sanitizeVoicePreferences(JSON.parse(stored))
    }
    const legacy = window.localStorage.getItem(LEGACY_VOICE_PREFERENCES_STORAGE_KEY)
    if (legacy) {
      const migrated = sanitizeVoicePreferences(JSON.parse(legacy))
      return {
        elevenLabsVoice: migrated.elevenLabsVoice,
        speechStyle: DEFAULT_VOICE_PREFERENCES.speechStyle,
      }
    }
    return { ...DEFAULT_VOICE_PREFERENCES }
  } catch {
    return { ...DEFAULT_VOICE_PREFERENCES }
  }
}

export function saveVoicePreferences(prefs: VoicePreferences): void {
  try {
    window.localStorage.setItem(VOICE_PREFERENCES_STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // Preferences remain available in memory if storage is full or disabled.
  }
}

export interface SpeakableIssueText {
  spoken_alert: string
  explanation: string
}

function sentence(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return !clean || /[.!?…]["'”’)]?$/.test(clean) ? clean : clean + '.'
}

export function composeSpokenText(issue: SpeakableIssueText, style: SpeechStyle): string {
  const alert = sentence(issue.spoken_alert)
  const reason = sentence(issue.explanation)
  if (style === 'professor' || !reason || reason === alert) return alert
  return alert ? alert + ' ' + reason : reason
}

/** Keep the full explanation while respecting the speech endpoint's limit per request. */
export function speechRequestChunks(text: string): string[] {
  const limit = 240
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > limit) {
    const prefix = remaining.slice(0, limit + 1)
    const sentenceEnd = Math.max(prefix.lastIndexOf('. '), prefix.lastIndexOf('! '), prefix.lastIndexOf('? ')) + 1
    const wordEnd = prefix.lastIndexOf(' ')
    const hardLimit = /[\uD800-\uDBFF]/.test(remaining.charAt(limit - 1)) ? limit - 1 : limit
    const end = sentenceEnd || (wordEnd > 0 ? wordEnd : hardLimit)
    chunks.push(remaining.slice(0, end))
    remaining = remaining.slice(end).trimStart()
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

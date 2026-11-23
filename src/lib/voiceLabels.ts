import { SpeechVoiceOption } from '../api/schemas'

export interface VoiceDisplay {
  id: string
  /** Short voice name, e.g. "Alice". */
  name: string
  isDefault: boolean
}

/**
 * Splits backend labels shaped like `Name - Tagline (tag, tag)` (optionally prefixed with
 * `Default: `) into a short voice name. Unknown shapes fall back to the raw label.
 */
export function parseVoiceLabel(option: SpeechVoiceOption): VoiceDisplay {
  const isDefault = option.id === 'default'
  let rest = option.label.replace(/\s*[\u2013\u2014]\s*/gu, ' - ').trim()
  if (isDefault) {
    rest = rest.replace(/^Default(?:\s*:\s*|\s+|$)/i, '')
  }

  const tagMatch = /\s*\(([^()]*)\)\s*$/.exec(rest)
  if (tagMatch) {
    rest = rest.slice(0, tagMatch.index).trim()
  }

  const dash = rest.indexOf(' - ')
  const name =
    (dash > 0 ? rest.slice(0, dash).trim() : rest) ||
    (isDefault ? 'Default voice' : 'Unnamed voice')

  return {
    id: option.id,
    name,
    isDefault,
  }
}

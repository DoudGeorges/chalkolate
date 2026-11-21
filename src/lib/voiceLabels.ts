import { SpeechVoiceOption } from '../api/schemas'

export interface VoiceDisplay {
  id: string
  /** Short voice name, e.g. "Alice". */
  name: string
  /** Optional style line, e.g. "Clear, Engaging Educator". */
  tagline: string
  /** Short descriptors from the trailing parentheses, e.g. ["professional", "british"]. */
  tags: string[]
  isDefault: boolean
  /** Lower-cased text used for search. */
  searchText: string
}

/**
 * Splits backend labels shaped like `Name - Tagline (tag, tag)` (optionally prefixed with
 * `Default: `) into display parts. Unknown shapes degrade to the whole label as the name.
 */
export function parseVoiceLabel(option: SpeechVoiceOption): VoiceDisplay {
  const isDefault = option.id === 'default'
  let rest = option.label.trim()
  if (isDefault) {
    rest = rest.replace(/^Default:?\s*/i, '')
  }

  let tags: string[] = []
  const tagMatch = /\s*\(([^()]*)\)\s*$/.exec(rest)
  if (tagMatch && tagMatch[1] !== undefined) {
    tags = tagMatch[1]
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 3)
    rest = rest.slice(0, tagMatch.index).trim()
  }

  let name = rest
  let tagline = ''
  const dash = rest.indexOf(' - ')
  if (dash > 0) {
    name = rest.slice(0, dash).trim()
    tagline = rest.slice(dash + 3).trim()
  }
  if (!name) {
    name = isDefault ? 'Default voice' : 'Unnamed voice'
  }

  return {
    id: option.id,
    name,
    tagline,
    tags,
    isDefault,
    searchText: `${name} ${tagline} ${tags.join(' ')}`.toLowerCase(),
  }
}

/** Stable muted hue per voice name for avatar chips. */
export function voiceHue(name: string): number {
  let hash = 0
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  }
  return hash % 360
}

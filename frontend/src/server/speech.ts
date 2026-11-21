import type { ServerConfig } from './config'
import { ApiError } from './errors'

export const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io/v1'
export const ELEVENLABS_OUTPUT_FORMAT = 'mp3_44100_128'
export const MAX_PREPARED_SPEECH_CHARS = 300

const VOICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export function validateVoiceId(voiceId: string): string {
  const cleaned = voiceId.trim()
  if (!VOICE_ID_PATTERN.test(cleaned)) {
    throw new ApiError(503, 'SPEECH_NOT_CONFIGURED', 'Configured ELEVENLABS_VOICE_ID is invalid.')
  }
  return cleaned
}

/** Sanitize and normalize math/physics shorthand into natural TTS prose. Returns '' when nothing is left. */
export function prepareSpokenText(raw: string): string {
  let cleaned = raw.replace(/[\x00-\x1f\x7f]/g, ' ')
  // Brackets could be read as audio tags by eleven_v4_turbo.
  cleaned = cleaned.replace(/[[\]]/g, ' ')

  cleaned = cleaned
    .replace(/(?<![A-Za-z])m\s*\/\s*s(?:\^2|²)(?![A-Za-z0-9])/g, ' meters per second squared ')
    .replace(/(?<![A-Za-z])m\s*\/\s*s(?![A-Za-z0-9])/g, ' meters per second ')
    .replace(/(?<![A-Za-z])N\s*\/\s*m(?![A-Za-z0-9])/g, ' Newtons per meter ')
    .replace(/(?:\^2|²)/g, ' squared ')
    .replace(/(?:\^3|³)/g, ' cubed ')

  const replacements: Array<[string, string]> = [
    ['×', ' times '],
    ['⋅', ' times '],
    ['≠', ' is not equal to '],
    ['≈', ' is approximately '],
    ['±', ' plus or minus '],
    ['−', ' minus '],
    ['√', ' square root of '],
    ['∫', ' integral of '],
    ['π', ' pi '],
    ['θ', ' theta '],
    ['Δ', ' delta '],
  ]
  for (const [symbol, spoken] of replacements) cleaned = cleaned.split(symbol).join(spoken)

  let normalized = cleaned.replace(/\s+/g, ' ').trim()
  if (normalized.length > MAX_PREPARED_SPEECH_CHARS) {
    normalized = normalized.slice(0, MAX_PREPARED_SPEECH_CHARS).trimEnd()
  }
  return normalized
}

function parseRetryAfter(headers: Headers): number | null {
  const raw = headers.get('retry-after')?.trim()
  return raw && /^\d+$/.test(raw) ? Math.max(1, Number(raw)) : null
}

async function readErrorTags(response: Response): Promise<{ code: string | null; status: string | null }> {
  try {
    const bytes = new Uint8Array(await response.arrayBuffer()).slice(0, 4096)
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
      detail?: { code?: unknown; status?: unknown }
    }
    const norm = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : null)
    return { code: norm(parsed.detail?.code), status: norm(parsed.detail?.status) }
  } catch {
    return { code: null, status: null }
  }
}

export interface SpeechOptions {
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

/**
 * Open a streaming MP3 request to ElevenLabs. Resolves with the upstream Response (status 200, body not yet
 * consumed) so the caller can pipe it to the browser. Never logs credentials or spoken text.
 */
export async function openSpeechStream(
  text: string,
  config: ServerConfig,
  options: SpeechOptions = {},
): Promise<Response> {
  if (!config.speechConfigured) {
    throw new ApiError(503, 'SPEECH_NOT_CONFIGURED', 'ElevenLabs text-to-speech is not configured on the server.')
  }
  const voiceId = validateVoiceId(config.elevenlabsVoiceId)
  const prepared = prepareSpokenText(text)
  if (!prepared) {
    throw new ApiError(502, 'SPEECH_PROVIDER_ERROR', 'Speech text is empty after sanitization.')
  }

  const url = `${ELEVENLABS_BASE_URL}/text-to-speech/${voiceId}/stream?output_format=${ELEVENLABS_OUTPUT_FORMAT}`
  // The deadline covers time-to-first-byte only; once headers arrive the stream may run on.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('speech-timeout')), config.speechTimeoutSeconds * 1000)
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal

  let response: Response
  try {
    response = await (options.fetchImpl ?? fetch)(url, {
      method: 'POST',
      headers: {
        'xi-api-key': config.elevenlabsApiKey.trim(),
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text: prepared,
        model_id: config.elevenlabsModelId.trim(),
        apply_text_normalization: 'auto',
        voice_settings: { stability: 0.55, similarity_boost: 0.75 },
      }),
      signal,
    })
  } catch (err) {
    if (controller.signal.aborted) throw new ApiError(504, 'SPEECH_TIMEOUT', 'Speech synthesis timed out.')
    if (options.signal?.aborted) throw err
    throw new ApiError(503, 'SPEECH_UNAVAILABLE', 'Speech provider connection failed.', { retryAfterSeconds: 5 })
  } finally {
    clearTimeout(timer)
  }

  if (response.status === 200) return response

  const retryAfter = parseRetryAfter(response.headers)
  const { code, status } = await readErrorTags(response)
  console.warn(`ElevenLabs TTS upstream failure status=${response.status} code=${code ?? 'unknown'} tag=${status ?? 'unknown'}`)

  if (response.status === 401 || response.status === 403) {
    throw new ApiError(502, 'SPEECH_AUTH_ERROR', 'ElevenLabs credentials or voice permissions were rejected.')
  }
  if (code === 'quota_exceeded' || status === 'quota_exceeded') {
    throw new ApiError(
      503,
      'SPEECH_QUOTA_EXCEEDED',
      'ElevenLabs character quota exceeded; falling back to browser voice.',
      { retryAfterSeconds: retryAfter ?? 60 },
    )
  }
  if (response.status === 402 || code === 'paid_plan_required') {
    throw new ApiError(
      503,
      'SPEECH_VOICE_PLAN_REQUIRED',
      'Configured ElevenLabs voice requires a paid plan; use a premade voice or upgrade.',
    )
  }
  if (response.status === 429) {
    throw new ApiError(429, 'SPEECH_RATE_LIMITED', 'ElevenLabs speech rate limit reached.', {
      retryAfterSeconds: retryAfter ?? 10,
    })
  }
  if (response.status === 408 || response.status === 504) {
    throw new ApiError(504, 'SPEECH_TIMEOUT', 'Speech synthesis request timed out upstream.')
  }
  if (response.status === 503) {
    throw new ApiError(503, 'SPEECH_UNAVAILABLE', 'ElevenLabs speech service is temporarily unavailable.', {
      retryAfterSeconds: retryAfter ?? 5,
    })
  }
  throw new ApiError(502, 'SPEECH_PROVIDER_ERROR', 'Speech synthesis provider returned an unexpected error.')
}

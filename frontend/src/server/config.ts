export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high'

const THINKING_LEVELS: readonly ThinkingLevel[] = ['minimal', 'low', 'medium', 'high']

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/** Server-only settings. Read from process env (Vercel env vars, or frontend/.env.local in dev). */
export interface ServerConfig {
  geminiApiKey: string
  geminiModel: string
  geminiThinkingLevel: ThinkingLevel
  elevenlabsApiKey: string
  elevenlabsModelId: string
  elevenlabsVoiceId: string
  confidenceThreshold: number
  analysisTimeoutSeconds: number
  analysisMaxOutputTokens: number
  speechTimeoutSeconds: number
  maxUploadBytes: number
  maxMetadataBytes: number
  maxImagePixels: number
  analysisConfigured: boolean
  speechConfigured: boolean
}

type Env = Record<string, string | undefined>

function str(env: Env, key: string, fallback: string): string {
  const raw = env[key]
  return raw === undefined ? fallback : raw.trim()
}

function num(env: Env, key: string, fallback: number, integer: boolean): number {
  const raw = env[key]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw.trim())
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    throw new ConfigError(`${key} must be ${integer ? 'an integer' : 'a finite number'}.`)
  }
  return value
}

export function loadConfig(env: Env = process.env): ServerConfig {
  const level = str(env, 'GEMINI_THINKING_LEVEL', 'low').toLowerCase()
  if (!(THINKING_LEVELS as readonly string[]).includes(level)) {
    throw new ConfigError(`GEMINI_THINKING_LEVEL must be one of ${THINKING_LEVELS.join(', ')}.`)
  }

  const config = {
    geminiApiKey: str(env, 'GEMINI_API_KEY', ''),
    geminiModel: str(env, 'GEMINI_MODEL', 'gemini-3.8-flash'),
    geminiThinkingLevel: level as ThinkingLevel,
    elevenlabsApiKey: str(env, 'ELEVENLABS_API_KEY', ''),
    elevenlabsModelId: str(env, 'ELEVENLABS_MODEL_ID', 'eleven_v4_turbo'),
    elevenlabsVoiceId: str(env, 'ELEVENLABS_VOICE_ID', ''),
    confidenceThreshold: num(env, 'ANALYSIS_CONFIDENCE_THRESHOLD', 0.85, false),
    analysisTimeoutSeconds: num(env, 'ANALYSIS_TIMEOUT_SECONDS', 20, false),
    analysisMaxOutputTokens: num(env, 'ANALYSIS_MAX_OUTPUT_TOKENS', 4096, true),
    speechTimeoutSeconds: num(env, 'SPEECH_TIMEOUT_SECONDS', 10, false),
    // Vercel caps function request bodies at ~4.5 MB, so the default stays below that.
    maxUploadBytes: num(env, 'MAX_UPLOAD_BYTES', 4 * 1024 * 1024, true),
    maxMetadataBytes: num(env, 'MAX_METADATA_BYTES', 16 * 1024, true),
    maxImagePixels: num(env, 'MAX_IMAGE_PIXELS', 25_000_000, true),
  }

  if (config.confidenceThreshold < 0 || config.confidenceThreshold > 1) {
    throw new ConfigError('ANALYSIS_CONFIDENCE_THRESHOLD must be between 0.0 and 1.0.')
  }
  if (config.analysisTimeoutSeconds <= 0) throw new ConfigError('ANALYSIS_TIMEOUT_SECONDS must be > 0.')
  if (config.analysisMaxOutputTokens < 64) throw new ConfigError('ANALYSIS_MAX_OUTPUT_TOKENS must be >= 64.')
  if (config.speechTimeoutSeconds <= 0) throw new ConfigError('SPEECH_TIMEOUT_SECONDS must be > 0.')
  if (config.maxUploadBytes < 1024) throw new ConfigError('MAX_UPLOAD_BYTES must be >= 1024.')
  if (config.maxMetadataBytes < 256) throw new ConfigError('MAX_METADATA_BYTES must be >= 256.')
  if (config.maxImagePixels < 1024) throw new ConfigError('MAX_IMAGE_PIXELS must be >= 1024.')

  return {
    ...config,
    analysisConfigured: Boolean(config.geminiApiKey && config.geminiModel),
    speechConfigured: Boolean(
      config.elevenlabsApiKey && config.elevenlabsModelId && config.elevenlabsVoiceId,
    ),
  }
}

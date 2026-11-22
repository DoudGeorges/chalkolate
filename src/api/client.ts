import { z } from 'zod'
import { isAbortError } from '../lib/abort'
import {
  AnalysisMetadataPayload,
  AnalysisResponse,
  AnalysisResponseSchema,
  BoardDetectionResponse,
  BoardDetectionResponseSchema,
  ErrorEnvelopeSchema,
  HealthResponse,
  HealthResponseSchema,
  NotesMetadataPayload,
  NotesResponse,
  NotesResponseSchema,
  VoicesResponse,
  VoicesResponseSchema,
} from './schemas'

export class ApiClientError extends Error {
  readonly code: string
  readonly status: number
  readonly retryAfterSeconds: number | null
  readonly requestId: string | null

  constructor(
    message: string,
    options: {
      code: string
      status: number
      retryAfterSeconds?: number | null
      requestId?: string | null
    },
  ) {
    super(message)
    this.name = 'ApiClientError'
    this.code = options.code
    this.status = options.status
    this.retryAfterSeconds = options.retryAfterSeconds ?? null
    this.requestId = options.requestId ?? null
  }
}

function parseRetryAfterHeader(value: string | null): number | null {
  if (!value) return null
  const seconds = Number(value.trim())
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.ceil(seconds)
  }
  return null
}

async function parseErrorResponse(response: Response): Promise<ApiClientError> {
  const retryAfterSeconds = parseRetryAfterHeader(response.headers.get('Retry-After'))
  let raw: unknown = null
  try {
    raw = await response.json()
  } catch {
    return new ApiClientError(`Server returned HTTP ${response.status}.`, {
      code: 'HTTP_ERROR',
      status: response.status,
      retryAfterSeconds,
    })
  }

  const parsed = ErrorEnvelopeSchema.safeParse(raw)
  if (parsed.success) {
    return new ApiClientError(parsed.data.message, {
      code: parsed.data.code,
      status: response.status,
      retryAfterSeconds,
      requestId: parsed.data.request_id ?? null,
    })
  }

  return new ApiClientError(
    `Server returned HTTP ${response.status} with an unexpected payload.`,
    {
      code: 'UNEXPECTED_ERROR_PAYLOAD',
      status: response.status,
      retryAfterSeconds,
    },
  )
}

/** Random per-page-load id sent on every request so the owner-only debug log can group a session. */
const SESSION_ID =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Math.random().toString(16).slice(2)
const SESSION_HEADERS = { 'X-Chalkolate-Session': SESSION_ID }

/**
 * Sends one API request and returns the successful response. Responses are per-user data, so
 * the browser HTTP cache is bypassed (the backend also replies `Cache-Control: no-store`).
 */
async function sendRequest(
  url: string,
  init: RequestInit,
  networkErrorMessage: string,
): Promise<Response> {
  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      cache: 'no-store',
      headers: { ...(init.headers as Record<string, string> | undefined), ...SESSION_HEADERS },
    })
  } catch (err) {
    if (isAbortError(err)) {
      throw err
    }
    throw new ApiClientError(networkErrorMessage, { code: 'NETWORK_ERROR', status: 0 })
  }

  if (!response.ok) {
    throw await parseErrorResponse(response)
  }
  return response
}

interface ParseMessages {
  malformed: string
  invalid: string
  invalidCode?: string
  requestId?: string
}

async function parseJsonResponse<T>(
  response: Response,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  messages: ParseMessages,
): Promise<T> {
  let raw: unknown
  try {
    raw = await response.json()
  } catch {
    throw new ApiClientError(messages.malformed, {
      code: 'MALFORMED_RESPONSE',
      status: response.status,
    })
  }

  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    throw new ApiClientError(messages.invalid, {
      code: messages.invalidCode ?? 'INVALID_RESPONSE_CONTRACT',
      status: response.status,
      requestId: messages.requestId ?? null,
    })
  }
  return parsed.data
}

function assertRequestIdMatches(
  label: string,
  expected: string,
  actual: string,
  status: number,
): void {
  if (actual !== expected) {
    throw new ApiClientError(`${label} response request_id did not match the request.`, {
      code: 'REQUEST_ID_MISMATCH',
      status,
      requestId: actual,
    })
  }
}

function snapshotForm(imageBlob: Blob, filename: string, metadata?: object): FormData {
  const formData = new FormData()
  formData.append('image', imageBlob, filename)
  if (metadata !== undefined) {
    formData.append('metadata', JSON.stringify(metadata))
  }
  return formData
}

export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const response = await sendRequest(
    '/api/health',
    { method: 'GET', signal, headers: { Accept: 'application/json' } },
    'Unable to reach backend health endpoint.',
  )
  return parseJsonResponse(response, HealthResponseSchema, {
    malformed: 'Health endpoint returned malformed JSON.',
    invalid: 'Health response failed contract validation.',
    invalidCode: 'INVALID_HEALTH_CONTRACT',
  })
}

/** Lists the ElevenLabs voices available to the backend's account ('default' first). */
export async function fetchVoices(signal?: AbortSignal): Promise<VoicesResponse> {
  const response = await sendRequest(
    '/api/voices',
    { method: 'GET', signal, headers: { Accept: 'application/json' } },
    'Unable to load ElevenLabs voices.',
  )
  return parseJsonResponse(response, VoicesResponseSchema, {
    malformed: 'Voices endpoint returned malformed JSON.',
    invalid: 'Voices response failed contract validation.',
    invalidCode: 'INVALID_VOICES_CONTRACT',
  })
}

export async function analyzeSnapshot(
  imageBlob: Blob,
  metadata: AnalysisMetadataPayload,
  signal?: AbortSignal,
): Promise<AnalysisResponse> {
  const response = await sendRequest(
    '/api/analyze',
    { method: 'POST', body: snapshotForm(imageBlob, 'snapshot.jpg', metadata), signal },
    'Network error while sending board snapshot for analysis.',
  )
  const parsed = await parseJsonResponse(response, AnalysisResponseSchema, {
    malformed: 'Analysis response was not valid JSON.',
    invalid: 'Analysis response failed schema validation.',
    requestId: metadata.request_id,
  })
  assertRequestIdMatches('Analysis', metadata.request_id, parsed.request_id, response.status)

  return {
    ...parsed,
    incomplete: response.headers.get('X-Chalkolate-Partial-Analysis') === '1',
  }
}

export async function detectBoardCorners(
  imageBlob: Blob,
  signal?: AbortSignal,
): Promise<BoardDetectionResponse> {
  const response = await sendRequest(
    '/api/detect-board',
    { method: 'POST', body: snapshotForm(imageBlob, 'frame.jpg'), signal },
    'Network error while detecting board corners.',
  )
  return parseJsonResponse(response, BoardDetectionResponseSchema, {
    malformed: 'Board detection response was not valid JSON.',
    invalid: 'Board detection response failed schema validation.',
  })
}

export interface SpeechStreamOptions {
  /** ElevenLabs voice ID from /api/voices; omitted/'default' uses the configured voice. */
  voice?: string
}

export async function requestSpeechStream(
  text: string,
  signal?: AbortSignal,
  options: SpeechStreamOptions = {},
): Promise<Response> {
  const body: { text: string; voice?: string } = { text }
  if (options.voice && options.voice !== 'default') body.voice = options.voice
  const response = await sendRequest(
    '/api/speech',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
        ...SESSION_HEADERS,
      },
      body: JSON.stringify(body),
      signal,
    },
    'Network error while requesting speech audio.',
  )

  const contentType = (response.headers.get('Content-Type') ?? '').toLowerCase()
  if (!contentType.startsWith('audio/')) {
    throw new ApiClientError('Speech endpoint did not return audio content.', {
      code: 'INVALID_SPEECH_RESPONSE',
      status: response.status,
    })
  }

  return response
}

/** Incremental Permanotes update. Independent of /api/analyze; never shares its state. */
export async function requestNotesUpdate(
  imageBlob: Blob,
  metadata: NotesMetadataPayload,
  signal?: AbortSignal,
): Promise<NotesResponse> {
  const response = await sendRequest(
    '/api/notes',
    { method: 'POST', body: snapshotForm(imageBlob, 'notes-snapshot.jpg', metadata), signal },
    'Network error while updating lecture notes.',
  )
  const parsed = await parseJsonResponse(response, NotesResponseSchema, {
    malformed: 'Notes response was not valid JSON.',
    invalid: 'Notes response failed schema validation.',
    requestId: metadata.request_id,
  })
  assertRequestIdMatches('Notes', metadata.request_id, parsed.request_id, response.status)
  return parsed
}

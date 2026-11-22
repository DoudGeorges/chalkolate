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
  } catch (err) {
    if (isAbortError(err)) throw err
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
  const headers = new Headers(init.headers)
  for (const [name, value] of Object.entries(SESSION_HEADERS)) headers.set(name, value)
  try {
    response = await fetch(url, {
      ...init,
      cache: 'no-store',
      headers,
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
  unreadable: string
  requestId?: string
}

async function parseJsonResponse<T>(
  response: Response,
  schema: z.ZodType<T, unknown>,
  messages: ParseMessages,
): Promise<T> {
  let raw: unknown
  try {
    raw = await response.json()
  } catch (err) {
    if (isAbortError(err)) throw err
    throw new ApiClientError(messages.unreadable, {
      code: 'MALFORMED_RESPONSE',
      status: response.status,
    })
  }

  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    throw new ApiClientError(messages.unreadable, {
      code: 'INVALID_RESPONSE_CONTRACT',
      status: response.status,
      requestId: messages.requestId ?? null,
    })
  }
  return parsed.data
}

async function sendJsonRequest<T>(
  url: string,
  init: RequestInit,
  schema: z.ZodType<T, unknown>,
  messages: ParseMessages & { network: string; timeoutMs: number },
): Promise<T> {
  const controller = new AbortController()
  const cancel = () => controller.abort()
  const parentSignal = init.signal
  if (parentSignal?.aborted) cancel()
  else parentSignal?.addEventListener('abort', cancel, { once: true })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    cancel()
  }, messages.timeoutMs)

  try {
    const response = await sendRequest(url, { ...init, signal: controller.signal }, messages.network)
    return await parseJsonResponse(response, schema, messages)
  } catch (err) {
    if (!timedOut || parentSignal?.aborted) throw err
    throw new ApiClientError('The request timed out. Try again.', { code: 'REQUEST_TIMEOUT', status: 0 })
  } finally {
    clearTimeout(timer)
    parentSignal?.removeEventListener('abort', cancel)
  }
}

function assertRequestIdMatches(
  label: string,
  expected: string,
  actual: string,
  status: number,
): void {
  if (actual !== expected) {
    throw new ApiClientError(`The ${label} response belongs to a different request. Try again.`, {
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
  return sendJsonRequest('/api/health', { signal }, HealthResponseSchema, {
    network: 'Unable to reach the analysis service.',
    unreadable: 'The analysis service returned an unreadable status.',
    timeoutMs: 8000,
  })
}

/** Lists the ElevenLabs voices available to the backend's account ('default' first). */
export async function fetchVoices(signal?: AbortSignal): Promise<VoicesResponse> {
  return sendJsonRequest('/api/voices', { signal }, VoicesResponseSchema, {
    network: 'Unable to reach the voice service.',
    unreadable: 'The voice list could not be read. Try again.',
    timeoutMs: 15_000,
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
    'The board image could not be sent. Check your connection.',
  )
  const parsed = await parseJsonResponse(response, AnalysisResponseSchema, {
    unreadable: 'The board check returned an unreadable result. Try again.',
    requestId: metadata.request_id,
  })
  assertRequestIdMatches('board check', metadata.request_id, parsed.request_id, response.status)

  return {
    ...parsed,
    incomplete: response.headers.get('X-Chalkolate-Partial-Analysis') === '1',
  }
}

export async function detectBoardCorners(
  imageBlob: Blob,
  signal?: AbortSignal,
): Promise<BoardDetectionResponse> {
  return sendJsonRequest(
    '/api/detect-board',
    { method: 'POST', body: snapshotForm(imageBlob, 'frame.jpg'), signal },
    BoardDetectionResponseSchema,
    {
      network: 'Unable to reach the board detection service.',
      unreadable: 'The detected board corners could not be read. Try again.',
      timeoutMs: 15_000,
    },
  )
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
      },
      body: JSON.stringify(body),
      signal,
    },
    'The voice service could not be reached. Check your connection.',
  )

  const contentType = (response.headers.get('Content-Type') ?? '').toLowerCase()
  if (!contentType.startsWith('audio/')) {
    throw new ApiClientError('The voice service did not return playable audio.', {
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
  const parsed = await sendJsonRequest(
    '/api/notes',
    { method: 'POST', body: snapshotForm(imageBlob, 'notes-snapshot.jpg', metadata), signal },
    NotesResponseSchema,
    {
      network: 'Unable to reach the notes service.',
      unreadable: 'The notes update could not be read. Try again.',
      requestId: metadata.request_id,
      timeoutMs: 60_000,
    },
  )
  assertRequestIdMatches('notes', metadata.request_id, parsed.request_id, 200)
  return parsed
}

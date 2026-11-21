import {
  AnalysisMetadataPayload,
  AnalysisResponse,
  AnalysisResponseSchema,
  BoardDetectionResponse,
  BoardDetectionResponseSchema,
  ErrorEnvelopeSchema,
  HealthResponse,
  HealthResponseSchema,
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
    return new ApiClientError(
      `Server returned HTTP ${response.status}.`,
      {
        code: 'HTTP_ERROR',
        status: response.status,
        retryAfterSeconds,
      },
    )
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

export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  let response: Response
  try {
    response = await fetch('/api/health', {
      method: 'GET',
      signal,
      headers: { Accept: 'application/json' },
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err
    }
    throw new ApiClientError('Unable to reach backend health endpoint.', {
      code: 'NETWORK_ERROR',
      status: 0,
    })
  }

  if (!response.ok) {
    throw await parseErrorResponse(response)
  }

  let raw: unknown
  try {
    raw = await response.json()
  } catch {
    throw new ApiClientError('Health endpoint returned malformed JSON.', {
      code: 'MALFORMED_RESPONSE',
      status: response.status,
    })
  }

  const parsed = HealthResponseSchema.safeParse(raw)
  if (!parsed.success) {
    throw new ApiClientError('Health response failed contract validation.', {
      code: 'INVALID_HEALTH_CONTRACT',
      status: response.status,
    })
  }
  return parsed.data
}

export async function analyzeSnapshot(
  imageBlob: Blob,
  metadata: AnalysisMetadataPayload,
  signal?: AbortSignal,
): Promise<AnalysisResponse> {
  const formData = new FormData()
  formData.append('image', imageBlob, 'snapshot.jpg')
  formData.append('metadata', JSON.stringify(metadata))

  let response: Response
  try {
    response = await fetch('/api/analyze', {
      method: 'POST',
      body: formData,
      signal,
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err
    }
    throw new ApiClientError('Network error while sending board snapshot for analysis.', {
      code: 'NETWORK_ERROR',
      status: 0,
    })
  }

  if (!response.ok) {
    throw await parseErrorResponse(response)
  }

  let raw: unknown
  try {
    raw = await response.json()
  } catch {
    throw new ApiClientError('Analysis response was not valid JSON.', {
      code: 'MALFORMED_RESPONSE',
      status: response.status,
    })
  }

  const parsed = AnalysisResponseSchema.safeParse(raw)
  if (!parsed.success) {
    throw new ApiClientError('Analysis response failed schema validation.', {
      code: 'INVALID_RESPONSE_CONTRACT',
      status: response.status,
      requestId: metadata.request_id,
    })
  }

  if (parsed.data.request_id !== metadata.request_id) {
    throw new ApiClientError('Analysis response request_id did not match the request.', {
      code: 'REQUEST_ID_MISMATCH',
      status: response.status,
      requestId: parsed.data.request_id,
    })
  }

  return parsed.data
}

export async function detectBoardCorners(
  imageBlob: Blob,
  signal?: AbortSignal,
): Promise<BoardDetectionResponse> {
  const formData = new FormData()
  formData.append('image', imageBlob, 'frame.jpg')

  let response: Response
  try {
    response = await fetch('/api/detect-board', {
      method: 'POST',
      body: formData,
      signal,
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err
    }
    throw new ApiClientError('Network error while detecting board corners.', {
      code: 'NETWORK_ERROR',
      status: 0,
    })
  }

  if (!response.ok) {
    throw await parseErrorResponse(response)
  }

  let raw: unknown
  try {
    raw = await response.json()
  } catch {
    throw new ApiClientError('Board detection response was not valid JSON.', {
      code: 'MALFORMED_RESPONSE',
      status: response.status,
    })
  }

  const parsed = BoardDetectionResponseSchema.safeParse(raw)
  if (!parsed.success) {
    throw new ApiClientError('Board detection response failed schema validation.', {
      code: 'INVALID_RESPONSE_CONTRACT',
      status: response.status,
    })
  }

  return parsed.data
}

export async function requestSpeechStream(
  text: string,
  signal?: AbortSignal,
): Promise<Response> {
  let response: Response
  try {
    response = await fetch('/api/speech', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({ text }),
      signal,
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err
    }
    throw new ApiClientError('Network error while requesting speech audio.', {
      code: 'NETWORK_ERROR',
      status: 0,
    })
  }

  if (!response.ok) {
    throw await parseErrorResponse(response)
  }

  const contentType = (response.headers.get('Content-Type') ?? '').toLowerCase()
  if (!contentType.startsWith('audio/')) {
    throw new ApiClientError('Speech endpoint did not return audio content.', {
      code: 'INVALID_SPEECH_RESPONSE',
      status: response.status,
    })
  }

  return response
}

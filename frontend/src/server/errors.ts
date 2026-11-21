import { ConfigError } from './config'

/** Error that maps 1:1 onto the ErrorEnvelope the client already understands. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly retryAfterSeconds: number | null
  readonly requestId: string | null

  constructor(
    status: number,
    code: string,
    message: string,
    options: { retryAfterSeconds?: number | null; requestId?: string | null } = {},
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.retryAfterSeconds = options.retryAfterSeconds ?? null
    this.requestId = options.requestId ?? null
  }
}

export function errorResponse(error: ApiError, requestId?: string | null): Response {
  const headers = new Headers({ 'Cache-Control': 'no-store' })
  if (error.retryAfterSeconds !== null) {
    headers.set('Retry-After', String(Math.max(1, Math.ceil(error.retryAfterSeconds))))
  }
  return Response.json(
    { code: error.code, message: error.message, request_id: error.requestId ?? requestId ?? null },
    { status: error.status, headers },
  )
}

/** Convert any thrown value into a safe envelope. Never logs credentials, frames, or provider text. */
export function toErrorResponse(err: unknown, requestId?: string | null): Response {
  if (err instanceof ApiError) return errorResponse(err, requestId)
  if (err instanceof ConfigError) {
    console.error('Server configuration error:', err.message)
    return errorResponse(
      new ApiError(500, 'SERVER_MISCONFIGURED', 'Server configuration is invalid.'),
      requestId,
    )
  }
  console.error('Unhandled API failure:', err instanceof Error ? err.name : typeof err)
  return errorResponse(
    new ApiError(500, 'INTERNAL_ERROR', 'An internal server error occurred while processing the request.'),
    requestId,
  )
}

export const NO_STORE = { 'Cache-Control': 'no-store' } as const

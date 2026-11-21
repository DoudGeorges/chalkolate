import { loadConfig } from '../../../server/config'
import { ApiError, toErrorResponse } from '../../../server/errors'
import { SpeechRequestSchema } from '../../../server/schemas'
import { openSpeechStream } from '../../../server/speech'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const MAX_SPEECH_BODY_BYTES = 4096

/** Stream synthesized MP3 for one alert sentence. The ElevenLabs key and voice ID never reach the browser. */
export async function POST(request: Request): Promise<Response> {
  try {
    const declared = Number(request.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_SPEECH_BODY_BYTES) {
      throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request payload exceeds maximum allowed size.')
    }

    const raw = await request.text()
    if (new TextEncoder().encode(raw).length > MAX_SPEECH_BODY_BYTES) {
      throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request payload exceeds maximum allowed size.')
    }
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      json = null
    }
    const body = SpeechRequestSchema.safeParse(json)
    if (!body.success) {
      throw new ApiError(422, 'INVALID_REQUEST', 'Request payload is invalid or missing required fields.')
    }

    const config = loadConfig()
    const upstream = await openSpeechStream(body.data.text, config, { signal: request.signal })

    return new Response(upstream.body, {
      status: 200,
      headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' },
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

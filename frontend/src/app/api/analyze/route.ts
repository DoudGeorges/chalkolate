import { loadConfig } from '../../../server/config'
import { ApiError, NO_STORE, toErrorResponse } from '../../../server/errors'
import { analyzeBoardImage } from '../../../server/gemini'
import { inspectImage } from '../../../server/image'
import { AnalysisMetadataSchema } from '../../../server/schemas'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const MULTIPART_OVERHEAD_BYTES = 64 * 1024

function bestEffortRequestId(rawMetadata: string): string | null {
  try {
    const data: unknown = JSON.parse(rawMetadata)
    const candidate = (data as { request_id?: unknown } | null)?.request_id
    return typeof candidate === 'string' && /^[0-9a-f-]{36}$/i.test(candidate) ? candidate.toLowerCase() : null
  } catch {
    return null
  }
}

/**
 * Analyze one uncalibrated board snapshot (multipart: `image` + `metadata`). Boxes are returned in the
 * coordinates of the uploaded image, which equal source coordinates when no calibration/warp is applied.
 * Calibrated requests are still served by the legacy backend (see client.ts) until warp/projection is ported.
 */
export async function POST(request: Request): Promise<Response> {
  const startedAt = performance.now()
  let requestId: string | null = null
  try {
    const config = loadConfig()

    const declared = Number(request.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > config.maxUploadBytes + config.maxMetadataBytes + MULTIPART_OVERHEAD_BYTES) {
      throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request payload exceeds maximum allowed size.')
    }

    let form: FormData
    try {
      form = await request.formData()
    } catch {
      throw new ApiError(422, 'INVALID_REQUEST', 'Request payload is invalid or missing required fields.')
    }
    const metadataRaw = form.get('metadata')
    const image = form.get('image')
    if (typeof metadataRaw !== 'string' || !(image instanceof File)) {
      throw new ApiError(422, 'INVALID_REQUEST', 'Request payload is invalid or missing required fields.')
    }

    if (new TextEncoder().encode(metadataRaw).length > config.maxMetadataBytes) {
      throw new ApiError(413, 'METADATA_TOO_LARGE', 'Analysis metadata exceeds maximum allowed size.')
    }
    requestId = bestEffortRequestId(metadataRaw)

    let json: unknown
    try {
      json = JSON.parse(metadataRaw)
    } catch {
      json = null
    }
    const metadata = AnalysisMetadataSchema.safeParse(json)
    if (!metadata.success) {
      throw new ApiError(422, 'INVALID_METADATA', 'Invalid analysis metadata payload.', { requestId })
    }
    requestId = metadata.data.request_id

    if (metadata.data.corners) {
      throw new ApiError(
        501,
        'CALIBRATION_NOT_MIGRATED',
        'Calibrated analysis is not available on this route yet.',
        { requestId },
      )
    }
    if (!config.analysisConfigured) {
      throw new ApiError(503, 'ANALYSIS_NOT_CONFIGURED', 'Server GEMINI_API_KEY or model is not configured.', {
        requestId,
      })
    }

    if (image.size > config.maxUploadBytes) {
      throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Uploaded image exceeds maximum allowed byte size.', { requestId })
    }
    const bytes = new Uint8Array(await image.arrayBuffer())
    const info = inspectImage(bytes, config.maxImagePixels)

    const result = await analyzeBoardImage(
      { image: bytes, mimeType: info.mimeType, previousSummary: metadata.data.previous_board_summary },
      config,
      { signal: request.signal },
    )

    return Response.json(
      {
        request_id: requestId,
        board_summary: result.board_summary,
        errors: result.errors,
        image_width: info.width,
        image_height: info.height,
        latency_ms: Math.max(0, Math.round(performance.now() - startedAt)),
      },
      { headers: NO_STORE },
    )
  } catch (err) {
    return toErrorResponse(err, requestId)
  }
}

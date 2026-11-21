import { loadConfig } from '../../../server/config'
import { NO_STORE, toErrorResponse } from '../../../server/errors'

export const dynamic = 'force-dynamic'

/** Reports whether keys are configured. Never probes upstream providers. */
export async function GET(): Promise<Response> {
  try {
    const config = loadConfig()
    return Response.json(
      {
        status: 'ok',
        analysis_configured: config.analysisConfigured,
        speech_configured: config.speechConfigured,
        credentials_verified: false,
      },
      { headers: NO_STORE },
    )
  } catch (err) {
    return toErrorResponse(err)
  }
}

// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GET as healthGET } from '../../app/api/health/route'
import { POST as analyzePOST } from '../../app/api/analyze/route'
import { POST as speechPOST } from '../../app/api/speech/route'
import { ConfigError, loadConfig } from '../../server/config'
import { ApiError } from '../../server/errors'
import { analyzeBoardImage, extractModelText, parseModelResult } from '../../server/gemini'
import { inspectImage } from '../../server/image'
import { openSpeechStream, prepareSpokenText, validateVoiceId } from '../../server/speech'

// Minimal valid JPEG header: SOI + SOF0 (32x16) + EOI.
const TINY_JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x20, 0x03, 0x01, 0x22, 0x00, 0x02,
  0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
])

const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174000'
const ENV = {
  GEMINI_API_KEY: 'g-secret',
  ELEVENLABS_API_KEY: 'el-secret',
  ELEVENLABS_VOICE_ID: 'JBFqnCBsd6RMkjVDRZzb',
}

const finding = (over: Record<string, unknown> = {}) => ({
  category: 'math',
  detected_text: '2 + 2 = 5',
  correction_text: '2 + 2 = 4',
  correction_latex: '$2+2=4$',
  spoken_alert: 'Two plus two equals four, not five.',
  explanation: 'The sum is four.',
  box_2d: [10, 10, 50, 50],
  confidence: 0.9,
  ...over,
})

const geminiOk = (errors: unknown[], extra: Record<string, unknown> = {}) =>
  Response.json({
    candidates: [
      {
        finishReason: 'STOP',
        content: { parts: [{ text: JSON.stringify({ board_summary: 'A sum.', errors }) }], ...extra },
      },
    ],
  })

function analyzeRequest(corners: unknown = null, image: Uint8Array = TINY_JPEG): Request {
  const form = new FormData()
  form.append('image', new File([image], 'snapshot.jpg', { type: 'image/jpeg' }))
  form.append(
    'metadata',
    JSON.stringify({ request_id: REQUEST_ID, previous_board_summary: '', corners }),
  )
  return new Request('http://localhost/api/analyze', { method: 'POST', body: form })
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('config', () => {
  it('applies defaults, detects configuration, and validates values', () => {
    const empty = loadConfig({})
    expect(empty.geminiModel).toBe('gemini-3.8-flash')
    expect(empty.analysisConfigured).toBe(false)
    expect(empty.speechConfigured).toBe(false)
    expect(loadConfig(ENV).analysisConfigured).toBe(true)
    expect(loadConfig(ENV).speechConfigured).toBe(true)
    expect(() => loadConfig({ GEMINI_THINKING_LEVEL: 'extreme' })).toThrow(ConfigError)
    expect(() => loadConfig({ ANALYSIS_CONFIDENCE_THRESHOLD: '2' })).toThrow(ConfigError)
    expect(() => loadConfig({ ANALYSIS_TIMEOUT_SECONDS: 'abc' })).toThrow(ConfigError)
  })
})

describe('speech text and voice id', () => {
  it('normalizes shorthand, strips brackets and control chars, and caps length', () => {
    const cleaned = prepareSpokenText('[urgent]\x07 Acceleration is 5 m/s^2 and x^2 + y^3, not 10 N/m.')
    expect(cleaned).not.toMatch(/[[\]\x07]/)
    expect(cleaned).toContain('meters per second squared')
    expect(cleaned).toContain('x squared')
    expect(cleaned).toContain('y cubed')
    expect(cleaned).toContain('Newtons per meter')
    expect(prepareSpokenText('word '.repeat(80)).length).toBeLessThanOrEqual(300)
    expect(prepareSpokenText('  [] \n\t ')).toBe('')
  })

  it('rejects unsafe voice ids', () => {
    expect(validateVoiceId('  voice_ABC-123  ')).toBe('voice_ABC-123')
    for (const bad of ['', '../etc/passwd', 'voice id', 'voice?a=1']) {
      expect(() => validateVoiceId(bad)).toThrow(ApiError)
    }
  })
})

describe('image inspection', () => {
  it('reads JPEG and PNG dimensions and rejects bad input', () => {
    expect(inspectImage(TINY_JPEG, 1_000_000)).toEqual({ mimeType: 'image/jpeg', width: 32, height: 16 })
    const png = new Uint8Array(24)
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    png.set([0, 0, 0, 7], 16)
    png.set([0, 0, 0, 5], 20)
    expect(inspectImage(png, 1_000_000)).toEqual({ mimeType: 'image/png', width: 7, height: 5 })
    expect(() => inspectImage(new Uint8Array(), 100)).toThrow(/empty/)
    expect(() => inspectImage(new Uint8Array([1, 2, 3, 4]), 100)).toThrow(/Unsupported/)
    expect(() => inspectImage(TINY_JPEG, 100)).toThrow(/exceeds/)
    expect(() => inspectImage(TINY_JPEG.slice(0, 6), 1_000_000)).toThrow(/corrupt/)
  })
})

describe('gemini analysis', () => {
  const config = loadConfig(ENV)
  const input = { image: TINY_JPEG, mimeType: 'image/jpeg', previousSummary: '' }

  it('filters findings below the confidence threshold and cleans latex delimiters', async () => {
    const fetchImpl = vi.fn(async () => geminiOk([finding(), finding({ confidence: 0.5 })]))
    const result = await analyzeBoardImage(input, config, { fetchImpl })
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.correction_latex).toBe('2+2=4')
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/models/gemini-3.8-flash:generateContent')
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('g-secret')
  })

  it('maps upstream errors to the envelope codes the client expects', async () => {
    const rate = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Please retry in 7s' } }), { status: 429 }))
    await expect(analyzeBoardImage(input, config, { fetchImpl: rate })).rejects.toMatchObject({
      status: 429,
      code: 'UPSTREAM_RATE_LIMITED',
      retryAfterSeconds: 7,
    })
    const auth = vi.fn(async () => new Response('{}', { status: 403 }))
    await expect(analyzeBoardImage(input, config, { fetchImpl: auth })).rejects.toMatchObject({
      code: 'UPSTREAM_AUTH_ERROR',
    })
  })

  it('retries a 503 exactly once', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(geminiOk([]))
    const result = await analyzeBoardImage(input, config, { fetchImpl, retryDelayMs: 1 })
    expect(result.errors).toEqual([])
    expect(fetchImpl).toHaveBeenCalledTimes(2)

    const always503 = vi.fn(async () => new Response('{}', { status: 503 }))
    await expect(analyzeBoardImage(input, config, { fetchImpl: always503, retryDelayMs: 1 })).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    })
    expect(always503).toHaveBeenCalledTimes(2)
  })

  it('rejects blocked, truncated, empty, and malformed output', () => {
    expect(() => extractModelText({ promptFeedback: { blockReason: 'SAFETY' } })).toThrow(/blocked/)
    expect(() => extractModelText({ candidates: [{ finishReason: 'MAX_TOKENS' }] })).toThrow(/truncated/)
    expect(() => extractModelText({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: ' ' }] } }] })).toThrow(/empty/)
    expect(() => extractModelText({ candidates: [] })).toThrow(/no candidate/)
    expect(() => parseModelResult('not json', 0.85)).toThrow(/malformed/)
    expect(() => parseModelResult(JSON.stringify({ board_summary: '', errors: [finding({ box_2d: [5, 5, 5, 5] })] }), 0.85)).toThrow(/schema/)
    expect(() => parseModelResult(JSON.stringify({ board_summary: '', errors: [], extra: 1 }), 0.85)).toThrow(/schema/)
  })

  it('ignores thought parts when assembling output', () => {
    const text = extractModelText({
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'hidden', thought: true }, { text: '{"a":1}' }] } }],
    })
    expect(text).toBe('{"a":1}')
  })
})

describe('speech streaming', () => {
  const config = loadConfig(ENV)

  it('opens a stream and maps provider failures', async () => {
    const ok = vi.fn(async () => new Response('mp3', { status: 200 }))
    const res = await openSpeechStream('hello [x]', config, { fetchImpl: ok })
    expect(res.status).toBe(200)
    const [url, init] = ok.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/text-to-speech/JBFqnCBsd6RMkjVDRZzb/stream?output_format=mp3_44100_128')
    expect(JSON.parse(String(init.body)).text).toBe('hello x')

    const fail = (status: number, detail?: unknown) =>
      openSpeechStream('hi', config, {
        fetchImpl: vi.fn(async () => new Response(JSON.stringify({ detail }), { status })),
      })
    await expect(fail(401)).rejects.toMatchObject({ code: 'SPEECH_AUTH_ERROR' })
    await expect(fail(402)).rejects.toMatchObject({ code: 'SPEECH_VOICE_PLAN_REQUIRED' })
    await expect(fail(400, { status: 'quota_exceeded' })).rejects.toMatchObject({ code: 'SPEECH_QUOTA_EXCEEDED', retryAfterSeconds: 60 })
    await expect(fail(429)).rejects.toMatchObject({ code: 'SPEECH_RATE_LIMITED' })
    await expect(fail(503)).rejects.toMatchObject({ code: 'SPEECH_UNAVAILABLE' })
    await expect(fail(500)).rejects.toMatchObject({ code: 'SPEECH_PROVIDER_ERROR' })
  })

  it('refuses when unconfigured', async () => {
    await expect(openSpeechStream('hi', loadConfig({}))).rejects.toMatchObject({ code: 'SPEECH_NOT_CONFIGURED' })
  })
})

describe('route handlers', () => {
  it('health reports configuration without secrets', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'g-secret')
    const res = await healthGET()
    const body = await res.json()
    expect(body).toEqual({ status: 'ok', analysis_configured: true, speech_configured: false, credentials_verified: false })
    expect(JSON.stringify(body)).not.toContain('g-secret')
  })

  it('analyze returns the client contract for an uncalibrated frame', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'g-secret')
    vi.stubGlobal('fetch', vi.fn(async () => geminiOk([finding()])))
    const res = await analyzePOST(analyzeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ request_id: REQUEST_ID, board_summary: 'A sum.', image_width: 32, image_height: 16 })
    expect(body.errors).toHaveLength(1)
    expect(body.latency_ms).toBeGreaterThanOrEqual(0)
  })

  it('analyze returns envelope errors with request ids', async () => {
    const noKey = await analyzePOST(analyzeRequest())
    expect(noKey.status).toBe(503)
    expect(await noKey.json()).toMatchObject({ code: 'ANALYSIS_NOT_CONFIGURED', request_id: REQUEST_ID })

    vi.stubEnv('GEMINI_API_KEY', 'g-secret')
    const calibrated = await analyzePOST(analyzeRequest([[0, 0], [1000, 0], [1000, 1000], [0, 1000]]))
    expect(calibrated.status).toBe(501)
    expect((await calibrated.json()).code).toBe('CALIBRATION_NOT_MIGRATED')

    const bad = await analyzePOST(analyzeRequest(null, new Uint8Array([1, 2, 3, 4])))
    expect(bad.status).toBe(415)

    const form = new FormData()
    form.append('metadata', '{"request_id":"nope"}')
    form.append('image', new File([TINY_JPEG], 'a.jpg'))
    const invalid = await analyzePOST(new Request('http://localhost/api/analyze', { method: 'POST', body: form }))
    expect(invalid.status).toBe(422)
    expect((await invalid.json()).code).toBe('INVALID_METADATA')
  })

  it('speech streams audio and never leaks the key', async () => {
    Object.entries(ENV).forEach(([k, v]) => vi.stubEnv(k, v))
    vi.stubGlobal('fetch', vi.fn(async () => new Response('mp3-bytes', { status: 200 })))
    const res = await speechPOST(
      new Request('http://localhost/api/speech', { method: 'POST', body: JSON.stringify({ text: 'Check the sign.' }) }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.text()).toBe('mp3-bytes')

    const invalid = await speechPOST(new Request('http://localhost/api/speech', { method: 'POST', body: '{}' }))
    expect(invalid.status).toBe(422)
    const huge = await speechPOST(
      new Request('http://localhost/api/speech', { method: 'POST', body: JSON.stringify({ text: 'x'.repeat(5000) }) }),
    )
    expect(huge.status).toBe(413)
  })
})

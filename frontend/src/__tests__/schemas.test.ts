import { describe, expect, it } from 'vitest'
import {
  AnalysisResponseSchema,
  ErrorEnvelopeSchema,
  HealthResponseSchema,
} from '../api/schemas'

describe('API Zod response schemas', () => {
  it('parses representative backend health and analysis fixtures', () => {
    const health = HealthResponseSchema.parse({
      status: 'ok',
      analysis_configured: true,
      deep_mode_configured: false,
      credentials_verified: false,
    })
    expect(health.analysis_configured).toBe(true)
    expect(health.deep_mode_configured).toBe(false)

    const analysis = AnalysisResponseSchema.parse({
      request_id: '11111111-2222-4333-8444-555555555555',
      board_summary: 'Projectile kinematics derivation',
      errors: [
        {
          category: 'physics',
          detected_text: 'F = 10 N/m',
          correction_text: 'F = 10 N',
          correction_latex: 'F = 10\\,\\mathrm{N}',
          spoken_alert: 'Force uses Newtons rather than Newtons per meter.',
          explanation: 'Mass in kilograms times acceleration in m/s^2 yields Newtons.',
          box_2d: [220, 140, 310, 480],
          confidence: 0.93,
        },
      ],
      image_width: 1280,
      image_height: 720,
      latency_ms: 412,
    })
    expect(analysis.errors).toHaveLength(1)
    expect(analysis.errors[0]?.box_2d).toEqual([220, 140, 310, 480])

    const envelope = ErrorEnvelopeSchema.parse({
      code: 'UPSTREAM_TIMEOUT',
      message: 'Analysis timed out.',
      request_id: '11111111-2222-4333-8444-555555555555',
    })
    expect(envelope.code).toBe('UPSTREAM_TIMEOUT')
  })

  it('rejects malformed or out-of-contract backend payloads', () => {
    expect(() =>
      AnalysisResponseSchema.parse({
        request_id: 'not-a-uuid',
        board_summary: 'x',
        errors: [],
        image_width: 1280,
        image_height: 720,
        latency_ms: 10,
      }),
    ).toThrow()

    expect(() =>
      AnalysisResponseSchema.parse({
        request_id: '11111111-2222-4333-8444-555555555555',
        board_summary: 'x',
        errors: [
          {
            category: 'math',
            detected_text: '1+1=3',
            correction_text: '1+1=2',
            correction_latex: null,
            spoken_alert: 'One plus one is two.',
            explanation: 'Simple sum.',
            box_2d: [300, 100, 200, 400], // ymin >= ymax invalid
            confidence: 0.95,
          },
        ],
        image_width: 1280,
        image_height: 720,
        latency_ms: 10,
      }),
    ).toThrow()
  })
})

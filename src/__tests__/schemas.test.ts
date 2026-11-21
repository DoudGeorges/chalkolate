import { describe, expect, it } from 'vitest'
import {
  AnalysisResponseSchema,
  BoardDetectionResponseSchema,
  ErrorEnvelopeSchema,
  HealthResponseSchema,
} from '../api/schemas'

describe('API Zod response schemas', () => {
  it('parses representative backend health and analysis fixtures', () => {
    const health = HealthResponseSchema.parse({
      status: 'ok',
      analysis_configured: true,
      speech_configured: true,
      credentials_verified: false,
    })
    expect(health.analysis_configured).toBe(true)
    expect(health.speech_configured).toBe(true)

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

    const boardDetected = BoardDetectionResponseSchema.parse({
      detected: true,
      corners: [
        [100, 120],
        [900, 110],
        [910, 880],
        [90, 890],
      ],
      confidence: 0.87,
    })
    expect(boardDetected.detected).toBe(true)
    expect(boardDetected.corners).toHaveLength(4)

    const boardFallback = BoardDetectionResponseSchema.parse({
      detected: false,
      corners: null,
      confidence: 0,
    })
    expect(boardFallback.detected).toBe(false)
  })

  it('rejects malformed, removed, or out-of-contract payloads', () => {
    // Removed deep_mode_configured is rejected by strict HealthResponseSchema
    expect(() =>
      HealthResponseSchema.parse({
        status: 'ok',
        analysis_configured: true,
        deep_mode_configured: false,
        credentials_verified: false,
      }),
    ).toThrow()

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
        board_summary: 'x'.repeat(601),
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
            box_2d: [300, 100, 200, 400],
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

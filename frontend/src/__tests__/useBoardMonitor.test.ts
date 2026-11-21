import { act, renderHook } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '../api/client'
import { AnalysisMetadataPayload, AnalysisResponse } from '../api/schemas'
import {
  BoardMonitorDeps,
  MAX_CHANGE_WAIT_MS,
  MIN_DISPATCH_GAP_MS,
  SAMPLE_INTERVAL_MS,
  VERIFY_RECHECK_DELAY_MS,
  useBoardMonitor,
} from '../hooks/useBoardMonitor'
import { GrayscaleSample } from '../lib/frameCapture'

function makeSample(fill = 30, width = 160, height = 96): GrayscaleSample {
  return { width, height, data: new Uint8Array(width * height).fill(fill) }
}

function drawBlock(
  base: GrayscaleSample,
  x0: number,
  y0: number,
  w: number,
  h: number,
  value: number,
): GrayscaleSample {
  const data = new Uint8Array(base.data)
  for (let y = y0; y < Math.min(base.height, y0 + h); y++) {
    for (let x = x0; x < Math.min(base.width, x0 + w); x++) {
      data[y * base.width + x] = value
    }
  }
  return { width: base.width, height: base.height, data }
}

function makeResponse(
  requestId: string,
  summary = 'Board summary',
  errorText?: string,
): AnalysisResponse {
  return {
    request_id: requestId,
    board_summary: summary,
    errors: errorText
      ? [
          {
            category: 'math',
            detected_text: errorText,
            correction_text: 'corrected',
            correction_latex: null,
            spoken_alert: 'Correction needed.',
            explanation: 'Demonstrable mistake.',
            box_2d: [100, 100, 200, 300],
            confidence: 0.95,
          },
        ]
      : [],
    image_width: 1280,
    image_height: 720,
    latency_ms: 25,
  }
}

describe('useBoardMonitor near-real-time pipeline', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('stays idle when stopped by default and runs immediately upon Start without repeating static frames', async () => {
    let clock = 1000
    let seq = 0
    const sample = makeSample(35)
    const sampleSpy = vi.fn(() => sample)
    const analyzeSpy = vi.fn(async (_b: Blob, meta: AnalysisMetadataPayload) =>
      makeResponse(meta.request_id, 'First frame', '1+1=3'),
    )
    const spokenIds: string[] = []

    const fakeSource = document.createElement('canvas')
    const { result, rerender } = renderHook(
      (props: { monitoring: boolean }) =>
        useBoardMonitor({
          mediaSource: fakeSource,
          mediaReady: true,
          sourceGeneration: 1,
          monitoring: props.monitoring,
          calibrationEditing: false,
          committedCorners: null,
          onNewFindings: (issues) => {
            for (const i of issues) spokenIds.push(i.id)
          },
          deps: {
            now: () => clock,
            createUuid: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
            sampleFrame: sampleSpy,
            captureSnapshot: async () => ({ blob: new Blob(['jpg']), width: 1280, height: 720 }),
            analyzeRequest: analyzeSpy,
          },
        }),
      { initialProps: { monitoring: false } },
    )

    expect(result.current.state.phase).toBe('STOPPED')
    act(() => {
      clock += 2000
      vi.advanceTimersByTime(2000)
    })
    expect(sampleSpy).not.toHaveBeenCalled()
    expect(analyzeSpy).not.toHaveBeenCalled()

    await act(async () => {
      rerender({ monitoring: true })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(analyzeSpy).toHaveBeenCalledTimes(1)
    expect(spokenIds).toHaveLength(1)
    expect(spokenIds[0]).toBe(result.current.state.tracker.issues[0]?.id)

    await act(async () => {
      for (let i = 0; i < 12; i++) {
        clock += SAMPLE_INTERVAL_MS
        vi.advanceTimersByTime(SAMPLE_INTERVAL_MS)
        await Promise.resolve()
      }
    })
    expect(analyzeSpy).toHaveBeenCalledTimes(1)
  })

  it('detects a persistent board edit promptly even while another region keeps moving', async () => {
    let clock = 5000
    let seq = 0
    const base = makeSample(30)
    let currentFrame = base
    let calls = 0

    const deps: Partial<BoardMonitorDeps> = {
      now: () => clock,
      createUuid: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
      sampleFrame: () => currentFrame,
      captureSnapshot: async () => ({ blob: new Blob(['jpg']), width: 1280, height: 720 }),
      analyzeRequest: async (_b, meta) => {
        calls += 1
        return makeResponse(meta.request_id, `Call #${calls}`, '2+2=5')
      },
    }

    const fakeSource = document.createElement('canvas')
    renderHook(() =>
      useBoardMonitor({
        mediaSource: fakeSource,
        mediaReady: true,
        sourceGeneration: 1,
        monitoring: true,
        calibrationEditing: false,
        committedCorners: null,
        deps,
      }),
    )

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(calls).toBe(1)

    clock += MIN_DISPATCH_GAP_MS + 50
    for (let t = 0; t < 7; t++) {
      const withStroke = drawBlock(base, 16, 16, 8, 6, 160)
      currentFrame = drawBlock(withStroke, 96 + ((t * 17) % 32), 48, 16, 16, 140)
      await act(async () => {
        clock += SAMPLE_INTERVAL_MS
        vi.advanceTimersByTime(SAMPLE_INTERVAL_MS)
        await Promise.resolve()
        await Promise.resolve()
      })
    }
    expect(calls).toBe(2)
    expect(MAX_CHANGE_WAIT_MS).toBeLessThanOrEqual(1500)
  })

  it('automatically resolves a corrected finding via edited-region check AND quiet verification recheck', async () => {
    let clock = 8000
    let seq = 0
    const base = makeSample(30)
    let currentFrame = base
    let calls = 0
    let returnError = true

    const fakeSource = document.createElement('canvas')
    const { result } = renderHook(() =>
      useBoardMonitor({
        mediaSource: fakeSource,
        mediaReady: true,
        sourceGeneration: 1,
        monitoring: true,
        calibrationEditing: false,
        committedCorners: null,
        deps: {
          now: () => clock,
          createUuid: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
          sampleFrame: () => currentFrame,
          captureSnapshot: async () => ({ blob: new Blob(['jpg']), width: 1280, height: 720 }),
          analyzeRequest: async (_b, meta) => {
            calls += 1
            return makeResponse(
              meta.request_id,
              returnError ? 'Mistake present' : 'Mistake fixed',
              returnError ? '(a+b)^2 = a^2 + b^2' : undefined,
            )
          },
        },
      }),
    )

    // Initial detection opens 1 issue at box [100, 100, 200, 300] (sample px x=16..48, y=9..19)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(calls).toBe(1)
    expect(result.current.state.tracker.issues.filter((i) => i.status === 'open')).toHaveLength(1)

    // Case A: Subtle edit elsewhere triggers analysis where mistake disappears while box pixels
    // barely changed -> 1st miss holds open, then automatic quiet verification resolves it without new motion!
    returnError = false
    currentFrame = drawBlock(base, 110, 60, 14, 14, 180) // outside box [100,100,200,300]
    clock += MIN_DISPATCH_GAP_MS + 50
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        clock += SAMPLE_INTERVAL_MS
        vi.advanceTimersByTime(SAMPLE_INTERVAL_MS)
        await Promise.resolve()
        await Promise.resolve()
      })
    }
    expect(calls).toBe(2)
    // Still open after 1 unchanged miss (flicker protection), awaiting quiet verification
    expect(result.current.state.tracker.issues.filter((i) => i.status === 'open')).toHaveLength(1)
    expect(result.current.state.tracker.issues[0]?.missCount).toBe(1)

    // Advance past VERIFY_RECHECK_DELAY_MS with NO further board motion -> automatic recheck resolves it!
    await act(async () => {
      clock += VERIFY_RECHECK_DELAY_MS + SAMPLE_INTERVAL_MS
      vi.advanceTimersByTime(SAMPLE_INTERVAL_MS)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(calls).toBe(3)
    expect(result.current.state.tracker.issues.filter((i) => i.status === 'open')).toHaveLength(0)
    expect(result.current.state.tracker.issues[0]?.status).toBe('resolved')

    // No further polling calls once resolved
    await act(async () => {
      for (let i = 0; i < 10; i++) {
        clock += SAMPLE_INTERVAL_MS
        vi.advanceTimersByTime(SAMPLE_INTERVAL_MS)
        await Promise.resolve()
      }
    })
    expect(calls).toBe(3)
  })

  it('commits results even when motion occurred mid-flight, and discards on Stop', async () => {
    let clock = 10_000
    let seq = 0
    let currentFrame = makeSample(30)
    const pending: Array<{
      meta: AnalysisMetadataPayload
      resolve: (r: AnalysisResponse) => void
      signal: AbortSignal
    }> = []
    const speechSpy = vi.fn()
    const invalidateSpy = vi.fn()

    const fakeSource = document.createElement('canvas')
    const { result, rerender } = renderHook(
      (props: { monitoring: boolean }) =>
        useBoardMonitor({
          mediaSource: fakeSource,
          mediaReady: true,
          sourceGeneration: 1,
          monitoring: props.monitoring,
          calibrationEditing: false,
          committedCorners: null,
          onNewFindings: speechSpy,
          onInvalidateSpeech: invalidateSpy,
          deps: {
            now: () => clock,
            createUuid: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
            sampleFrame: () => currentFrame,
            captureSnapshot: async () => ({ blob: new Blob(['jpg']), width: 1280, height: 720 }),
            analyzeRequest: (_b, meta, signal) =>
              new Promise<AnalysisResponse>((resolve, reject) => {
                signal.addEventListener('abort', () =>
                  reject(new DOMException('Aborted', 'AbortError')),
                )
                pending.push({ meta, resolve, signal })
              }),
          },
        }),
      { initialProps: { monitoring: true } },
    )

    await act(async () => {
      await Promise.resolve()
    })
    expect(pending).toHaveLength(1)

    currentFrame = drawBlock(currentFrame, 20, 20, 20, 20, 180)
    act(() => {
      clock += SAMPLE_INTERVAL_MS
      vi.advanceTimersByTime(SAMPLE_INTERVAL_MS)
    })
    expect(pending[0]?.signal.aborted).toBe(false)

    await act(async () => {
      pending[0]!.resolve(makeResponse(pending[0]!.meta.request_id, 'Live board', 'F=10 N/m'))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.state.tracker.issues.filter((i) => i.status === 'open')).toHaveLength(1)
    expect(speechSpy).toHaveBeenCalledTimes(1)

    act(() => {
      result.current.requestCheckNow()
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(pending).toHaveLength(2)

    rerender({ monitoring: false })
    expect(pending[1]?.signal.aborted).toBe(true)
    expect(invalidateSpy).toHaveBeenCalled()
    expect(result.current.state.phase).toBe('STOPPED')
    expect(result.current.state.tracker.issues.filter((i) => i.status === 'open')).toHaveLength(1)
  })

  it('keeps findings on API failure, respects Retry-After backoff, and retries pending changes', async () => {
    let clock = 20_000
    let seq = 0
    let failNext = false
    let calls = 0
    let currentFrame = makeSample(30)

    const fakeSource = document.createElement('canvas')
    const { result } = renderHook(() =>
      useBoardMonitor({
        mediaSource: fakeSource,
        mediaReady: true,
        sourceGeneration: 1,
        monitoring: true,
        calibrationEditing: false,
        committedCorners: null,
        deps: {
          now: () => clock,
          createUuid: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
          sampleFrame: () => currentFrame,
          captureSnapshot: async () => ({ blob: new Blob(['jpg']), width: 1280, height: 720 }),
          analyzeRequest: async (_b, meta) => {
            calls += 1
            if (failNext) {
              throw new ApiClientError('Busy', {
                code: 'UPSTREAM_UNAVAILABLE',
                status: 503,
                retryAfterSeconds: 4,
              })
            }
            return makeResponse(meta.request_id, 'Found error', 'Acceleraton')
          },
        },
      }),
    )

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(calls).toBe(1)
    expect(result.current.state.tracker.issues).toHaveLength(1)

    failNext = true
    currentFrame = drawBlock(currentFrame, 20, 20, 12, 12, 180)
    clock += MIN_DISPATCH_GAP_MS
    await act(async () => {
      for (let i = 0; i < 5; i++) {
        clock += SAMPLE_INTERVAL_MS
        vi.advanceTimersByTime(SAMPLE_INTERVAL_MS)
        await Promise.resolve()
        await Promise.resolve()
      }
    })
    expect(calls).toBe(2)
    expect(result.current.state.apiError?.retryAfterSeconds).toBe(4)
    expect(result.current.state.tracker.issues.filter((i) => i.status === 'open')).toHaveLength(1)

    await act(async () => {
      for (let i = 0; i < 8; i++) {
        clock += SAMPLE_INTERVAL_MS
        vi.advanceTimersByTime(SAMPLE_INTERVAL_MS)
        await Promise.resolve()
      }
    })
    expect(calls).toBe(2)

    failNext = false
    await act(async () => {
      clock += 3000
      vi.advanceTimersByTime(SAMPLE_INTERVAL_MS)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(calls).toBe(3)
    expect(result.current.state.apiError).toBeNull()
  })

  it('maintains single-flight + manual precedence and one loop under React StrictMode', async () => {
    let clock = 30_000
    let seq = 0
    const pending: Array<{
      meta: AnalysisMetadataPayload
      resolve: (r: AnalysisResponse) => void
    }> = []
    const sampleSpy = vi.fn(() => makeSample(40))
    const fakeSource = document.createElement('canvas')

    const { result, unmount } = renderHook(
      () =>
        useBoardMonitor({
          mediaSource: fakeSource,
          mediaReady: true,
          sourceGeneration: 1,
          monitoring: true,
          calibrationEditing: false,
          committedCorners: null,
          deps: {
            now: () => clock,
            createUuid: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
            sampleFrame: sampleSpy,
            captureSnapshot: async () => ({ blob: new Blob(['jpg']), width: 1280, height: 720 }),
            analyzeRequest: (_b, meta) =>
              new Promise<AnalysisResponse>((resolve) => {
                pending.push({ meta, resolve })
              }),
          },
        }),
      { wrapper: StrictMode },
    )

    await act(async () => {
      await Promise.resolve()
    })
    expect(pending).toHaveLength(1)

    sampleSpy.mockClear()
    act(() => {
      clock += SAMPLE_INTERVAL_MS * 3
      vi.advanceTimersByTime(SAMPLE_INTERVAL_MS * 3)
    })
    expect(sampleSpy).toHaveBeenCalledTimes(3)

    act(() => {
      result.current.requestCheckNow()
      result.current.requestCheckNow()
    })
    expect(pending).toHaveLength(1)

    await act(async () => {
      pending[0]!.resolve(makeResponse(pending[0]!.meta.request_id))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(pending).toHaveLength(2)

    unmount()
  })
<<<<<<< HEAD

  it('dispatches follow-up analysis quickly when new board writing settles while a request is in flight', async () => {
    let clock = 40_000
    let seq = 0
    const base = makeSample(30)
    let currentFrame = base
    const pending: Array<{
      meta: AnalysisMetadataPayload
      resolve: (r: AnalysisResponse) => void
    }> = []

    const fakeSource = document.createElement('canvas')
    renderHook(() =>
      useBoardMonitor({
        mediaSource: fakeSource,
        mediaReady: true,
        sourceGeneration: 1,
        monitoring: true,
        calibrationEditing: false,
        committedCorners: null,
        deps: {
          now: () => clock,
          createUuid: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
          sampleFrame: () => currentFrame,
          captureSnapshot: async () => ({ blob: new Blob(['jpg']), width: 1280, height: 720 }),
          analyzeRequest: (_b, meta) =>
            new Promise<AnalysisResponse>((resolve) => {
              pending.push({ meta, resolve })
            }),
        },
      }),
    )

    await act(async () => {
      await Promise.resolve()
    })
    expect(pending).toHaveLength(1)

    // Write a settled stroke while request 1 is still in flight (>= STILL_TICKS_FOR_PERSISTENCE calm ticks).
    currentFrame = drawBlock(base, 18, 18, 10, 8, 170)
    for (let i = 0; i < 4; i++) {
      act(() => {
        clock += SAMPLE_INTERVAL_MS
        vi.advanceTimersByTime(SAMPLE_INTERVAL_MS)
      })
    }
    expect(pending).toHaveLength(1)

    // Resolving request 1 schedules an immediate follow-up without waiting for a full gap/poll cycle.
    await act(async () => {
      pending[0]!.resolve(makeResponse(pending[0]!.meta.request_id, 'Initial empty'))
      await Promise.resolve()
      await Promise.resolve()
      clock += 70
      vi.advanceTimersByTime(70)
      await Promise.resolve()
    })
    expect(pending).toHaveLength(2)
  })
=======
>>>>>>> origin/main
})

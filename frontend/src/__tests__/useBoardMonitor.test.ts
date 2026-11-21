import { act, renderHook } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '../api/client'
import { AnalysisMetadataPayload, AnalysisResponse, SubjectHint } from '../api/schemas'
import {
  BoardMonitorDeps,
  SAMPLE_INTERVAL_MS,
  useBoardMonitor,
} from '../hooks/useBoardMonitor'
import { GrayscaleSample } from '../lib/frameCapture'

function constantSample(fill: number, width = 16, height = 9): GrayscaleSample {
  return {
    width,
    height,
    data: new Uint8Array(width * height).fill(fill),
  }
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

describe('useBoardMonitor state machine and scheduling invariants', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('triggers first stable frame once, skips unchanged frames, and reacts to cumulative edits', async () => {
    let clock = 1000
    let currentLuma = 20
    let seq = 0
    const analyzedPayloads: AnalysisMetadataPayload[] = []
    const spokenIssueIds: string[] = []

    const deps: Partial<BoardMonitorDeps> = {
      now: () => clock,
      createUuid: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
      sampleFrame: () => constantSample(currentLuma),
      captureSnapshot: async () => ({ blob: new Blob(['jpg']), width: 1280, height: 720 }),
      analyzeRequest: async (_blob, meta) => {
        analyzedPayloads.push(meta)
        return makeResponse(meta.request_id, `Summary #${analyzedPayloads.length}`, 'x^2')
      },
    }

    const fakeSource = document.createElement('canvas')
    const { result } = renderHook(() =>
      useBoardMonitor({
        mediaSource: fakeSource,
        mediaReady: true,
        sourceGeneration: 1,
        paused: false,
        calibrationEditing: false,
        committedCorners: null,
        subjectHint: 'auto',
        deepMode: false,
        enhanceChalkboard: false,
        stabilizationMs: 1200,
        onAcceptedFindings: (issues) => {
          for (const item of issues) spokenIssueIds.push(item.id)
        },
        deps,
      }),
    )

    expect(result.current.state.phase).toBe('STABILIZING')
    expect(analyzedPayloads).toHaveLength(0)

    // Advance past 1200ms quiet window
    await act(async () => {
      for (let i = 0; i < 4; i++) {
        clock += SAMPLE_INTERVAL_MS
        vi.advanceTimersByTime(SAMPLE_INTERVAL_MS)
        await Promise.resolve()
      }
    })
    expect(analyzedPayloads).toHaveLength(1)
    expect(result.current.state.phase).toBe('WATCHING')
    expect(spokenIssueIds).toHaveLength(1)
    expect(spokenIssueIds[0]).toBe(result.current.state.tracker.issues[0]?.id)

    // Unchanged scene for several seconds must NOT re-trigger Gemini
    await act(async () => {
      for (let i = 0; i < 10; i++) {
        clock += SAMPLE_INTERVAL_MS
        vi.advanceTimersByTime(SAMPLE_INTERVAL_MS)
        await Promise.resolve()
      }
    })
    expect(analyzedPayloads).toHaveLength(1)

    // Gradual small edits (+2 luma per tick) exceed QUIET_DRIFT_MAD (5.5) and eventually accumulate
    currentLuma = 22
    await act(async () => {
      clock += SAMPLE_INTERVAL_MS
      vi.advanceTimersByTime(SAMPLE_INTERVAL_MS)
    })
    currentLuma = 24
    await act(async () => {
      clock += SAMPLE_INTERVAL_MS
      vi.advanceTimersByTime(SAMPLE_INTERVAL_MS)
    })
    currentLuma = 26
    await act(async () => {
      clock += SAMPLE_INTERVAL_MS
      vi.advanceTimersByTime(SAMPLE_INTERVAL_MS)
    })
    // Now quiet at 26 (cumulative delta = 6 >= 5.0)
    expect(result.current.state.phase).toBe('WRITING')

    await act(async () => {
      for (let i = 0; i < 8; i++) {
        clock += SAMPLE_INTERVAL_MS
        vi.advanceTimersByTime(SAMPLE_INTERVAL_MS)
        await Promise.resolve()
      }
    })
    expect(analyzedPayloads).toHaveLength(2)
  })

  it('rejects stale in-flight completions on motion, pause, or setting changes and keeps manual precedence', async () => {
    let clock = 10_000
    let currentLuma = 30
    let uuidSeq = 0
    const pendingResolvers: Array<{
      meta: AnalysisMetadataPayload
      resolve: (res: AnalysisResponse) => void
      signal: AbortSignal
    }> = []

    const acceptedSpeech = vi.fn()
    const invalidatedSpeech = vi.fn()

    const deps: Partial<BoardMonitorDeps> = {
      now: () => clock,
      createUuid: () => `00000000-0000-4000-8000-${String(++uuidSeq).padStart(12, '0')}`,
      sampleFrame: () => constantSample(currentLuma),
      captureSnapshot: async () => ({ blob: new Blob(['jpg']), width: 1280, height: 720 }),
      analyzeRequest: (_blob, meta, signal) =>
        new Promise<AnalysisResponse>((resolve, reject) => {
          signal.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          )
          pendingResolvers.push({ meta, resolve, signal })
        }),
    }

    const fakeSource = document.createElement('canvas')
    const { result, rerender } = renderHook(
      (props: { paused: boolean; subjectHint: SubjectHint }) =>
        useBoardMonitor({
          mediaSource: fakeSource,
          mediaReady: true,
          sourceGeneration: 1,
          paused: props.paused,
          calibrationEditing: false,
          committedCorners: null,
          subjectHint: props.subjectHint,
          deepMode: false,
          enhanceChalkboard: false,
          stabilizationMs: 800,
          onAcceptedFindings: acceptedSpeech,
          onInvalidateSpeech: invalidatedSpeech,
          deps,
        }),
      { initialProps: { paused: false, subjectHint: 'auto' as SubjectHint } },
    )

    // Trigger manual Check Now immediately
    act(() => {
      result.current.requestCheckNow()
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(pendingResolvers).toHaveLength(1)
    expect(result.current.state.phase).toBe('ANALYZING')

    // Motion occurs mid-request: must NOT abort request, must mark stale & invalidate speech
    currentLuma = 90
    act(() => {
      clock += SAMPLE_INTERVAL_MS
      vi.advanceTimersByTime(SAMPLE_INTERVAL_MS)
    })
    expect(pendingResolvers[0]?.signal.aborted).toBe(false)
    expect(invalidatedSpeech).toHaveBeenCalled()

    // Old response resolves late after motion -> MUST NOT commit findings or speech
    await act(async () => {
      pendingResolvers[0]!.resolve(
        makeResponse(pendingResolvers[0]!.meta.request_id, 'Old frame', 'stale error'),
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.state.boardSummary).toBe('')
    expect(acceptedSpeech).not.toHaveBeenCalled()

    // Setting change invalidates & queues fresh check; pause aborts active request cleanly
    rerender({ paused: false, subjectHint: 'physics' })
    act(() => {
      result.current.requestCheckNow()
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(pendingResolvers).toHaveLength(2)
    expect(pendingResolvers[1]?.meta.subject_hint).toBe('physics')

    rerender({ paused: true, subjectHint: 'physics' })
    expect(pendingResolvers[1]?.signal.aborted).toBe(true)
    expect(result.current.state.phase).toBe('PAUSED')
  })

  it('prevents retry storms on failed frames and honors Retry-After', async () => {
    let clock = 5000
    let seq = 0
    let failNext = true
    let calls = 0

    const deps: Partial<BoardMonitorDeps> = {
      now: () => clock,
      createUuid: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
      sampleFrame: () => constantSample(40),
      captureSnapshot: async () => ({ blob: new Blob(['jpg']), width: 1280, height: 720 }),
      analyzeRequest: async (_blob, meta) => {
        calls += 1
        if (failNext) {
          throw new ApiClientError('Rate limit', {
            code: 'UPSTREAM_RATE_LIMITED',
            status: 429,
            retryAfterSeconds: 5,
          })
        }
        return makeResponse(meta.request_id, 'Recovered')
      },
    }

    const fakeSource = document.createElement('canvas')
    const { result } = renderHook(() =>
      useBoardMonitor({
        mediaSource: fakeSource,
        mediaReady: true,
        sourceGeneration: 1,
        paused: false,
        calibrationEditing: false,
        committedCorners: null,
        subjectHint: 'auto',
        deepMode: false,
        enhanceChalkboard: false,
        stabilizationMs: 800,
        deps,
      }),
    )

    // First stable frame runs and fails with 429
    await act(async () => {
      for (let i = 0; i < 4; i++) {
        clock += SAMPLE_INTERVAL_MS
        vi.advanceTimersByTime(SAMPLE_INTERVAL_MS)
        await Promise.resolve()
      }
    })
    expect(calls).toBe(1)
    expect(result.current.state.apiError?.code).toBe('UPSTREAM_RATE_LIMITED')

    // Subsequent ticks on same failed frame do NOT auto-retry
    await act(async () => {
      for (let i = 0; i < 15; i++) {
        clock += SAMPLE_INTERVAL_MS
        vi.advanceTimersByTime(SAMPLE_INTERVAL_MS)
        await Promise.resolve()
      }
    })
    expect(calls).toBe(1)

    // Explicit Retry runs immediately and succeeds
    failNext = false
    await act(async () => {
      result.current.requestCheckNow()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(calls).toBe(2)
    expect(result.current.state.apiError).toBeNull()
    expect(result.current.state.boardSummary).toBe('Recovered')
  })

  it('leaves exactly one active sampling loop under React StrictMode', () => {
    const sampleSpy = vi.fn(() => constantSample(50))
    const fakeSource = document.createElement('canvas')

    const { unmount } = renderHook(
      () =>
        useBoardMonitor({
          mediaSource: fakeSource,
          mediaReady: true,
          sourceGeneration: 1,
          paused: false,
          calibrationEditing: false,
          committedCorners: null,
          subjectHint: 'auto',
          deepMode: false,
          enhanceChalkboard: false,
          stabilizationMs: 5000,
          deps: {
            sampleFrame: sampleSpy,
          },
        }),
      { wrapper: StrictMode },
    )

    sampleSpy.mockClear()
    act(() => {
      vi.advanceTimersByTime(SAMPLE_INTERVAL_MS * 3)
    })
    // Exactly 1 active interval => 3 samples over 3 intervals (not 6!)
    expect(sampleSpy).toHaveBeenCalledTimes(3)

    unmount()
    sampleSpy.mockClear()
    act(() => {
      vi.advanceTimersByTime(SAMPLE_INTERVAL_MS * 3)
    })
    expect(sampleSpy).toHaveBeenCalledTimes(0)
  })

  it('coalesces pending intents with manual precedence and ignores late encoding after pause', async () => {
    let clock = 20_000
    let currentLuma = 30
    let seq = 0
    const pendingRequests: Array<{
      meta: AnalysisMetadataPayload
      resolve: (res: AnalysisResponse) => void
    }> = []

    const deps: Partial<BoardMonitorDeps> = {
      now: () => clock,
      createUuid: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
      sampleFrame: () => constantSample(currentLuma),
      captureSnapshot: async () => ({ blob: new Blob(['jpg']), width: 1280, height: 720 }),
      analyzeRequest: (_blob, meta) =>
        new Promise<AnalysisResponse>((resolve) => {
          pendingRequests.push({ meta, resolve })
        }),
    }

    const fakeSource = document.createElement('canvas')
    const { result } = renderHook(() =>
      useBoardMonitor({
        mediaSource: fakeSource,
        mediaReady: true,
        sourceGeneration: 1,
        paused: false,
        calibrationEditing: false,
        committedCorners: null,
        subjectHint: 'auto',
        deepMode: false,
        enhanceChalkboard: false,
        stabilizationMs: 5000,
        deps,
      }),
    )

    // Start request #1 manually
    act(() => {
      result.current.requestCheckNow()
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(pendingRequests).toHaveLength(1)

    // Motion queues auto recheck, then manual requestCheckNow overrides it cleanly
    currentLuma = 85
    act(() => {
      clock += SAMPLE_INTERVAL_MS
      vi.advanceTimersByTime(SAMPLE_INTERVAL_MS)
      result.current.requestCheckNow()
      result.current.requestCheckNow()
    })
    expect(pendingRequests).toHaveLength(1)

    // Settle request #1 -> coalesced manual request #2 dispatches immediately without waiting 5s
    await act(async () => {
      pendingRequests[0]!.resolve(makeResponse(pendingRequests[0]!.meta.request_id, 'Old'))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(pendingRequests).toHaveLength(2)

    // Slow canvas encoding resolving after source change must NOT invoke analyzeRequest
    let resolveEncoding!: (v: { blob: Blob; width: number; height: number }) => void
    const analyzeSpy = vi.fn(async (_b: Blob, meta: AnalysisMetadataPayload) =>
      makeResponse(meta.request_id),
    )

    const { result: encResult, rerender: encRerender } = renderHook(
      (props: { paused: boolean }) =>
        useBoardMonitor({
          mediaSource: fakeSource,
          mediaReady: true,
          sourceGeneration: 2,
          paused: props.paused,
          calibrationEditing: false,
          committedCorners: null,
          subjectHint: 'auto',
          deepMode: false,
          enhanceChalkboard: false,
          stabilizationMs: 1000,
          deps: {
            now: () => clock,
            createUuid: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
            sampleFrame: () => constantSample(40),
            captureSnapshot: () =>
              new Promise((resolve) => {
                resolveEncoding = resolve
              }),
            analyzeRequest: analyzeSpy,
          },
        }),
      { initialProps: { paused: false } },
    )

    act(() => {
      encResult.current.requestCheckNow()
    })
    encRerender({ paused: true })
    await act(async () => {
      resolveEncoding({ blob: new Blob(['late']), width: 1280, height: 720 })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(analyzeSpy).not.toHaveBeenCalled()
    expect(encResult.current.state.phase).toBe('PAUSED')
  })
})

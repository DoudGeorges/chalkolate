import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '../api/client'
import { BROWSER_SPEECH_START_TIMEOUT_MS, useSpeechAlerts } from '../hooks/useSpeechAlerts'

interface FakeUtterance {
  text: string
  rate: number
  pitch: number
  onstart: (() => void) | null
  onend: (() => void) | null
  onerror: ((event: { error: string }) => void) | null
}

function makeFakeBrowserSpeech() {
  const spokenQueue: FakeUtterance[] = []
  const cancelMock = vi.fn()

  class MockUtterance implements FakeUtterance {
    text: string
    rate = 1
    pitch = 1
    onstart: (() => void) | null = null
    onend: (() => void) | null = null
    onerror: ((event: { error: string }) => void) | null = null
    constructor(text: string) {
      this.text = text
    }
  }

  Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', {
    configurable: true,
    value: MockUtterance,
  })
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: {
      speak: (u: FakeUtterance) => {
        spokenQueue.push(u)
      },
      cancel: cancelMock,
    },
  })

  return { spokenQueue, cancelMock }
}

describe('useSpeechAlerts', () => {
  const originalSynth = window.speechSynthesis
  const originalUtterance = globalThis.SpeechSynthesisUtterance

  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  })

  afterEach(() => {
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: originalSynth,
    })
    Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', {
      configurable: true,
      value: originalUtterance,
    })
  })

  it('operates silently without blocking when neither ElevenLabs nor browser speech is available', () => {
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: undefined,
    })

    const { result } = renderHook(() => useSpeechAlerts())
    expect(result.current.isSupported).toBe(false)
    expect(result.current.speechError).toMatch(/unavailable/i)

    act(() => {
      result.current.enqueueAutoAlerts([{ id: '1', spoken_alert: 'Check units.' }])
    })
    expect(result.current.isSpeaking).toBe(false)
  })

  it('uses ElevenLabs streaming first, deduplicates, supports manual replay, and aborts cleanly on cancelAll', async () => {
    const { spokenQueue, cancelMock } = makeFakeBrowserSpeech()
    const requestCalls: string[] = []
    const startedIds: string[] = []
    let resolvePendingReq: ((res: Response) => void) | null = null
    const pendingState: { signal: AbortSignal | null } = { signal: null }

    const { result } = renderHook(() =>
      useSpeechAlerts({
        elevenLabsConfigured: true,
        onUtteranceStarted: (id) => startedIds.push(id),
        deps: {
          requestSpeech: (text, signal) => {
            requestCalls.push(text)
            if (text.includes('Delayed')) {
              pendingState.signal = signal
              return new Promise<Response>((resolve, reject) => {
                signal.addEventListener('abort', () =>
                  reject(new DOMException('Aborted', 'AbortError')),
                )
                resolvePendingReq = resolve
              })
            }
            return Promise.resolve(new Response('audio-bytes', { status: 200 }))
          },
          playAudio: async (_res, { onStart }) => {
            onStart()
          },
        },
      }),
    )

    expect(result.current.isSupported).toBe(true)

    await act(async () => {
      result.current.enqueueAutoAlerts([{ id: 'A', spoken_alert: 'Missing two a b term.' }])
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(requestCalls).toEqual(['Missing two a b term.'])
    expect(startedIds).toEqual(['A'])
    expect(spokenQueue).toHaveLength(0) // Browser fallback NOT invoked on ElevenLabs success

    // Duplicate auto-enqueue of A is ignored
    await act(async () => {
      result.current.enqueueAutoAlerts([{ id: 'A', spoken_alert: 'Missing two a b term.' }])
      await Promise.resolve()
    })
    expect(requestCalls).toHaveLength(1)

    // Manual speakNow replays A even though it already auto-spoke
    await act(async () => {
      result.current.speakNow({ id: 'A', spoken_alert: 'Missing two a b term.' })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(requestCalls).toHaveLength(2)

    // In-flight request cancelled via cancelAll() aborts signal and ignores late resolution
    act(() => {
      result.current.enqueueAutoAlerts([{ id: 'B', spoken_alert: 'Delayed alert.' }])
    })
    expect(requestCalls).toHaveLength(3)
    expect(pendingState.signal?.aborted).toBe(false)

    act(() => {
      result.current.cancelAll()
    })
    expect(pendingState.signal?.aborted).toBe(true)
    expect(cancelMock).toHaveBeenCalled()
    expect(resolvePendingReq).not.toBeNull()
    await act(async () => {
      resolvePendingReq?.(new Response('stale-audio', { status: 200 }))
      await Promise.resolve()
    })
    expect(startedIds).not.toContain('B')
  })

  it('automatically falls back to browser speech when ElevenLabs fails or hits quota and respects cooldown', async () => {
    const { spokenQueue } = makeFakeBrowserSpeech()
    let clock = 10_000
    let elevenCalls = 0
    const startedIds: string[] = []

    const { result } = renderHook(() =>
      useSpeechAlerts({
        elevenLabsConfigured: true,
        onUtteranceStarted: (id) => startedIds.push(id),
        deps: {
          now: () => clock,
          requestSpeech: async () => {
            elevenCalls += 1
            throw new ApiClientError('Quota exceeded', {
              code: 'SPEECH_QUOTA_EXCEEDED',
              status: 503,
              retryAfterSeconds: 60,
            })
          },
          playAudio: async () => {},
        },
      }),
    )

    // Issue 1 hits ElevenLabs 503 quota -> seamlessly falls back to browser voice
    await act(async () => {
      result.current.enqueueAutoAlerts([{ id: 'Q1', spoken_alert: 'Force uses Newtons.' }])
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(elevenCalls).toBe(1)
    expect(spokenQueue).toHaveLength(1)

    act(() => {
      spokenQueue[0]?.onstart?.()
      spokenQueue[0]?.onend?.()
    })
    expect(startedIds).toEqual(['Q1'])
    expect(result.current.speechError).toBeNull()

    // Issue 2 within 60s cooldown skips redundant failing ElevenLabs call & uses browser directly
    clock += 5000
    await act(async () => {
      result.current.enqueueAutoAlerts([{ id: 'Q2', spoken_alert: 'Check the minus sign.' }])
      await Promise.resolve()
    })
    expect(elevenCalls).toBe(1)
    expect(spokenQueue).toHaveLength(2)
  })

  it('disables ElevenLabs permanently on paid-plan voice error, notifies fallback once, and recovers wedged browser synth', async () => {
    vi.useFakeTimers()
    const spokenQueue: FakeUtterance[] = []
    const cancelMock = vi.fn()
    const resumeMock = vi.fn()

    class MockUtterance implements FakeUtterance {
      text: string
      rate = 1
      pitch = 1
      onstart: (() => void) | null = null
      onend: (() => void) | null = null
      onerror: ((event: { error: string }) => void) | null = null
      constructor(text: string) {
        this.text = text
      }
    }

    Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', {
      configurable: true,
      value: MockUtterance,
    })
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        paused: true,
        resume: resumeMock,
        speak: (u: FakeUtterance) => {
          spokenQueue.push(u)
        },
        cancel: cancelMock,
      },
    })

    const fallbackNotices: string[] = []
    let elevenCalls = 0
    const { result, unmount } = renderHook(() =>
      useSpeechAlerts({
        elevenLabsConfigured: true,
        onProviderFallback: (reason) => fallbackNotices.push(reason),
        deps: {
          requestSpeech: async () => {
            elevenCalls += 1
            throw new ApiClientError('Configured ElevenLabs voice requires a paid plan.', {
              code: 'SPEECH_VOICE_PLAN_REQUIRED',
              status: 503,
            })
          },
          playAudio: async () => {},
        },
      }),
    )

    await act(async () => {
      result.current.enqueueAutoAlerts([{ id: 'P1', spoken_alert: 'Missing 2ab.' }])
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(elevenCalls).toBe(1)
    expect(fallbackNotices).toEqual(['Configured ElevenLabs voice requires a paid plan.'])
    expect(resumeMock).toHaveBeenCalledTimes(1)
    expect(spokenQueue).toHaveLength(1)

    // Subsequent alert skips ElevenLabs permanently during session without repeating notice
    await act(async () => {
      result.current.enqueueAutoAlerts([{ id: 'P2', spoken_alert: 'Check units.' }])
      await Promise.resolve()
    })
    expect(elevenCalls).toBe(1)
    expect(fallbackNotices).toHaveLength(1)

    // If browser speech drops callbacks, start watchdog unblocks queue cleanly
    await act(async () => {
      vi.advanceTimersByTime(BROWSER_SPEECH_START_TIMEOUT_MS + 50)
      await Promise.resolve()
    })
    expect(spokenQueue).toHaveLength(2)

    await act(async () => {
      vi.advanceTimersByTime(BROWSER_SPEECH_START_TIMEOUT_MS + 50)
      await Promise.resolve()
    })
    expect(result.current.isSpeaking).toBe(false)

    unmount()
    vi.useRealTimers()
  })

<<<<<<< HEAD
  it('cancels unstarted or explicitly canceled speech while letting already-started speech finish cleanly', async () => {
=======
  it('cancels queued and active speech immediately when an issue is resolved via syncActiveIssueIds', async () => {
>>>>>>> origin/main
    makeFakeBrowserSpeech()
    const signals: AbortSignal[] = []
    let rejectedCount = 0

    const { result } = renderHook(() =>
      useSpeechAlerts({
        elevenLabsConfigured: true,
        deps: {
          requestSpeech: async () => new Response('audio', { status: 200 }),
          playAudio: (_res, { signal, onStart }) => {
            signals.push(signal)
<<<<<<< HEAD
            if (signals.length >= 2) {
              onStart()
            }
=======
            onStart()
>>>>>>> origin/main
            return new Promise<void>((_resolve, reject) => {
              signal.addEventListener('abort', () => {
                rejectedCount += 1
                reject(new DOMException('Aborted', 'AbortError'))
              })
            })
          },
        },
      }),
    )

<<<<<<< HEAD
    // Queue issue X (still buffering / unstarted) and issue Y, Z (waiting in queue)
=======
    // Queue issue X (becomes active) and issue Y (waiting in queue)
>>>>>>> origin/main
    await act(async () => {
      result.current.enqueueAutoAlerts([
        { id: 'X', spoken_alert: 'First alert.' },
        { id: 'Y', spoken_alert: 'Second alert.' },
<<<<<<< HEAD
        { id: 'Z', spoken_alert: 'Third alert.' },
=======
>>>>>>> origin/main
      ])
      await Promise.resolve()
    })
    expect(signals).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(false)

<<<<<<< HEAD
    // Unstarted X resolves and Z resolves while Y stays open -> X aborts, Z pruned, Y starts & fires onStart
=======
    // Issue X resolves (syncActiveIssueIds only contains Y) -> X is cancelled, queue advances to Y
>>>>>>> origin/main
    await act(async () => {
      result.current.syncActiveIssueIds(new Set(['Y']))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(signals[0]?.aborted).toBe(true)
    expect(rejectedCount).toBe(1)
    expect(signals).toHaveLength(2)
    expect(signals[1]?.aborted).toBe(false)

<<<<<<< HEAD
    // Already-started Y is NOT cut off mid-sentence by syncActiveIssueIds
=======
>>>>>>> origin/main
    await act(async () => {
      result.current.syncActiveIssueIds(new Set())
      await Promise.resolve()
    })
<<<<<<< HEAD
    expect(signals[1]?.aborted).toBe(false)

    // Explicit cancelIssue('Y') immediately aborts already-started Y
    await act(async () => {
      result.current.cancelIssue('Y')
      await Promise.resolve()
    })
=======
>>>>>>> origin/main
    expect(signals[1]?.aborted).toBe(true)
    expect(result.current.isSpeaking).toBe(false)
  })

<<<<<<< HEAD
  it('recovers mid-utterance ElevenLabs errors via browser fallback and only marks spoken on completion', async () => {
    const { spokenQueue } = makeFakeBrowserSpeech()
    const startedIds: string[] = []
    const completedIds: string[] = []

    const { result } = renderHook(() =>
      useSpeechAlerts({
        elevenLabsConfigured: true,
        onUtteranceStarted: (id) => startedIds.push(id),
        onUtteranceCompleted: (id) => completedIds.push(id),
        deps: {
          requestSpeech: async () => new Response('audio', { status: 200 }),
          playAudio: async (_res, { onStart }) => {
            onStart()
            throw new Error('Mid-stream MSE decode error')
          },
        },
      }),
    )

    await act(async () => {
      result.current.enqueueAutoAlerts([{ id: 'A', spoken_alert: 'Check derivative.' }])
      await Promise.resolve()
      await Promise.resolve()
    })

    // ElevenLabs invoked onStart then failed -> not completed yet, browser fallback speaks
    expect(startedIds).toEqual(['A'])
    expect(completedIds).toEqual([])
    expect(spokenQueue).toHaveLength(1)

    // Interrupting browser fallback before onend leaves A eligible on next enqueue
    act(() => {
      spokenQueue[0]?.onstart?.()
      result.current.cancelAll()
    })
    expect(completedIds).toEqual([])

    act(() => {
      result.current.enqueueAutoAlerts([{ id: 'A', spoken_alert: 'Check derivative.' }])
    })
    expect(spokenQueue).toHaveLength(2)

    act(() => {
      spokenQueue[1]?.onstart?.()
      spokenQueue[1]?.onend?.()
    })
    expect(completedIds).toEqual(['A'])

    // Once completed cleanly, auto-alerts do not repeat A
    act(() => {
      result.current.enqueueAutoAlerts([{ id: 'A', spoken_alert: 'Check derivative.' }])
    })
    expect(spokenQueue).toHaveLength(2)
  })

  it('cancelIssue cancels only the dismissed card without halting queued peers', async () => {
    makeFakeBrowserSpeech()
    const completedIds: string[] = []
    const abortedFor: string[] = []
    let activeId = ''
    let resolveCurrent: (() => void) | null = null

    const { result } = renderHook(() =>
      useSpeechAlerts({
        elevenLabsConfigured: true,
        onUtteranceCompleted: (id) => completedIds.push(id),
        deps: {
          requestSpeech: async () => new Response('audio', { status: 200 }),
          playAudio: (_res, { signal, onStart }) => {
            const capturedId = activeId
            onStart()
            return new Promise<void>((resolve, reject) => {
              resolveCurrent = resolve
              signal.addEventListener('abort', () => {
                abortedFor.push(capturedId)
                reject(new DOMException('Aborted', 'AbortError'))
              })
            })
          },
        },
      }),
    )

    activeId = 'A'
    await act(async () => {
      result.current.enqueueAutoAlerts([
        { id: 'A', spoken_alert: 'First alert.' },
        { id: 'B', spoken_alert: 'Second alert.' },
        { id: 'C', spoken_alert: 'Third alert.' },
      ])
      await Promise.resolve()
    })

    // Dismiss queued B -> A continues speaking untouched
    act(() => {
      result.current.cancelIssue('B')
    })
    expect(abortedFor).toEqual([])

    // Finish A cleanly -> skips B and advances directly to C
    activeId = 'C'
    await act(async () => {
      resolveCurrent?.()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(completedIds).toEqual(['A'])

    await act(async () => {
      resolveCurrent?.()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(completedIds).toEqual(['A', 'C'])
  })

=======
>>>>>>> origin/main
  it('retains browser-only cancellation, error, and unmount cleanup guarantees', () => {
    const { spokenQueue, cancelMock } = makeFakeBrowserSpeech()
    const startedIds: string[] = []

    const { result, unmount } = renderHook(() =>
      useSpeechAlerts({
        elevenLabsConfigured: false,
        onUtteranceStarted: (id) => startedIds.push(id),
      }),
    )

    // Queue A and cancel BEFORE onstart -> must NOT mark spoken
    act(() => {
      result.current.enqueueAutoAlerts([{ id: 'A', spoken_alert: 'Missing 2ab.' }])
    })
    expect(spokenQueue).toHaveLength(1)
    expect(startedIds).toEqual([])

    act(() => {
      result.current.cancelAll()
    })
    expect(cancelMock).toHaveBeenCalledTimes(1)
    act(() => {
      spokenQueue[0]?.onstart?.()
    })
    expect(startedIds).toEqual([])

    // Queue A again now -> eligible because previous was cancelled before starting
    act(() => {
      result.current.enqueueAutoAlerts([{ id: 'A', spoken_alert: 'Missing 2ab.' }])
    })
    expect(spokenQueue).toHaveLength(2)
    act(() => {
      spokenQueue[1]?.onstart?.()
      spokenQueue[1]?.onend?.()
    })
    expect(startedIds).toEqual(['A'])

    // Explicit speakNow replays A and surfaces synthesis-failed errors cleanly
    act(() => {
      result.current.speakNow({ id: 'A', spoken_alert: 'Missing 2ab.' })
    })
    expect(spokenQueue).toHaveLength(3)
    act(() => {
      spokenQueue[2]?.onerror?.({ error: 'synthesis-failed' })
    })
    expect(result.current.speechError).toMatch(/synthesis-failed/i)

    unmount()
    expect(cancelMock).toHaveBeenCalled()
  })
})

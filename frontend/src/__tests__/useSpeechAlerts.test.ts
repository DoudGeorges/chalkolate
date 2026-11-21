import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSpeechAlerts } from '../hooks/useSpeechAlerts'

interface FakeUtterance {
  text: string
  rate: number
  pitch: number
  onstart: (() => void) | null
  onend: (() => void) | null
  onerror: ((event: { error: string }) => void) | null
}

describe('useSpeechAlerts', () => {
  const originalSynth = window.speechSynthesis
  const originalUtterance = globalThis.SpeechSynthesisUtterance

  beforeEach(() => {
    vi.restoreAllMocks()
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

  it('reports unavailable speech synthesis cleanly without crashing', () => {
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

  it('deduplicates alerts, does not mark cancelled-before-start spoken, and surfaces errors', () => {
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

    const startedIds: string[] = []
    const { result, unmount } = renderHook(() =>
      useSpeechAlerts({
        onUtteranceStarted: (id) => startedIds.push(id),
      }),
    )

    expect(result.current.isSupported).toBe(true)

    // Queue issue A and cancel BEFORE onstart -> must NOT mark spoken
    act(() => {
      result.current.enqueueAutoAlerts([{ id: 'A', spoken_alert: 'Missing 2ab.' }])
    })
    expect(spokenQueue).toHaveLength(1)
    expect(startedIds).toEqual([])

    act(() => {
      result.current.cancelAll()
    })
    expect(cancelMock).toHaveBeenCalledTimes(1)
    // Late onstart from cancelled utterance is ignored
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
    })
    expect(startedIds).toEqual(['A'])

    // Duplicate auto-enqueue of A is ignored
    act(() => {
      result.current.enqueueAutoAlerts([{ id: 'A', spoken_alert: 'Missing 2ab.' }])
    })
    expect(spokenQueue).toHaveLength(2)

    // Explicit speakNow replays A cleanly
    act(() => {
      result.current.speakNow({ id: 'A', spoken_alert: 'Missing 2ab.' })
    })
    expect(spokenQueue).toHaveLength(3)

    // Non-cancellation synthesis error sets visible speechError
    act(() => {
      spokenQueue[2]?.onerror?.({ error: 'synthesis-failed' })
    })
    expect(result.current.speechError).toMatch(/synthesis-failed/i)

    unmount()
    expect(cancelMock).toHaveBeenCalled()
  })
})

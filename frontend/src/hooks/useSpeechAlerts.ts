import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiClientError, requestSpeechStream } from '../api/client'
import { playAudioStreamResponse, unlockAudioPlayback } from '../lib/audioPlayer'

export interface SpeakableAlert {
  id: string
  spoken_alert: string
}

export interface SpeechAlertDeps {
  requestSpeech: (text: string, signal: AbortSignal) => Promise<Response>
  playAudio: (
    response: Response,
    options: { signal: AbortSignal; onStart: () => void },
  ) => Promise<void>
  now: () => number
}

const DEFAULT_DEPS: SpeechAlertDeps = {
  requestSpeech: (text, signal) => requestSpeechStream(text, signal),
  playAudio: (response, options) => playAudioStreamResponse(response, options),
  now: () => Date.now(),
}

export const SPEECH_REQUEST_TIMEOUT_MS = 12_000
export const BROWSER_SPEECH_START_TIMEOUT_MS = 4_000
export const BROWSER_SPEECH_MAX_MS = 20_000

export interface UseSpeechAlertsOptions {
  elevenLabsConfigured?: boolean
  onUtteranceStarted?: (issueId: string) => void
  onUtteranceCompleted?: (issueId: string) => void
  onProviderFallback?: (reason: string) => void
  deps?: Partial<SpeechAlertDeps>
}

interface QueuedSpeechItem {
  id: string
  text: string
  mode: 'auto' | 'manual'
}

interface ActivePlaybackControl {
  issueId: string
  gen: number
  provider: 'elevenlabs' | 'browser'
  started: boolean
  cancel: () => void
}

function getSpeechSynthesisApi(): SpeechSynthesis | null {
  if (
    typeof window === 'undefined' ||
    !('speechSynthesis' in window) ||
    typeof window.speechSynthesis === 'undefined' ||
    typeof SpeechSynthesisUtterance === 'undefined'
  ) {
    return null
  }
  return window.speechSynthesis
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

function isPermanentSpeechConfigFailure(err: unknown): boolean {
  return (
    err instanceof ApiClientError &&
    (err.code === 'SPEECH_NOT_CONFIGURED' ||
      err.code === 'SPEECH_AUTH_ERROR' ||
      err.code === 'SPEECH_VOICE_PLAN_REQUIRED')
  )
}

function computeCooldownMs(err: unknown): number {
  if (isPermanentSpeechConfigFailure(err)) {
    return Number.POSITIVE_INFINITY
  }
  if (err instanceof ApiClientError) {
    if (err.code === 'SPEECH_QUOTA_EXCEEDED') {
      return (err.retryAfterSeconds ?? 60) * 1000
    }
    if (
      err.code === 'SPEECH_RATE_LIMITED' ||
      err.code === 'SPEECH_UNAVAILABLE' ||
      err.code === 'CAPACITY_EXCEEDED'
    ) {
      return (err.retryAfterSeconds ?? 10) * 1000
    }
  }
  return 15_000
}

export function useSpeechAlerts(options: UseSpeechAlertsOptions = {}) {
  const {
    elevenLabsConfigured = false,
    onUtteranceStarted,
    onUtteranceCompleted,
    onProviderFallback,
    deps: partialDeps,
  } = options

  const depsRef = useRef<SpeechAlertDeps>({ ...DEFAULT_DEPS, ...partialDeps })
  depsRef.current = { ...DEFAULT_DEPS, ...partialDeps }

  const onStartedRef = useRef(onUtteranceStarted)
  onStartedRef.current = onUtteranceStarted
  const onCompletedRef = useRef(onUtteranceCompleted)
  onCompletedRef.current = onUtteranceCompleted

  const onFallbackRef = useRef(onProviderFallback)
  onFallbackRef.current = onProviderFallback

  const elevenLabsConfiguredRef = useRef(elevenLabsConfigured)
  elevenLabsConfiguredRef.current = elevenLabsConfigured

  const browserSupported = getSpeechSynthesisApi() !== null
  const isSupported = elevenLabsConfigured || browserSupported

  const [isSpeaking, setIsSpeaking] = useState(false)
  const [speechError, setSpeechError] = useState<string | null>(
    isSupported ? null : 'Web Speech Synthesis is unavailable in this browser; using visual alerts.',
  )

  const queueRef = useRef<QueuedSpeechItem[]>([])
  const queuedIdsRef = useRef<Set<string>>(new Set())
  const startedIdsRef = useRef<Set<string>>(new Set())
  const activeUtterancesRef = useRef<Set<SpeechSynthesisUtterance>>(new Set())
  const activeControlRef = useRef<ActivePlaybackControl | null>(null)
  const isProcessingRef = useRef(false)
  const cancelGenRef = useRef(0)
  const elevenLabsCooldownUntilRef = useRef(0)
  const fallbackNotifiedRef = useRef(false)

  const refreshUnavailableMessage = useCallback(() => {
    const anySupported = elevenLabsConfiguredRef.current || getSpeechSynthesisApi() !== null
    setSpeechError(
      anySupported
        ? null
        : 'Web Speech Synthesis is unavailable in this browser; using visual alerts.',
    )
  }, [])

  useEffect(() => {
    if (elevenLabsConfigured) {
      if (elevenLabsCooldownUntilRef.current === Number.POSITIVE_INFINITY) {
        elevenLabsCooldownUntilRef.current = 0
        fallbackNotifiedRef.current = false
      }
      setSpeechError((prev) =>
        prev && prev.includes('unavailable in this browser') ? null : prev,
      )
    }
  }, [elevenLabsConfigured])

  const unlockAudio = useCallback(() => {
    unlockAudioPlayback()
  }, [])

  const cancelAll = useCallback(() => {
    cancelGenRef.current += 1
    queueRef.current = []
    queuedIdsRef.current.clear()
    isProcessingRef.current = false
    const active = activeControlRef.current
    activeControlRef.current = null
    active?.cancel()
    activeUtterancesRef.current.clear()
    setIsSpeaking(false)
    if (active?.provider !== 'browser') {
      const synth = getSpeechSynthesisApi()
      if (synth) {
        try {
          synth.cancel()
        } catch {
          // Ignore browser speech cancel quirks.
        }
      }
    }
  }, [])

  const resetHistory = useCallback(() => {
    cancelAll()
    startedIdsRef.current.clear()
    refreshUnavailableMessage()
  }, [cancelAll, refreshUnavailableMessage])

  const speakViaBrowser = useCallback(
    (item: QueuedSpeechItem, gen: number): Promise<void> => {
      const synth = getSpeechSynthesisApi()
      if (!synth) {
        return Promise.resolve()
      }

      return new Promise<void>((resolve) => {
        if (gen !== cancelGenRef.current) {
          resolve()
          return
        }

        const utterance = new SpeechSynthesisUtterance(item.text)
        utterance.rate = 1.0
        utterance.pitch = 1.0

        let settled = false
        let startWatchdog: number | undefined
        let maxWatchdog: number | undefined
        let keepAliveTimer: number | undefined

        const clearWatchdogs = () => {
          if (startWatchdog !== undefined) {
            window.clearTimeout(startWatchdog)
            startWatchdog = undefined
          }
          if (maxWatchdog !== undefined) {
            window.clearTimeout(maxWatchdog)
            maxWatchdog = undefined
          }
          if (keepAliveTimer !== undefined) {
            window.clearInterval(keepAliveTimer)
            keepAliveTimer = undefined
          }
        }

        const finish = () => {
          if (settled) return
          settled = true
          clearWatchdogs()
          activeUtterancesRef.current.delete(utterance)
          if (activeControlRef.current?.gen === gen && activeControlRef.current.issueId === item.id) {
            activeControlRef.current = null
          }
          resolve()
        }

        activeUtterancesRef.current.add(utterance)
        activeControlRef.current = {
          issueId: item.id,
          gen,
          provider: 'browser',
          started: false,
          cancel: () => {
            try {
              synth.cancel()
            } catch {
              // Ignore browser cancel errors.
            }
            finish()
          },
        }

        startWatchdog = window.setTimeout(() => {
          if (settled) return
          try {
            synth.cancel()
          } catch {
            // Ignore stalled cancel error.
          }
          queuedIdsRef.current.delete(item.id)
          startedIdsRef.current.delete(item.id)
          finish()
        }, BROWSER_SPEECH_START_TIMEOUT_MS)

        maxWatchdog = window.setTimeout(() => {
          if (settled) return
          try {
            synth.cancel()
          } catch {
            // Ignore stalled cancel error.
          }
          queuedIdsRef.current.delete(item.id)
          startedIdsRef.current.delete(item.id)
          finish()
        }, BROWSER_SPEECH_MAX_MS)

        utterance.onstart = () => {
          if (startWatchdog !== undefined) {
            window.clearTimeout(startWatchdog)
            startWatchdog = undefined
          }
          if (gen !== cancelGenRef.current || settled) return
          if (activeControlRef.current?.issueId === item.id && activeControlRef.current.gen === gen) {
            activeControlRef.current.started = true
          }
          queuedIdsRef.current.delete(item.id)
          setSpeechError(null)
          onStartedRef.current?.(item.id)
        }

        utterance.onend = () => {
          queuedIdsRef.current.delete(item.id)
          if (gen === cancelGenRef.current && !settled) {
            startedIdsRef.current.add(item.id)
            onCompletedRef.current?.(item.id)
          }
          finish()
        }

        utterance.onerror = (event) => {
          queuedIdsRef.current.delete(item.id)
          if (gen === cancelGenRef.current && !settled) {
            startedIdsRef.current.delete(item.id)
            const errCode = event.error
            if (errCode !== 'canceled' && errCode !== 'interrupted') {
              setSpeechError(
                errCode === 'not-allowed'
                  ? 'Speech playback blocked by browser autoplay policy. Use Speak on a card to play audio.'
                  : `Speech playback error (${errCode || 'unknown'}). Visual alerts remain active.`,
              )
            }
          }
          finish()
        }

        try {
          // Chromium on Windows occasionally leaves speechSynthesis paused across focus changes.
          if ('paused' in synth && synth.paused && typeof synth.resume === 'function') {
            synth.resume()
          }
          synth.speak(utterance)
          keepAliveTimer = window.setInterval(() => {
            if (settled) return
            if ('paused' in synth && synth.paused && typeof synth.resume === 'function') {
              try {
                synth.resume()
              } catch {
                // Ignore browser keep-alive resume quirks.
              }
            }
          }, 10_000)
        } catch {
          queuedIdsRef.current.delete(item.id)
          startedIdsRef.current.delete(item.id)
          if (gen === cancelGenRef.current) {
            setSpeechError('Speech synthesis failed to start.')
          }
          finish()
        }
      })
    },
    [],
  )

  const pumpQueue = useCallback(async () => {
    if (isProcessingRef.current) return
    isProcessingRef.current = true
    const gen = cancelGenRef.current

    try {
      while (queueRef.current.length > 0 && gen === cancelGenRef.current) {
        const item = queueRef.current.shift()
        if (!item) break

        setIsSpeaking(true)
        let didStart = false

        const canTryElevenLabs =
          elevenLabsConfiguredRef.current &&
          depsRef.current.now() >= elevenLabsCooldownUntilRef.current

        if (canTryElevenLabs) {
          const abortController = new AbortController()
          let timedOut = false
          const timeoutId = window.setTimeout(() => {
            timedOut = true
            abortController.abort()
          }, SPEECH_REQUEST_TIMEOUT_MS)

          activeControlRef.current = {
            issueId: item.id,
            gen,
            provider: 'elevenlabs',
            started: false,
            cancel: () => {
              window.clearTimeout(timeoutId)
              abortController.abort()
            },
          }

          let needBrowserFallback = false
          try {
            const response = await depsRef.current.requestSpeech(
              item.text,
              abortController.signal,
            )
            window.clearTimeout(timeoutId)
            if (gen !== cancelGenRef.current || abortController.signal.aborted) {
              continue
            }

            await depsRef.current.playAudio(response, {
              signal: abortController.signal,
              onStart: () => {
                if (gen !== cancelGenRef.current || abortController.signal.aborted || didStart) {
                  return
                }
                didStart = true
                if (
                  activeControlRef.current?.issueId === item.id &&
                  activeControlRef.current.gen === gen
                ) {
                  activeControlRef.current.started = true
                }
                queuedIdsRef.current.delete(item.id)
                setSpeechError(null)
                onStartedRef.current?.(item.id)
              },
            })
            queuedIdsRef.current.delete(item.id)
            if (gen === cancelGenRef.current && !abortController.signal.aborted) {
              startedIdsRef.current.add(item.id)
              onCompletedRef.current?.(item.id)
            }
          } catch (err) {
            window.clearTimeout(timeoutId)
            if (
              !timedOut &&
              (gen !== cancelGenRef.current || abortController.signal.aborted || isAbortError(err))
            ) {
              continue
            }

            const effectiveErr = timedOut ? new Error('Speech synthesis request timed out.') : err
            const cooldownMs = computeCooldownMs(effectiveErr)
            if (cooldownMs === Number.POSITIVE_INFINITY) {
              elevenLabsCooldownUntilRef.current = Number.POSITIVE_INFINITY
              if (!fallbackNotifiedRef.current) {
                fallbackNotifiedRef.current = true
                const msg =
                  effectiveErr instanceof Error && effectiveErr.message
                    ? effectiveErr.message
                    : 'ElevenLabs unavailable; using browser voice.'
                onFallbackRef.current?.(msg)
              }
            } else {
              elevenLabsCooldownUntilRef.current = depsRef.current.now() + cooldownMs
            }

            queuedIdsRef.current.delete(item.id)
            startedIdsRef.current.delete(item.id)
            if (getSpeechSynthesisApi() !== null) {
              needBrowserFallback = true
            } else {
              setSpeechError(
                effectiveErr instanceof Error && effectiveErr.message
                  ? effectiveErr.message
                  : 'Speech playback failed. Visual alerts remain active.',
              )
            }
          } finally {
            window.clearTimeout(timeoutId)
            if (activeControlRef.current?.gen === gen) {
              activeControlRef.current = null
            }
          }

          if (needBrowserFallback && gen === cancelGenRef.current) {
            await speakViaBrowser(item, gen)
          }
        } else if (getSpeechSynthesisApi() !== null) {
          await speakViaBrowser(item, gen)
        } else {
          queuedIdsRef.current.delete(item.id)
          setSpeechError(
            'Speech synthesis is unavailable in this browser. Corrections remain visible on screen.',
          )
        }
      }
    } finally {
      if (gen === cancelGenRef.current) {
        activeControlRef.current = null
        isProcessingRef.current = false
        setIsSpeaking(false)
      }
    }
  }, [speakViaBrowser])

  const enqueueAutoAlerts = useCallback(
    (issues: readonly SpeakableAlert[]) => {
      let added = false
      for (const issue of issues) {
        const text = issue.spoken_alert.trim()
        if (!text) continue
        if (
          queuedIdsRef.current.has(issue.id) ||
          startedIdsRef.current.has(issue.id) ||
          activeControlRef.current?.issueId === issue.id
        ) {
          continue
        }
        queuedIdsRef.current.add(issue.id)
        queueRef.current.push({ id: issue.id, text, mode: 'auto' })
        added = true
      }
      if (added) {
        void pumpQueue()
      }
    },
    [pumpQueue],
  )

  const speakNow = useCallback(
    (issue: SpeakableAlert) => {
      const text = issue.spoken_alert.trim()
      if (!text) return
      cancelAll()
      unlockAudioPlayback()
      queuedIdsRef.current.add(issue.id)
      queueRef.current.push({ id: issue.id, text, mode: 'manual' })
      void pumpQueue()
    },
    [cancelAll, pumpQueue],
  )

  const cancelIssue = useCallback(
    (issueId: string) => {
      if (queueRef.current.length > 0) {
        queueRef.current = queueRef.current.filter((item) => item.id !== issueId)
      }
      queuedIdsRef.current.delete(issueId)

      const active = activeControlRef.current
      if (active && active.issueId === issueId) {
        cancelGenRef.current += 1
        activeControlRef.current = null
        isProcessingRef.current = false
        active.cancel()
        if (queueRef.current.length > 0) {
          void pumpQueue()
        } else {
          setIsSpeaking(false)
        }
      }
    },
    [pumpQueue],
  )

  /**
   * Cancels queued or unstarted announcements for findings that have resolved or been
   * dismissed, while allowing an already-started short utterance to finish cleanly unless
   * explicitly canceled via cancelIssue or cancelAll.
   */
  const syncActiveIssueIds = useCallback(
    (activeIds: ReadonlySet<string>) => {
      if (queueRef.current.length > 0) {
        const nextQueue: QueuedSpeechItem[] = []
        for (const item of queueRef.current) {
          if (activeIds.has(item.id)) {
            nextQueue.push(item)
          } else {
            queuedIdsRef.current.delete(item.id)
          }
        }
        queueRef.current = nextQueue
      }

      const active = activeControlRef.current
      if (active && !activeIds.has(active.issueId) && !active.started) {
        cancelGenRef.current += 1
        activeControlRef.current = null
        isProcessingRef.current = false
        queuedIdsRef.current.delete(active.issueId)
        active.cancel()
        if (queueRef.current.length > 0) {
          void pumpQueue()
        } else {
          setIsSpeaking(false)
        }
      }
    },
    [pumpQueue],
  )

  useEffect(() => {
    return () => {
      cancelAll()
    }
  }, [cancelAll])

  return {
    isSupported,
    isSpeaking,
    speechError,
    enqueueAutoAlerts,
    speakNow,
    cancelIssue,
    cancelAll,
    resetHistory,
    syncActiveIssueIds,
    unlockAudio,
  }
}

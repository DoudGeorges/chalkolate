import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiClientError, requestSpeechStream } from '../api/client'
import { isAbortError } from '../lib/abort'
import { playAudioStreamResponse, unlockAudioPlayback } from '../lib/audioPlayer'
import {
  DEFAULT_VOICE_PREFERENCES,
  SpeakableIssueText,
  VoicePreferences,
  composeSpokenText,
  speechRequestChunks,
} from '../lib/voicePreferences'

export interface SpeakableAlert extends SpeakableIssueText {
  id: string
}

export interface SpeechAlertDeps {
  requestSpeech: (
    text: string,
    signal: AbortSignal,
    options?: { voice?: string },
  ) => Promise<Response>
  playAudio: (
    response: Response,
    options: { signal: AbortSignal; onStart: () => void },
  ) => Promise<void>
  now: () => number
}

const DEFAULT_DEPS: SpeechAlertDeps = {
  requestSpeech: (text, signal, options) => requestSpeechStream(text, signal, options),
  playAudio: (response, options) => playAudioStreamResponse(response, options),
  now: () => Date.now(),
}

export const SPEECH_REQUEST_TIMEOUT_MS = 12_000
const SPEECH_PLAYBACK_TIMEOUT_MS = 30_000
export const BROWSER_SPEECH_START_TIMEOUT_MS = 4_000
export const BROWSER_SPEECH_MAX_MS = 20_000
export const PREVIEW_ALERT_ID = '__voice-preview__'
const PREVIEW_SAMPLE: SpeakableIssueText = {
  spoken_alert: 'The derivative of x squared should be two x.',
  explanation: 'The power rule brings the two down and reduces the exponent by one.',
}
const BROWSER_VOICE_UNAVAILABLE = 'This browser cannot play spoken alerts. Corrections appear on the board.'

export interface UseSpeechAlertsOptions {
  elevenLabsConfigured?: boolean
  preferences?: VoicePreferences
  onUtteranceStarted?: (issueId: string) => void
  onProviderFallback?: (reason: string) => void
  deps?: Partial<SpeechAlertDeps>
}

interface QueuedSpeechItem {
  id: string
  issue: SpeakableIssueText
  mode: 'auto' | 'manual' | 'preview'
  /** Voice override for previews; alerts use the current preference. */
  voice?: string
}

interface ActivePlaybackControl {
  issueId: string
  gen: number
  provider: 'elevenlabs' | 'browser'
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

function isPermanentSpeechConfigFailure(err: unknown): boolean {
  return (
    err instanceof ApiClientError &&
    (err.code === 'SPEECH_NOT_CONFIGURED' || err.code === 'SPEECH_AUTH_ERROR')
  )
}

/** Failures that only affect the selected voice; other voices may still work. */
function isVoiceSpecificFailure(err: unknown): boolean {
  return (
    err instanceof ApiClientError &&
    (err.code === 'SPEECH_VOICE_PLAN_REQUIRED' || err.code === 'SPEECH_VOICE_UNAVAILABLE')
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
    preferences = DEFAULT_VOICE_PREFERENCES,
    onUtteranceStarted,
    onProviderFallback,
    deps: partialDeps,
  } = options

  const depsRef = useRef<SpeechAlertDeps>({ ...DEFAULT_DEPS, ...partialDeps })
  depsRef.current = { ...DEFAULT_DEPS, ...partialDeps }

  const onStartedRef = useRef(onUtteranceStarted)
  onStartedRef.current = onUtteranceStarted

  const onFallbackRef = useRef(onProviderFallback)
  onFallbackRef.current = onProviderFallback

  const elevenLabsConfiguredRef = useRef(elevenLabsConfigured)
  elevenLabsConfiguredRef.current = elevenLabsConfigured

  const preferencesRef = useRef(preferences)
  preferencesRef.current = preferences

  const browserSupported = getSpeechSynthesisApi() !== null
  const isSupported = elevenLabsConfigured || browserSupported

  /** Voice key whose preview is currently queued or playing, for UI feedback. */
  const [previewingVoice, setPreviewingVoice] = useState<string | null>(null)
  const [speechError, setSpeechError] = useState<string | null>(
    isSupported ? null : BROWSER_VOICE_UNAVAILABLE,
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
  const blockedVoicesRef = useRef<Set<string>>(new Set())

  const refreshUnavailableMessage = useCallback(() => {
    const anySupported = elevenLabsConfiguredRef.current || getSpeechSynthesisApi() !== null
    setSpeechError(
      anySupported
        ? null
        : BROWSER_VOICE_UNAVAILABLE,
    )
  }, [])

  useEffect(() => {
    if (elevenLabsConfigured) {
      if (elevenLabsCooldownUntilRef.current === Number.POSITIVE_INFINITY) {
        elevenLabsCooldownUntilRef.current = 0
        fallbackNotifiedRef.current = false
      }
      setSpeechError((prev) =>
        prev === BROWSER_VOICE_UNAVAILABLE ? null : prev,
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
    setPreviewingVoice(null)
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
    (item: QueuedSpeechItem, text: string, gen: number): Promise<void> => {
      const synth = getSpeechSynthesisApi()
      if (!synth) {
        return Promise.resolve()
      }

      return new Promise<void>((resolve) => {
        if (gen !== cancelGenRef.current) {
          resolve()
          return
        }

        const utterance = new SpeechSynthesisUtterance(text)
        utterance.rate = 1.0
        utterance.pitch = 1.0

        let settled = false
        let startWatchdog: number | undefined
        let maxWatchdog: number | undefined

        const clearWatchdogs = () => {
          if (startWatchdog !== undefined) {
            window.clearTimeout(startWatchdog)
            startWatchdog = undefined
          }
          if (maxWatchdog !== undefined) {
            window.clearTimeout(maxWatchdog)
            maxWatchdog = undefined
          }
        }

        const finish = () => {
          if (settled) return
          settled = true
          clearWatchdogs()
          activeUtterancesRef.current.delete(utterance)
          resolve()
        }

        activeUtterancesRef.current.add(utterance)
        activeControlRef.current = {
          issueId: item.id,
          gen,
          provider: 'browser',
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
          if (gen === cancelGenRef.current) setSpeechError('Browser voice playback timed out.')
          try {
            synth.cancel()
          } catch {
            // Ignore stalled cancel error.
          }
          queuedIdsRef.current.delete(item.id)
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
          finish()
        }, Math.max(BROWSER_SPEECH_MAX_MS, text.length * 120))

        utterance.onstart = () => {
          if (startWatchdog !== undefined) {
            window.clearTimeout(startWatchdog)
            startWatchdog = undefined
          }
          if (gen !== cancelGenRef.current || settled) return
          queuedIdsRef.current.delete(item.id)
          setSpeechError(null)
          if (item.mode === 'preview') return
          startedIdsRef.current.add(item.id)
          onStartedRef.current?.(item.id)
        }

        utterance.onend = () => {
          if (gen === cancelGenRef.current && !settled) queuedIdsRef.current.delete(item.id)
          finish()
        }

        utterance.onerror = (event) => {
          if (gen === cancelGenRef.current && !settled) {
            queuedIdsRef.current.delete(item.id)
            const errCode = event.error
            if (errCode !== 'canceled' && errCode !== 'interrupted') {
              setSpeechError(
                errCode === 'not-allowed'
                  ? 'The browser blocked spoken alerts. Check this site’s audio permissions.'
                  : 'The browser could not play the spoken alert.',
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
        } catch {
          queuedIdsRef.current.delete(item.id)
          if (gen === cancelGenRef.current) {
            setSpeechError('The browser could not start the spoken alert.')
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
        const text = composeSpokenText(item.issue, preferencesRef.current.speechStyle)

        let didStart = false

        const selectedVoice = item.voice ?? preferencesRef.current.elevenLabsVoice
        const canTryElevenLabs =
          elevenLabsConfiguredRef.current &&
          !blockedVoicesRef.current.has(selectedVoice) &&
          depsRef.current.now() >= elevenLabsCooldownUntilRef.current

        if (canTryElevenLabs) {
          const abortController = new AbortController()
          let timedOut = false
          const abortOnTimeout = () => {
            timedOut = true
            abortController.abort()
          }
          let timeoutId: number | undefined

          activeControlRef.current = {
            issueId: item.id,
            gen,
            provider: 'elevenlabs',
            cancel: () => {
              window.clearTimeout(timeoutId)
              abortController.abort()
            },
          }

          let needBrowserFallback = false
          try {
            for (const chunk of speechRequestChunks(text)) {
              if (gen !== cancelGenRef.current || abortController.signal.aborted) break
              window.clearTimeout(timeoutId)
              timeoutId = window.setTimeout(abortOnTimeout, SPEECH_REQUEST_TIMEOUT_MS)
              const response = await depsRef.current.requestSpeech(chunk, abortController.signal, { voice: selectedVoice })
              if (gen !== cancelGenRef.current || abortController.signal.aborted) break
              await depsRef.current.playAudio(response, {
                signal: abortController.signal,
                onStart: () => {
                  if (gen !== cancelGenRef.current || abortController.signal.aborted) return
                  window.clearTimeout(timeoutId)
                  timeoutId = window.setTimeout(abortOnTimeout, SPEECH_PLAYBACK_TIMEOUT_MS)
                  if (didStart) return
                  didStart = true
                  queuedIdsRef.current.delete(item.id)
                  setSpeechError(null)
                  if (item.mode === 'preview') return
                  startedIdsRef.current.add(item.id)
                  onStartedRef.current?.(item.id)
                },
              })
            }
            if (gen === cancelGenRef.current) queuedIdsRef.current.delete(item.id)
          } catch (err) {
            window.clearTimeout(timeoutId)
            if (
              gen !== cancelGenRef.current ||
              (!timedOut && (abortController.signal.aborted || isAbortError(err)))
            ) {
              continue
            }

            const effectiveErr = timedOut ? new Error('Speech playback timed out.') : err
            const browserFallback = !didStart && getSpeechSynthesisApi() !== null
            const reportFallback = (message: string) => {
              if (browserFallback) onFallbackRef.current?.(`${message} Trying the browser voice.`)
            }
            const cooldownMs = computeCooldownMs(effectiveErr)
            if (isVoiceSpecificFailure(effectiveErr)) {
              // Only this voice is unusable (e.g. needs a paid plan); keep ElevenLabs for others.
              if (!blockedVoicesRef.current.has(selectedVoice)) {
                blockedVoicesRef.current.add(selectedVoice)
                reportFallback(
                  effectiveErr instanceof Error && effectiveErr.message
                    ? effectiveErr.message
                    : 'Selected ElevenLabs voice is unavailable.',
                )
              }
            } else if (cooldownMs === Number.POSITIVE_INFINITY) {
              elevenLabsCooldownUntilRef.current = Number.POSITIVE_INFINITY
              if (!fallbackNotifiedRef.current) {
                fallbackNotifiedRef.current = true
                const msg =
                  effectiveErr instanceof Error && effectiveErr.message
                    ? effectiveErr.message
                    : 'ElevenLabs is unavailable.'
                reportFallback(msg)
              }
            } else {
              elevenLabsCooldownUntilRef.current = depsRef.current.now() + cooldownMs
            }

            if (!didStart) {
              if (browserFallback) {
                needBrowserFallback = true
              } else {
                queuedIdsRef.current.delete(item.id)
                setSpeechError(
                  effectiveErr instanceof Error && effectiveErr.message
                    ? effectiveErr.message
                    : 'Spoken alerts are unavailable. Corrections appear on the board.',
                )
              }
            } else {
              queuedIdsRef.current.delete(item.id)
              setSpeechError('The spoken alert was interrupted.')
            }
          } finally {
            window.clearTimeout(timeoutId)
            if (activeControlRef.current?.gen === gen) {
              activeControlRef.current = null
            }
          }

          if (needBrowserFallback && gen === cancelGenRef.current) {
            await speakViaBrowser(item, text, gen)
          }
        } else if (getSpeechSynthesisApi() !== null) {
          await speakViaBrowser(item, text, gen)
        } else {
          queuedIdsRef.current.delete(item.id)
          setSpeechError(BROWSER_VOICE_UNAVAILABLE)
        }
        if (item.mode === 'preview' && gen === cancelGenRef.current) {
          setPreviewingVoice(null)
        }
      }
    } finally {
      if (gen === cancelGenRef.current) {
        activeControlRef.current = null
        isProcessingRef.current = false
        setPreviewingVoice(null)
      }
    }
  }, [speakViaBrowser])

  const enqueueAutoAlerts = useCallback(
    (issues: readonly SpeakableAlert[]) => {
      let added = false
      for (const issue of issues) {
        if (queuedIdsRef.current.has(issue.id) || startedIdsRef.current.has(issue.id)) {
          continue
        }
        queuedIdsRef.current.add(issue.id)
        queueRef.current.push({ id: issue.id, issue, mode: 'auto' })
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
      cancelAll()
      unlockAudioPlayback()
      queuedIdsRef.current.add(issue.id)
      queueRef.current.push({ id: issue.id, issue, mode: 'manual' })
      void pumpQueue()
    },
    [cancelAll, pumpQueue],
  )

  const removePreview = useCallback(() => {
    queueRef.current = queueRef.current.filter((item) => item.mode !== 'preview')
    const active = activeControlRef.current
    if (active?.issueId === PREVIEW_ALERT_ID) {
      cancelGenRef.current += 1
      activeControlRef.current = null
      isProcessingRef.current = false
      active.cancel()
    }
  }, [])

  const stopPreview = useCallback(() => {
    removePreview()
    setPreviewingVoice(null)
    if (queueRef.current.length > 0) void pumpQueue()
  }, [pumpQueue, removePreview])

  /** Queues a short sample ahead of waiting alerts while preserving active speech. */
  const previewVoice = useCallback(
    (voice?: string) => {
      removePreview()
      unlockAudioPlayback()
      const voiceKey = voice ?? preferencesRef.current.elevenLabsVoice
      setPreviewingVoice(voiceKey)
      queueRef.current.unshift({
        id: PREVIEW_ALERT_ID,
        issue: PREVIEW_SAMPLE,
        mode: 'preview',
        voice: voiceKey,
      })
      void pumpQueue()
    },
    [pumpQueue, removePreview],
  )

  /**
   * Cancels queued or active announcements for findings that have resolved or been
   * dismissed so stale audio never finishes speaking after an issue leaves the board.
   */
  const syncActiveIssueIds = useCallback(
    (activeIds: ReadonlySet<string>) => {
      for (const issueId of startedIdsRef.current) {
        if (!activeIds.has(issueId)) startedIdsRef.current.delete(issueId)
      }
      if (queueRef.current.length > 0) {
        const nextQueue: QueuedSpeechItem[] = []
        for (const item of queueRef.current) {
          if (item.mode === 'preview' || activeIds.has(item.id)) {
            nextQueue.push(item)
          } else {
            queuedIdsRef.current.delete(item.id)
          }
        }
        queueRef.current = nextQueue
      }

      const active = activeControlRef.current
      if (active && active.issueId !== PREVIEW_ALERT_ID && !activeIds.has(active.issueId)) {
        cancelGenRef.current += 1
        activeControlRef.current = null
        isProcessingRef.current = false
        queuedIdsRef.current.delete(active.issueId)
        active.cancel()
        if (queueRef.current.length > 0) {
          void pumpQueue()
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
    speechError,
    enqueueAutoAlerts,
    speakNow,
    previewVoice,
    stopPreview,
    previewingVoice,
    cancelAll,
    resetHistory,
    syncActiveIssueIds,
    unlockAudio,
  }
}

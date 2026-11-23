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
export const PREVIEW_ALERT_ID = '__voice-preview__'
const PREVIEW_SAMPLE: SpeakableIssueText = {
  spoken_alert: 'The derivative of x squared should be two x.',
  explanation: 'The power rule brings the two down and reduces the exponent by one.',
}
const SPEECH_UNAVAILABLE_MESSAGE = 'Spoken alerts are unavailable. Corrections appear on the board.'

export interface UseSpeechAlertsOptions {
  elevenLabsConfigured?: boolean
  preferences?: VoicePreferences
  onUtteranceStarted?: (issueId: string) => void
  deps?: Partial<SpeechAlertDeps>
}

interface QueuedSpeechItem {
  id: string
  issue: SpeakableIssueText
  mode: 'auto' | 'preview'
  /** Voice override for previews; alerts use the current preference. */
  voice?: string
}

interface ActivePlaybackControl {
  issueId: string
  gen: number
  cancel: () => void
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
    deps: partialDeps,
  } = options

  const depsRef = useRef<SpeechAlertDeps>({ ...DEFAULT_DEPS, ...partialDeps })
  depsRef.current = { ...DEFAULT_DEPS, ...partialDeps }

  const onStartedRef = useRef(onUtteranceStarted)
  onStartedRef.current = onUtteranceStarted

  const elevenLabsConfiguredRef = useRef(elevenLabsConfigured)
  elevenLabsConfiguredRef.current = elevenLabsConfigured

  const preferencesRef = useRef(preferences)
  preferencesRef.current = preferences

  const isSupported = elevenLabsConfigured

  /** Voice key whose preview is currently queued or playing, for UI feedback. */
  const [previewingVoice, setPreviewingVoice] = useState<string | null>(null)
  const [speechError, setSpeechError] = useState<string | null>(null)

  const queueRef = useRef<QueuedSpeechItem[]>([])
  const queuedIdsRef = useRef<Set<string>>(new Set())
  const startedIdsRef = useRef<Set<string>>(new Set())
  const activeControlRef = useRef<ActivePlaybackControl | null>(null)
  const isProcessingRef = useRef(false)
  const cancelGenRef = useRef(0)
  const elevenLabsCooldownUntilRef = useRef(0)
  const blockedVoicesRef = useRef<Map<string, string>>(new Map())

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
    setPreviewingVoice(null)
  }, [])

  useEffect(() => {
    if (elevenLabsConfigured) {
      if (elevenLabsCooldownUntilRef.current === Number.POSITIVE_INFINITY) {
        elevenLabsCooldownUntilRef.current = 0
      }
      setSpeechError((prev) =>
        prev === SPEECH_UNAVAILABLE_MESSAGE ? null : prev,
      )
    } else {
      cancelAll()
      setSpeechError(null)
    }
  }, [cancelAll, elevenLabsConfigured])

  const resetHistory = useCallback(() => {
    cancelAll()
    startedIdsRef.current.clear()
    setSpeechError(null)
  }, [cancelAll])

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
        const blockedReason = blockedVoicesRef.current.get(selectedVoice)
        const canTryElevenLabs =
          elevenLabsConfiguredRef.current &&
          blockedReason === undefined &&
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
            cancel: () => {
              window.clearTimeout(timeoutId)
              abortController.abort()
            },
          }

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

            const effectiveErr = timedOut ? new Error('Voice playback timed out.') : err
            const cooldownMs = computeCooldownMs(effectiveErr)
            const errorMessage =
              effectiveErr instanceof Error && effectiveErr.message
                ? effectiveErr.message
                : SPEECH_UNAVAILABLE_MESSAGE

            if (isVoiceSpecificFailure(effectiveErr)) {
              // Only this voice is unusable (e.g. needs a paid plan); keep ElevenLabs for others.
              blockedVoicesRef.current.set(selectedVoice, errorMessage)
            } else if (cooldownMs === Number.POSITIVE_INFINITY) {
              elevenLabsCooldownUntilRef.current = Number.POSITIVE_INFINITY
            } else {
              elevenLabsCooldownUntilRef.current = depsRef.current.now() + cooldownMs
            }

            queuedIdsRef.current.delete(item.id)
            setSpeechError(didStart ? 'The spoken alert was interrupted.' : errorMessage)
          } finally {
            window.clearTimeout(timeoutId)
            if (activeControlRef.current?.gen === gen) {
              activeControlRef.current = null
            }
          }
        } else {
          queuedIdsRef.current.delete(item.id)
          if (blockedReason !== undefined) {
            setSpeechError(blockedReason)
          } else if (!elevenLabsConfiguredRef.current) {
            setSpeechError(SPEECH_UNAVAILABLE_MESSAGE)
          }
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
  }, [])

  const enqueueAutoAlerts = useCallback(
    (issues: readonly SpeakableAlert[]) => {
      if (!elevenLabsConfiguredRef.current) return
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
      if (!elevenLabsConfiguredRef.current) return
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
   * Cancels queued or active announcements for findings that have resolved so stale audio
   * never finishes speaking after an issue leaves the board.
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
    previewVoice,
    stopPreview,
    previewingVoice,
    cancelAll,
    resetHistory,
    syncActiveIssueIds,
    unlockAudio,
  }
}

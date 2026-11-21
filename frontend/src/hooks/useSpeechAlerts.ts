import { useCallback, useEffect, useRef, useState } from 'react'

export interface SpeakableAlert {
  id: string
  spoken_alert: string
}

export interface UseSpeechAlertsOptions {
  onUtteranceStarted?: (issueId: string) => void
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

export function useSpeechAlerts(options: UseSpeechAlertsOptions = {}) {
  const { onUtteranceStarted } = options
  const onStartedRef = useRef(onUtteranceStarted)
  onStartedRef.current = onUtteranceStarted

  const isSupported = getSpeechSynthesisApi() !== null
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [speechError, setSpeechError] = useState<string | null>(
    isSupported ? null : 'Web Speech Synthesis is unavailable in this browser; using visual alerts.',
  )

  const queuedIdsRef = useRef<Set<string>>(new Set())
  const startedIdsRef = useRef<Set<string>>(new Set())
  const activeUtterancesRef = useRef<Map<string, SpeechSynthesisUtterance>>(new Map())
  const cancelGenRef = useRef<number>(0)

  const refreshSpeakingFlag = useCallback(() => {
    setIsSpeaking(activeUtterancesRef.current.size > 0)
  }, [])

  const cancelAll = useCallback(() => {
    cancelGenRef.current += 1
    queuedIdsRef.current.clear()
    activeUtterancesRef.current.clear()
    setIsSpeaking(false)
    const synth = getSpeechSynthesisApi()
    if (synth) {
      try {
        synth.cancel()
      } catch {
        // Ignore browser speech cancel quirks.
      }
    }
  }, [])

  const resetHistory = useCallback(() => {
    cancelAll()
    startedIdsRef.current.clear()
    setSpeechError(
      getSpeechSynthesisApi()
        ? null
        : 'Web Speech Synthesis is unavailable in this browser; using visual alerts.',
    )
  }, [cancelAll])

  const dispatchUtterance = useCallback(
    (issue: SpeakableAlert, mode: 'auto' | 'manual') => {
      const synth = getSpeechSynthesisApi()
      if (!synth) {
        setSpeechError(
          'Speech synthesis is unavailable in this browser. Corrections remain visible on screen.',
        )
        return
      }

      const text = issue.spoken_alert.trim()
      if (!text) return

      if (mode === 'auto') {
        if (queuedIdsRef.current.has(issue.id) || startedIdsRef.current.has(issue.id)) {
          return
        }
      }

      if (mode === 'manual') {
        cancelAll()
      }

      const gen = cancelGenRef.current
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.rate = 1.0
      utterance.pitch = 1.0

      queuedIdsRef.current.add(issue.id)
      activeUtterancesRef.current.set(issue.id, utterance)
      refreshSpeakingFlag()

      utterance.onstart = () => {
        if (gen !== cancelGenRef.current) return
        queuedIdsRef.current.delete(issue.id)
        startedIdsRef.current.add(issue.id)
        setSpeechError(null)
        onStartedRef.current?.(issue.id)
      }

      utterance.onend = () => {
        queuedIdsRef.current.delete(issue.id)
        activeUtterancesRef.current.delete(issue.id)
        if (gen === cancelGenRef.current) {
          refreshSpeakingFlag()
        }
      }

      utterance.onerror = (event) => {
        queuedIdsRef.current.delete(issue.id)
        activeUtterancesRef.current.delete(issue.id)
        if (gen !== cancelGenRef.current) return
        refreshSpeakingFlag()
        const errCode = event.error
        if (errCode === 'canceled' || errCode === 'interrupted') {
          return
        }
        setSpeechError(
          errCode === 'not-allowed'
            ? 'Speech playback blocked by browser autoplay policy. Use Speak on a card to play audio.'
            : `Speech playback error (${errCode || 'unknown'}). Visual alerts remain active.`,
        )
      }

      try {
        synth.speak(utterance)
      } catch {
        queuedIdsRef.current.delete(issue.id)
        activeUtterancesRef.current.delete(issue.id)
        refreshSpeakingFlag()
        setSpeechError('Speech synthesis failed to start.')
      }
    },
    [cancelAll, refreshSpeakingFlag],
  )

  const enqueueAutoAlerts = useCallback(
    (issues: readonly SpeakableAlert[]) => {
      for (const issue of issues) {
        dispatchUtterance(issue, 'auto')
      }
    },
    [dispatchUtterance],
  )

  const speakNow = useCallback(
    (issue: SpeakableAlert) => {
      dispatchUtterance(issue, 'manual')
    },
    [dispatchUtterance],
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
    cancelAll,
    resetHistory,
  }
}

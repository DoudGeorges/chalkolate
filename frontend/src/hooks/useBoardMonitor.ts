import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import { ApiClientError, analyzeSnapshot } from '../api/client'
import {
  AnalysisMetadataPayload,
  AnalysisResponse,
  CalibrationCorners,
  SubjectHint,
} from '../api/schemas'
import {
  GrayscaleSample,
  MediaFrameSource,
  captureJpegBlob,
  computeMaskedMad,
  sampleGrayscaleFrame,
} from '../lib/frameCapture'
import { buildNormalizedQuadMask } from '../lib/geometry'
import {
  IssueTrackerState,
  TrackedIssue,
  clearNoLongerDetected,
  createInitialTrackerState,
  dismissIssue,
  markIssueSpoken,
  markIssueVerifying,
  reconcileAnalysis,
  resetDismissed,
  revertVerifyingOnFailure,
  undoLastDismissal,
} from '../lib/issueTracker'

export type MonitorPhase =
  | 'PAUSED'
  | 'WATCHING'
  | 'WRITING'
  | 'STABILIZING'
  | 'ANALYZING'

export interface MonitorApiError {
  message: string
  code: string
  retryAfterSeconds: number | null
}

export interface MonitorState {
  phase: MonitorPhase
  isResultStale: boolean
  boardSummary: string
  lastLatencyMs: number | null
  lastAnalyzedAt: number | null
  apiError: MonitorApiError | null
  tracker: IssueTrackerState
  hasAnalyzedCurrentSession: boolean
  lastAcceptedSettingsSig: string | null
  blockedFrameSignature: string | null
  rateLimitUntilMs: number | null
}

type MonitorAction =
  | { type: 'SET_PHASE'; phase: MonitorPhase }
  | { type: 'MARK_STALE' }
  | { type: 'RESET_SESSION' }
  | {
      type: 'COMMIT_ANALYSIS'
      response: AnalysisResponse
      nextTracker: IssueTrackerState
      settingsSig: string
      nowMs: number
    }
  | { type: 'FAIL_ANALYSIS'; error: MonitorApiError; frameSig: string; rateLimitUntilMs: number | null; fallbackPhase: MonitorPhase }
  | { type: 'CLEAR_API_ERROR' }
  | { type: 'DISMISS_ISSUE'; issueId: string }
  | { type: 'UNDO_DISMISSAL' }
  | { type: 'RESET_DISMISSED' }
  | { type: 'MARK_VERIFYING'; issueId: string }
  | { type: 'MARK_SPOKEN'; issueId: string }
  | { type: 'CLEAR_NO_LONGER_DETECTED'; issueId: string }

function createInitialMonitorState(paused: boolean): MonitorState {
  return {
    phase: paused ? 'PAUSED' : 'WATCHING',
    isResultStale: false,
    boardSummary: '',
    lastLatencyMs: null,
    lastAnalyzedAt: null,
    apiError: null,
    tracker: createInitialTrackerState(),
    hasAnalyzedCurrentSession: false,
    lastAcceptedSettingsSig: null,
    blockedFrameSignature: null,
    rateLimitUntilMs: null,
  }
}

function monitorReducer(state: MonitorState, action: MonitorAction): MonitorState {
  switch (action.type) {
    case 'SET_PHASE':
      if (state.phase === action.phase) return state
      return { ...state, phase: action.phase }

    case 'MARK_STALE':
      if (state.isResultStale || (!state.hasAnalyzedCurrentSession && state.tracker.issues.length === 0)) {
        return state
      }
      return { ...state, isResultStale: true }

    case 'RESET_SESSION':
      return {
        ...createInitialMonitorState(state.phase === 'PAUSED'),
      }

    case 'COMMIT_ANALYSIS': {
      return {
        ...state,
        phase: state.phase === 'PAUSED' ? 'PAUSED' : 'WATCHING',
        isResultStale: false,
        boardSummary: action.response.board_summary,
        lastLatencyMs: action.response.latency_ms,
        lastAnalyzedAt: action.nowMs,
        apiError: null,
        tracker: action.nextTracker,
        hasAnalyzedCurrentSession: true,
        lastAcceptedSettingsSig: action.settingsSig,
        blockedFrameSignature: null,
        rateLimitUntilMs: null,
      }
    }

    case 'FAIL_ANALYSIS':
      return {
        ...state,
        phase: state.phase === 'PAUSED' ? 'PAUSED' : action.fallbackPhase,
        isResultStale: state.hasAnalyzedCurrentSession ? true : state.isResultStale,
        apiError: action.error,
        tracker: revertVerifyingOnFailure(state.tracker),
        blockedFrameSignature: action.frameSig,
        rateLimitUntilMs: action.rateLimitUntilMs,
      }

    case 'CLEAR_API_ERROR':
      return {
        ...state,
        apiError: null,
        blockedFrameSignature: null,
      }

    case 'DISMISS_ISSUE':
      return {
        ...state,
        tracker: dismissIssue(state.tracker, action.issueId),
      }

    case 'UNDO_DISMISSAL':
      return {
        ...state,
        tracker: undoLastDismissal(state.tracker),
      }

    case 'RESET_DISMISSED':
      return {
        ...state,
        tracker: resetDismissed(state.tracker),
      }

    case 'MARK_VERIFYING':
      return {
        ...state,
        tracker: markIssueVerifying(state.tracker, action.issueId),
      }

    case 'MARK_SPOKEN':
      return {
        ...state,
        tracker: markIssueSpoken(state.tracker, action.issueId),
      }

    case 'CLEAR_NO_LONGER_DETECTED':
      return {
        ...state,
        tracker: clearNoLongerDetected(state.tracker, action.issueId),
      }
  }
}

// Motion & sampling invariants
export const SAMPLE_INTERVAL_MS = 400
export const MOTION_ENTER_MAD = 4.5
export const MOTION_EXIT_MAD = 2.8
export const QUIET_DRIFT_MAD = 5.5
export const CHANGE_THRESHOLD_MAD = 5.0
export const MIN_AUTO_INTERVAL_MS = 2500

export interface BoardMonitorDeps {
  sampleFrame: (source: MediaFrameSource, canvas: HTMLCanvasElement) => GrayscaleSample | null
  captureSnapshot: (
    source: MediaFrameSource,
    canvas: HTMLCanvasElement,
  ) => Promise<{ blob: Blob; width: number; height: number }>
  analyzeRequest: (
    blob: Blob,
    metadata: AnalysisMetadataPayload,
    signal: AbortSignal,
  ) => Promise<AnalysisResponse>
  now: () => number
  createUuid: () => string
}

const DEFAULT_DEPS: BoardMonitorDeps = {
  sampleFrame: (source, canvas) => sampleGrayscaleFrame(source, canvas, 160),
  captureSnapshot: (source, canvas) => captureJpegBlob(source, canvas, 1280),
  analyzeRequest: (blob, metadata, signal) => analyzeSnapshot(blob, metadata, signal),
  now: () => Date.now(),
  createUuid: () =>
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `00000000-0000-4000-8000-${Date.now().toString().padStart(12, '0').slice(-12)}`,
}

export interface UseBoardMonitorOptions {
  mediaSource: MediaFrameSource | null
  mediaReady: boolean
  sourceGeneration: number
  paused: boolean
  calibrationEditing: boolean
  committedCorners: CalibrationCorners | null
  subjectHint: SubjectHint
  deepMode: boolean
  enhanceChalkboard: boolean
  stabilizationMs: number
  clientDeadlineMs?: number
  onAcceptedFindings?: (newlyActivated: readonly TrackedIssue[]) => void
  onInvalidateSpeech?: () => void
  deps?: Partial<BoardMonitorDeps>
}

function buildSettingsSignature(opts: {
  subjectHint: SubjectHint
  deepMode: boolean
  enhanceChalkboard: boolean
  committedCorners: CalibrationCorners | null
}): string {
  return JSON.stringify([
    opts.subjectHint,
    opts.deepMode,
    opts.enhanceChalkboard,
    opts.committedCorners,
  ])
}

export function useBoardMonitor(options: UseBoardMonitorOptions) {
  const {
    mediaSource,
    mediaReady,
    sourceGeneration,
    paused,
    calibrationEditing,
    committedCorners,
    subjectHint,
    deepMode,
    enhanceChalkboard,
    stabilizationMs,
    clientDeadlineMs = 65_000,
    onAcceptedFindings,
    onInvalidateSpeech,
    deps: partialDeps,
  } = options

  const deps: BoardMonitorDeps = useMemo(
    () => ({ ...DEFAULT_DEPS, ...partialDeps }),
    [partialDeps],
  )

  const [state, dispatch] = useReducer(
    monitorReducer,
    paused,
    createInitialMonitorState,
  )
  const stateRef = useRef(state)
  stateRef.current = state

  const settingsSig = useMemo(
    () =>
      buildSettingsSignature({
        subjectHint,
        deepMode,
        enhanceChalkboard,
        committedCorners,
      }),
    [subjectHint, deepMode, enhanceChalkboard, committedCorners],
  )

  const runtimeRef = useRef({
    mediaSource,
    mediaReady,
    sourceGeneration,
    paused,
    calibrationEditing,
    committedCorners,
    subjectHint,
    deepMode,
    enhanceChalkboard,
    stabilizationMs,
    clientDeadlineMs,
    settingsSig,
    onAcceptedFindings,
    onInvalidateSpeech,
    deps,
  })
  runtimeRef.current = {
    mediaSource,
    mediaReady,
    sourceGeneration,
    paused,
    calibrationEditing,
    committedCorners,
    subjectHint,
    deepMode,
    enhanceChalkboard,
    stabilizationMs,
    clientDeadlineMs,
    settingsSig,
    onAcceptedFindings,
    onInvalidateSpeech,
    deps,
  }

  // Ownership and media capture refs
  const frameRevisionRef = useRef<number>(0)
  const requestSeqRef = useRef<number>(0)
  const inFlightRef = useRef<{
    seq: number
    abortController: AbortController
    settingsSig: string
    sourceGeneration: number
  } | null>(null)
  const pendingIntentRef = useRef<'auto' | 'manual' | null>(null)

  const prevSampleRef = useRef<GrayscaleSample | null>(null)
  const lastAcceptedSampleRef = useRef<GrayscaleSample | null>(null)
  const stableStartSampleRef = useRef<GrayscaleSample | null>(null)
  const stableSinceMsRef = useRef<number | null>(null)
  const isWritingRef = useRef<boolean>(false)
  const lastAutoDispatchMsRef = useRef<number>(0)

  const quadMaskRef = useRef<{
    cornersKey: string
    width: number
    height: number
    mask: Uint8Array | null
  }>({ cornersKey: '', width: 0, height: 0, mask: null })

  const sampleCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const captureCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const dispatchAnalysisRef = useRef<((intentKind: 'auto' | 'manual') => Promise<void>) | null>(
    null,
  )

  const getOrCreateCanvas = useCallback((ref: React.MutableRefObject<HTMLCanvasElement | null>) => {
    if (!ref.current) {
      ref.current = document.createElement('canvas')
    }
    return ref.current
  }, [])

  const getMaskForSample = useCallback(
    (corners: CalibrationCorners | null, sample: GrayscaleSample): Uint8Array | null => {
      if (!corners) return null
      const cornersKey = JSON.stringify(corners)
      const cached = quadMaskRef.current
      if (
        cached.cornersKey === cornersKey &&
        cached.width === sample.width &&
        cached.height === sample.height &&
        cached.mask !== null
      ) {
        return cached.mask
      }
      const mask = buildNormalizedQuadMask(corners, sample.width, sample.height)
      quadMaskRef.current = {
        cornersKey,
        width: sample.width,
        height: sample.height,
        mask,
      }
      return mask
    },
    [],
  )

  const abortInFlightAndClearPending = useCallback(() => {
    pendingIntentRef.current = null
    const active = inFlightRef.current
    if (active) {
      inFlightRef.current = null
      active.abortController.abort()
    }
  }, [])

  const resetSamplingBaselines = useCallback(() => {
    prevSampleRef.current = null
    lastAcceptedSampleRef.current = null
    stableStartSampleRef.current = null
    stableSinceMsRef.current = null
    isWritingRef.current = false
  }, [])

  const resetSession = useCallback(() => {
    frameRevisionRef.current += 1
    abortInFlightAndClearPending()
    resetSamplingBaselines()
    runtimeRef.current.onInvalidateSpeech?.()
    dispatch({ type: 'RESET_SESSION' })
  }, [abortInFlightAndClearPending, resetSamplingBaselines])

  // Reset session when source generation changes
  const prevSourceGenRef = useRef<number>(sourceGeneration)
  useEffect(() => {
    if (prevSourceGenRef.current !== sourceGeneration) {
      prevSourceGenRef.current = sourceGeneration
      resetSession()
    }
  }, [resetSession, sourceGeneration])

  // Committed calibration change resets summaries, tracking, dismissals, and speech history.
  const committedCornersKey = useMemo(
    () => JSON.stringify(committedCorners),
    [committedCorners],
  )
  const prevCornersKeyRef = useRef<string>(committedCornersKey)
  useEffect(() => {
    if (prevCornersKeyRef.current !== committedCornersKey) {
      prevCornersKeyRef.current = committedCornersKey
      resetSession()
    }
  }, [committedCornersKey, resetSession])

  // Analysis-setting changes (subject, deep mode, chalkboard enhance) invalidate old result
  // and replace pending intent with current settings without erasing dismissed history.
  const analysisSettingsKey = useMemo(
    () => JSON.stringify([subjectHint, deepMode, enhanceChalkboard]),
    [subjectHint, deepMode, enhanceChalkboard],
  )
  const prevAnalysisSettingsKeyRef = useRef<string>(analysisSettingsKey)
  useEffect(() => {
    if (prevAnalysisSettingsKeyRef.current !== analysisSettingsKey) {
      prevAnalysisSettingsKeyRef.current = analysisSettingsKey
      runtimeRef.current.onInvalidateSpeech?.()
      dispatch({ type: 'MARK_STALE' })
      dispatch({ type: 'CLEAR_API_ERROR' })
      if (!runtimeRef.current.paused && !runtimeRef.current.calibrationEditing) {
        pendingIntentRef.current =
          pendingIntentRef.current === 'manual' ? 'manual' : 'auto'
      }
    }
  }, [analysisSettingsKey])

  // Pause or entering calibration edit aborts local work and clears pending intents.
  useEffect(() => {
    if (paused || calibrationEditing) {
      abortInFlightAndClearPending()
      stableStartSampleRef.current = null
      stableSinceMsRef.current = null
      isWritingRef.current = false
      if (paused) {
        runtimeRef.current.onInvalidateSpeech?.()
        dispatch({ type: 'SET_PHASE', phase: 'PAUSED' })
      } else {
        dispatch({ type: 'SET_PHASE', phase: 'WATCHING' })
      }
    } else if (stateRef.current.phase === 'PAUSED') {
      dispatch({ type: 'SET_PHASE', phase: 'WATCHING' })
    }
  }, [abortInFlightAndClearPending, calibrationEditing, paused])

  const dispatchAnalysis = useCallback(
    async (intentKind: 'auto' | 'manual') => {
      const rt = runtimeRef.current
      if (!rt.mediaSource || !rt.mediaReady) return
      if (rt.paused || rt.calibrationEditing) return
      if (inFlightRef.current !== null) return

      const seq = ++requestSeqRef.current
      const snapshotSourceGen = rt.sourceGeneration
      const snapshotFrameRev = frameRevisionRef.current
      const snapshotSettingsSig = rt.settingsSig
      const snapshotCorners = rt.committedCorners
      const snapshotSubject = rt.subjectHint
      const snapshotDeepMode = rt.deepMode
      const snapshotEnhance = rt.enhanceChalkboard
      const snapshotPrevSummary = stateRef.current.boardSummary
      const snapshotRequestId = rt.deps.createUuid()
      const nowMs = rt.deps.now()

      if (intentKind === 'auto') {
        lastAutoDispatchMsRef.current = nowMs
      }

      const abortController = new AbortController()
      inFlightRef.current = {
        seq,
        abortController,
        settingsSig: snapshotSettingsSig,
        sourceGeneration: snapshotSourceGen,
      }
      dispatch({ type: 'SET_PHASE', phase: 'ANALYZING' })

      const deadlineTimer = window.setTimeout(() => {
        if (inFlightRef.current?.seq === seq) {
          abortController.abort()
        }
      }, rt.clientDeadlineMs)

      const isStillOwner = (): boolean => {
        const latest = runtimeRef.current
        if (abortController.signal.aborted) return false
        if (latest.paused || latest.calibrationEditing) return false
        if (latest.sourceGeneration !== snapshotSourceGen) return false
        if (latest.settingsSig !== snapshotSettingsSig) return false
        if (frameRevisionRef.current !== snapshotFrameRev) return false
        if (inFlightRef.current?.seq !== seq) return false
        return true
      }

      let settledPhaseHandled = false
      try {
        // Capture the latest frame at dispatch time (not enqueue time).
        const sampleCanvas = getOrCreateCanvas(sampleCanvasRef)
        const captureCanvas = getOrCreateCanvas(captureCanvasRef)
        const dispatchedSample = rt.deps.sampleFrame(rt.mediaSource, sampleCanvas)
        const captured = await rt.deps.captureSnapshot(rt.mediaSource, captureCanvas)

        if (!isStillOwner()) {
          return
        }

        const metadata: AnalysisMetadataPayload = {
          request_id: snapshotRequestId,
          previous_board_summary: snapshotPrevSummary,
          subject_hint: snapshotSubject,
          corners: snapshotCorners,
          deep_mode: snapshotDeepMode,
          enhance_chalkboard: snapshotEnhance,
        }

        const response = await rt.deps.analyzeRequest(
          captured.blob,
          metadata,
          abortController.signal,
        )

        if (!isStillOwner()) {
          return
        }

        if (dispatchedSample) {
          lastAcceptedSampleRef.current = dispatchedSample
        }
        const commitNow = rt.deps.now()
        const reconciled = reconcileAnalysis(stateRef.current.tracker, response.errors)
        dispatch({
          type: 'COMMIT_ANALYSIS',
          response,
          nextTracker: reconciled.nextState,
          settingsSig: snapshotSettingsSig,
          nowMs: commitNow,
        })
        settledPhaseHandled = true
        if (reconciled.newlyActivatedIssues.length > 0) {
          rt.onAcceptedFindings?.(reconciled.newlyActivatedIssues)
        }
      } catch (err) {
        if (abortController.signal.aborted || !isStillOwner()) {
          return
        }

        const latest = runtimeRef.current
        const failNow = latest.deps.now()
        let code = 'ANALYSIS_FAILED'
        let message = 'Snapshot analysis failed.'
        let retryAfterSeconds: number | null = null

        if (err instanceof ApiClientError) {
          code = err.code
          message = err.message
          retryAfterSeconds = err.retryAfterSeconds
        } else if (err instanceof Error && err.message) {
          message = err.message
        }

        const rateLimitUntilMs =
          retryAfterSeconds !== null ? failNow + retryAfterSeconds * 1000 : null

        dispatch({
          type: 'FAIL_ANALYSIS',
          error: { message, code, retryAfterSeconds },
          frameSig: `${snapshotSourceGen}:${snapshotFrameRev}:${snapshotSettingsSig}`,
          rateLimitUntilMs,
          fallbackPhase: isWritingRef.current ? 'WRITING' : 'WATCHING',
        })
        settledPhaseHandled = true
      } finally {
        window.clearTimeout(deadlineTimer)
        // Release ONLY our own request slot; never erase a newer slot or newer pending intent.
        if (inFlightRef.current?.seq === seq) {
          inFlightRef.current = null
          if (
            !runtimeRef.current.paused &&
            !runtimeRef.current.calibrationEditing &&
            pendingIntentRef.current === 'manual'
          ) {
            pendingIntentRef.current = null
            queueMicrotask(() => {
              void dispatchAnalysisRef.current?.('manual')
            })
          } else if (!settledPhaseHandled && !runtimeRef.current.paused) {
            dispatch({
              type: 'SET_PHASE',
              phase: isWritingRef.current ? 'WRITING' : 'WATCHING',
            })
          }
        }
      }
    },
    [getOrCreateCanvas],
  )
  dispatchAnalysisRef.current = dispatchAnalysis

  const tick = useCallback(() => {
    const rt = runtimeRef.current
    const curState = stateRef.current
    const nowMs = rt.deps.now()

    if (rt.paused || rt.calibrationEditing) {
      return
    }

    if (!rt.mediaSource || !rt.mediaReady) {
      if (inFlightRef.current === null) {
        dispatch({ type: 'SET_PHASE', phase: 'WATCHING' })
      }
      return
    }

    // 1. Sample low-res grayscale frame even while inference runs.
    const sampleCanvas = getOrCreateCanvas(sampleCanvasRef)
    const sample = rt.deps.sampleFrame(rt.mediaSource, sampleCanvas)
    if (!sample) return

    const mask = getMaskForSample(rt.committedCorners, sample)
    const prevSample = prevSampleRef.current
    prevSampleRef.current = sample

    const frameMad = prevSample ? computeMaskedMad(prevSample, sample, mask) : 0

    // Motion hysteresis + quiet-window accumulated drift check
    if (prevSample) {
      if (isWritingRef.current) {
        if (frameMad <= MOTION_EXIT_MAD) {
          isWritingRef.current = false
          stableStartSampleRef.current = sample
          stableSinceMsRef.current = nowMs
        } else {
          frameRevisionRef.current += 1
          stableStartSampleRef.current = null
          stableSinceMsRef.current = null
        }
      } else if (frameMad > MOTION_ENTER_MAD) {
        isWritingRef.current = true
        frameRevisionRef.current += 1
        stableStartSampleRef.current = null
        stableSinceMsRef.current = null
        rt.onInvalidateSpeech?.()
        dispatch({ type: 'MARK_STALE' })
      } else if (stableStartSampleRef.current && stableSinceMsRef.current !== null) {
        const quietDrift = computeMaskedMad(stableStartSampleRef.current, sample, mask)
        if (quietDrift > QUIET_DRIFT_MAD) {
          isWritingRef.current = true
          frameRevisionRef.current += 1
          stableStartSampleRef.current = null
          stableSinceMsRef.current = null
          rt.onInvalidateSpeech?.()
          dispatch({ type: 'MARK_STALE' })
        }
      } else {
        stableStartSampleRef.current = sample
        stableSinceMsRef.current = nowMs
      }
    } else {
      isWritingRef.current = false
      stableStartSampleRef.current = sample
      stableSinceMsRef.current = nowMs
    }

    // If inference is active, keep phase ANALYZING; if motion occurred, mark stale and queue recheck.
    if (inFlightRef.current !== null) {
      if (isWritingRef.current && pendingIntentRef.current !== 'manual') {
        pendingIntentRef.current = 'auto'
      }
      return
    }

    // 2. Manual intent takes precedence and bypasses the quiet interval.
    if (pendingIntentRef.current === 'manual') {
      pendingIntentRef.current = null
      void dispatchAnalysis('manual')
      return
    }

    // 3. Reflect writing vs stabilizing vs watching phases.
    if (isWritingRef.current) {
      dispatch({ type: 'SET_PHASE', phase: 'WRITING' })
      return
    }

    const stableElapsed =
      stableSinceMsRef.current !== null ? nowMs - stableSinceMsRef.current : 0
    const settingsChanged = curState.lastAcceptedSettingsSig !== rt.settingsSig
    const hasBaseline =
      curState.hasAnalyzedCurrentSession && lastAcceptedSampleRef.current !== null
    const cumulativeDelta =
      hasBaseline && lastAcceptedSampleRef.current
        ? computeMaskedMad(lastAcceptedSampleRef.current, sample, mask)
        : 255
    const needsAutoAnalysis =
      !curState.hasAnalyzedCurrentSession ||
      settingsChanged ||
      cumulativeDelta >= CHANGE_THRESHOLD_MAD ||
      pendingIntentRef.current === 'auto'

    if (!needsAutoAnalysis) {
      dispatch({ type: 'SET_PHASE', phase: 'WATCHING' })
      return
    }

    if (stableElapsed < rt.stabilizationMs) {
      dispatch({ type: 'SET_PHASE', phase: 'STABILIZING' })
      return
    }

    const currentFrameSig = `${rt.sourceGeneration}:${frameRevisionRef.current}:${rt.settingsSig}`
    if (curState.blockedFrameSignature === currentFrameSig) {
      dispatch({ type: 'SET_PHASE', phase: 'WATCHING' })
      return
    }

    if (curState.rateLimitUntilMs !== null && nowMs < curState.rateLimitUntilMs) {
      dispatch({ type: 'SET_PHASE', phase: 'WATCHING' })
      return
    }

    if (nowMs - lastAutoDispatchMsRef.current < MIN_AUTO_INTERVAL_MS) {
      dispatch({ type: 'SET_PHASE', phase: 'STABILIZING' })
      return
    }

    pendingIntentRef.current = null
    void dispatchAnalysis('auto')
  }, [dispatchAnalysis, getMaskForSample, getOrCreateCanvas])

  // Single Strict-Mode-safe sampling loop
  useEffect(() => {
    let disposed = false
    const timer = window.setInterval(() => {
      if (!disposed) {
        tick()
      }
    }, SAMPLE_INTERVAL_MS)

    // Perform an immediate initial tick once media becomes ready.
    if (mediaReady && !paused && !calibrationEditing) {
      tick()
    }

    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [calibrationEditing, mediaReady, paused, tick])

  // Cleanup on unmount: abort any in-flight request
  useEffect(() => {
    return () => {
      abortInFlightAndClearPending()
    }
  }, [abortInFlightAndClearPending])

  const requestCheckNow = useCallback(() => {
    if (runtimeRef.current.paused || runtimeRef.current.calibrationEditing) return
    if (!runtimeRef.current.mediaSource || !runtimeRef.current.mediaReady) return

    dispatch({ type: 'CLEAR_API_ERROR' })
    if (inFlightRef.current !== null) {
      // At most one coalesced pending intent; manual overrides auto.
      pendingIntentRef.current = 'manual'
      return
    }
    pendingIntentRef.current = null
    void dispatchAnalysis('manual')
  }, [dispatchAnalysis])

  const handleVideoSeek = useCallback(() => {
    frameRevisionRef.current += 1
    stableStartSampleRef.current = null
    stableSinceMsRef.current = null
    prevSampleRef.current = null
    isWritingRef.current = false
    runtimeRef.current.onInvalidateSpeech?.()
    dispatch({ type: 'MARK_STALE' })
    dispatch({ type: 'CLEAR_API_ERROR' })
    if (inFlightRef.current !== null) {
      pendingIntentRef.current =
        pendingIntentRef.current === 'manual' ? 'manual' : 'auto'
    }
  }, [])

  const handleGeometryChange = useCallback(() => {
    frameRevisionRef.current += 1
    prevSampleRef.current = null
    stableStartSampleRef.current = null
    stableSinceMsRef.current = null
    runtimeRef.current.onInvalidateSpeech?.()
    dispatch({ type: 'MARK_STALE' })
  }, [])

  const dismiss = useCallback((issueId: string) => {
    dispatch({ type: 'DISMISS_ISSUE', issueId })
  }, [])

  const undoDismissal = useCallback(() => {
    dispatch({ type: 'UNDO_DISMISSAL' })
  }, [])

  const clearAllDismissals = useCallback(() => {
    dispatch({ type: 'RESET_DISMISSED' })
  }, [])

  const markFixed = useCallback(
    (issueId: string) => {
      dispatch({ type: 'MARK_VERIFYING', issueId })
      requestCheckNow()
    },
    [requestCheckNow],
  )

  const markSpoken = useCallback((issueId: string) => {
    dispatch({ type: 'MARK_SPOKEN', issueId })
  }, [])

  const dismissNoLongerDetected = useCallback((issueId: string) => {
    dispatch({ type: 'CLEAR_NO_LONGER_DETECTED', issueId })
  }, [])

  return {
    state,
    requestCheckNow,
    resetSession,
    handleVideoSeek,
    handleGeometryChange,
    dismiss,
    undoDismissal,
    clearAllDismissals,
    markFixed,
    markSpoken,
    dismissNoLongerDetected,
  }
}

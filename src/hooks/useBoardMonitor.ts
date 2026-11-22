import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import { ApiClientError, analyzeSnapshot } from '../api/client'
import {
  AnalysisMetadataPayload,
  AnalysisResponse,
  AnswerFormat,
  CalibrationCorners,
} from '../api/schemas'
import {
  DetectorState,
  RegionStatus,
  classifyRegion,
  createDetectorState,
  isRegionCalm,
  updateDetector,
} from '../lib/changeDetector'
import {
  GrayscaleSample,
  MediaFrameSource,
  captureJpegBlob,
  sampleGrayscaleFrame,
} from '../lib/frameCapture'
import { buildNormalizedQuadMask } from '../lib/geometry'
import { createRequestId } from '../lib/requestId'
import {
  IssueTrackerState,
  TrackedIssue,
  clearPendingVerification,
  createInitialTrackerState,
  dismissIssue,
  getIssuesPendingRecheck,
  markIssueSpoken,
  reconcileAnalysis,
  requestVerification,
  resetDismissed,
  undoLastDismissal,
} from '../lib/issueTracker'

export type MonitorPhase = 'STOPPED' | 'WATCHING' | 'WRITING' | 'ANALYZING'

export interface MonitorApiError {
  message: string
  code: string
  retryAfterSeconds: number | null
}

export interface MonitorState {
  phase: MonitorPhase
  tracker: IssueTrackerState
  boardSummary: string
  lastLatencyMs: number | null
  lastAnalyzedAt: number | null
  apiError: MonitorApiError | null
  hasAnalyzed: boolean
  locationsUnverified: boolean
  backoffUntilMs: number | null
  consecutiveFailures: number
}

type MonitorAction =
  | { type: 'SET_PHASE'; phase: MonitorPhase }
  | { type: 'RESET_SESSION'; monitoring: boolean }
  | {
      type: 'COMMIT_ANALYSIS'
      response: AnalysisResponse
      nextTracker: IssueTrackerState
      nowMs: number
    }
  | {
      type: 'FAIL_ANALYSIS'
      error: MonitorApiError
      backoffUntilMs: number
      fallbackPhase: MonitorPhase
    }
  | { type: 'CLEAR_API_ERROR' }
  | { type: 'DISMISS_ISSUE'; issueId: string }
  | { type: 'UNDO_DISMISSAL' }
  | { type: 'RESET_DISMISSED' }
  | { type: 'REQUEST_VERIFICATION'; issueId: string }
  | { type: 'MARK_SPOKEN'; issueId: string }

function createInitialMonitorState(monitoring: boolean): MonitorState {
  return {
    phase: monitoring ? 'WATCHING' : 'STOPPED',
    tracker: createInitialTrackerState(),
    boardSummary: '',
    lastLatencyMs: null,
    lastAnalyzedAt: null,
    apiError: null,
    hasAnalyzed: false,
    locationsUnverified: false,
    backoffUntilMs: null,
    consecutiveFailures: 0,
  }
}

function monitorReducer(state: MonitorState, action: MonitorAction): MonitorState {
  switch (action.type) {
    case 'SET_PHASE':
      if (state.phase === action.phase) return state
      return { ...state, phase: action.phase }

    case 'RESET_SESSION':
      return createInitialMonitorState(action.monitoring)

    case 'COMMIT_ANALYSIS':
      return {
        ...state,
        phase: state.phase === 'STOPPED' ? 'STOPPED' : 'WATCHING',
        tracker: action.nextTracker,
        boardSummary: action.response.board_summary,
        lastLatencyMs: action.response.latency_ms,
        lastAnalyzedAt: action.nowMs,
        apiError: null,
        hasAnalyzed: true,
        locationsUnverified: false,
        backoffUntilMs: null,
        consecutiveFailures: 0,
      }

    case 'FAIL_ANALYSIS':
      return {
        ...state,
        phase: state.phase === 'STOPPED' ? 'STOPPED' : action.fallbackPhase,
        apiError: action.error,
        tracker: clearPendingVerification(state.tracker),
        backoffUntilMs: action.backoffUntilMs,
        consecutiveFailures: state.consecutiveFailures + 1,
      }

    case 'CLEAR_API_ERROR':
      return {
        ...state,
        apiError: null,
        backoffUntilMs: null,
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

    case 'REQUEST_VERIFICATION':
      return {
        ...state,
        tracker: requestVerification(state.tracker, action.issueId),
      }

    case 'MARK_SPOKEN':
      return {
        ...state,
        tracker: markIssueSpoken(state.tracker, action.issueId),
      }
  }
}

export const SAMPLE_INTERVAL_MS = 160
export const CALM_MOVING_FRACTION = 0.30
export const MAX_CHANGE_WAIT_MS = 750
export const MIN_DISPATCH_GAP_MS = 250
export const VERIFY_RECHECK_DELAY_MS = 800
export const MAX_FAILURE_BACKOFF_MS = 20_000

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
  sampleFrame: (source, canvas) => sampleGrayscaleFrame(source, canvas, 320),
  captureSnapshot: (source, canvas) => captureJpegBlob(source, canvas, 1600),
  analyzeRequest: (blob, metadata, signal) => analyzeSnapshot(blob, metadata, signal),
  now: () => Date.now(),
  createUuid: createRequestId,
}

export interface VerificationResultSummary {
  resolved: readonly TrackedIssue[]
  stillPresent: readonly TrackedIssue[]
}

export interface UseBoardMonitorOptions {
  mediaSource: MediaFrameSource | null
  mediaReady: boolean
  sourceGeneration: number
  monitoring: boolean
  calibrationEditing: boolean
  committedCorners: CalibrationCorners | null
  clientDeadlineMs?: number
  answerFormat?: AnswerFormat
  onNewFindings?: (newlyOpened: readonly TrackedIssue[]) => void
  onInvalidateSpeech?: () => void
  onVerificationResult?: (result: VerificationResultSummary) => void
  deps?: Partial<BoardMonitorDeps>
}

export function useBoardMonitor(options: UseBoardMonitorOptions) {
  const {
    mediaSource,
    mediaReady,
    sourceGeneration,
    monitoring,
    calibrationEditing,
    committedCorners,
    clientDeadlineMs = 30_000,
    answerFormat = 'exact',
    onNewFindings,
    onInvalidateSpeech,
    onVerificationResult,
    deps: partialDeps,
  } = options

  const deps: BoardMonitorDeps = useMemo(
    () => ({ ...DEFAULT_DEPS, ...partialDeps }),
    [partialDeps],
  )

  const [state, dispatch] = useReducer(
    monitorReducer,
    monitoring,
    createInitialMonitorState,
  )
  const stateRef = useRef(state)
  stateRef.current = state

  const settingsSig = useMemo(
    () => JSON.stringify(committedCorners),
    [committedCorners],
  )

  const runtimeRef = useRef({
    mediaSource,
    mediaReady,
    sourceGeneration,
    monitoring,
    calibrationEditing,
    committedCorners,
    clientDeadlineMs,
    answerFormat,
    settingsSig,
    onNewFindings,
    onInvalidateSpeech,
    onVerificationResult,
    deps,
  })
  runtimeRef.current = {
    mediaSource,
    mediaReady,
    sourceGeneration,
    monitoring,
    calibrationEditing,
    committedCorners,
    clientDeadlineMs,
    answerFormat,
    settingsSig,
    onNewFindings,
    onInvalidateSpeech,
    onVerificationResult,
    deps,
  }

  const sessionGenRef = useRef<number>(0)
  const requestSeqRef = useRef<number>(0)
  const inFlightRef = useRef<{
    seq: number
    abortController: AbortController
  } | null>(null)
  const pendingIntentRef = useRef<'auto' | 'manual' | null>(null)

  const detectorStateRef = useRef<DetectorState>(createDetectorState())
  const baselineRef = useRef<GrayscaleSample | null>(null)
  const lastSampleRef = useRef<GrayscaleSample | null>(null)
  const changeFirstSeenAtRef = useRef<number | null>(null)
  const lastSettledAtRef = useRef<number>(0)
  const backoffUntilMsRef = useRef<number | null>(null)
  const lastMovingFractionRef = useRef<number>(0)
  const lastPersistentCountRef = useRef<number>(0)

  const quadMaskRef = useRef<{
    cornersKey: string
    width: number
    height: number
    mask: Uint8Array | null
  }>({ cornersKey: '', width: 0, height: 0, mask: null })

  const sampleCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const captureCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const dispatchAnalysisRef = useRef<(() => Promise<void>) | null>(null)

  const getOrCreateCanvas = useCallback(
    (ref: React.MutableRefObject<HTMLCanvasElement | null>) => {
      if (!ref.current) {
        ref.current = document.createElement('canvas')
      }
      return ref.current
    },
    [],
  )

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

  const resetDetectionState = useCallback(() => {
    detectorStateRef.current = createDetectorState()
    baselineRef.current = null
    lastSampleRef.current = null
    changeFirstSeenAtRef.current = null
    backoffUntilMsRef.current = null
    lastMovingFractionRef.current = 0
    lastPersistentCountRef.current = 0
  }, [])

  const resetSession = useCallback(() => {
    sessionGenRef.current += 1
    abortInFlightAndClearPending()
    resetDetectionState()
    runtimeRef.current.onInvalidateSpeech?.()
    dispatch({ type: 'RESET_SESSION', monitoring: runtimeRef.current.monitoring })
  }, [abortInFlightAndClearPending, resetDetectionState])

  // Source replacement resets the entire session cleanly.
  const prevSourceGenRef = useRef<number>(sourceGeneration)
  useEffect(() => {
    if (prevSourceGenRef.current !== sourceGeneration) {
      prevSourceGenRef.current = sourceGeneration
      resetSession()
    }
  }, [resetSession, sourceGeneration])

  // Committed calibration changes clear session tracking/summaries (old coordinates are invalid).
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

  // Stop/Start and calibration edit transitions.
  useEffect(() => {
    if (!monitoring || calibrationEditing) {
      abortInFlightAndClearPending()
      changeFirstSeenAtRef.current = null
      if (!monitoring) {
        runtimeRef.current.onInvalidateSpeech?.()
        dispatch({ type: 'SET_PHASE', phase: 'STOPPED' })
      } else {
        dispatch({ type: 'SET_PHASE', phase: 'WATCHING' })
      }
    } else {
      dispatch({ type: 'SET_PHASE', phase: 'WATCHING' })
    }
  }, [abortInFlightAndClearPending, calibrationEditing, monitoring])

  const dispatchAnalysis = useCallback(async () => {
      const rt = runtimeRef.current
      if (!rt.mediaSource || !rt.mediaReady) return
      if (!rt.monitoring || rt.calibrationEditing) return
      if (inFlightRef.current !== null) return

      const seq = ++requestSeqRef.current
      const snapshotSourceGen = rt.sourceGeneration
      const snapshotSessionGen = sessionGenRef.current
      const snapshotSettingsSig = rt.settingsSig
      const snapshotCorners = rt.committedCorners
      const snapshotPrevSummary = stateRef.current.boardSummary
      const snapshotRequestId = rt.deps.createUuid()

      const abortController = new AbortController()
      inFlightRef.current = { seq, abortController }
      dispatch({ type: 'SET_PHASE', phase: 'ANALYZING' })

      const deadlineTimer = window.setTimeout(() => {
        if (inFlightRef.current?.seq === seq) {
          abortController.abort()
        }
      }, rt.clientDeadlineMs)

      // Motion during inference does NOT invalidate ownership; only stop, source/session reset,
      // calibration edit, or settings change invalidates.
      const isStillOwner = (): boolean => {
        const latest = runtimeRef.current
        if (abortController.signal.aborted) return false
        if (!latest.monitoring || latest.calibrationEditing) return false
        if (latest.sourceGeneration !== snapshotSourceGen) return false
        if (sessionGenRef.current !== snapshotSessionGen) return false
        if (latest.settingsSig !== snapshotSettingsSig) return false
        if (inFlightRef.current?.seq !== seq) return false
        return true
      }

      let settledPhaseHandled = false
      try {
        const sampleCanvas = getOrCreateCanvas(sampleCanvasRef)
        const captureCanvas = getOrCreateCanvas(captureCanvasRef)
        const dispatchSample =
          lastSampleRef.current ?? rt.deps.sampleFrame(rt.mediaSource, sampleCanvas)
        const dispatchStillTicks = new Uint16Array(detectorStateRef.current.stillTicks)
        const captured = await rt.deps.captureSnapshot(rt.mediaSource, captureCanvas)

        if (!isStillOwner()) {
          return
        }

        const metadata: AnalysisMetadataPayload = {
          request_id: snapshotRequestId,
          previous_board_summary: snapshotPrevSummary,
          answer_format: rt.answerFormat,
          corners: snapshotCorners,
        }

        const response = await rt.deps.analyzeRequest(
          captured.blob,
          metadata,
          abortController.signal,
        )

        if (!isStillOwner()) {
          return
        }

        const commitSample =
          dispatchSample ?? rt.deps.sampleFrame(rt.mediaSource, sampleCanvas)
        if (commitSample) {
          baselineRef.current = commitSample
        }
        changeFirstSeenAtRef.current = null
        backoffUntilMsRef.current = null
        lastSettledAtRef.current = rt.deps.now()

        const mask = commitSample
          ? getMaskForSample(snapshotCorners, commitSample)
          : null

        const classifyIssueRegion = (issue: TrackedIssue): RegionStatus => {
          if (response.incomplete || !commitSample) return 'obscured'
          const atDispatch = classifyRegion(
            issue.box_2d,
            issue.lastSeenSample,
            commitSample,
            dispatchStillTicks,
            mask,
          )
          if (atDispatch !== 'obscured') {
            return atDispatch
          }
          const latestSample = lastSampleRef.current
          const latestTicks = detectorStateRef.current.stillTicks
          if (
            latestSample &&
            classifyRegion(issue.box_2d, commitSample, latestSample, latestTicks, mask) ===
              'unchanged'
          ) {
            return classifyRegion(
              issue.box_2d,
              issue.lastSeenSample,
              commitSample,
              latestTicks,
              mask,
            )
          }
          return 'obscured'
        }

        const reconciled = reconcileAnalysis(stateRef.current.tracker, response.errors, {
          sample:
            commitSample ??
            ({ width: 1, height: 1, data: new Uint8Array(1) } as GrayscaleSample),
          classify: classifyIssueRegion,
          relaxSpatial: false,
        })

        dispatch({
          type: 'COMMIT_ANALYSIS',
          response,
          nextTracker: reconciled.nextState,
          nowMs: lastSettledAtRef.current,
        })
        settledPhaseHandled = true

        if (reconciled.newlyOpened.length > 0) {
          rt.onNewFindings?.(reconciled.newlyOpened)
        }
        if (
          reconciled.verifiedResolved.length > 0 ||
          reconciled.verifiedStillPresent.length > 0
        ) {
          rt.onVerificationResult?.({
            resolved: reconciled.verifiedResolved,
            stillPresent: reconciled.verifiedStillPresent,
          })
        }
      } catch (err) {
        if (abortController.signal.aborted || !isStillOwner()) {
          return
        }

        const latest = runtimeRef.current
        const failNow = latest.deps.now()
        lastSettledAtRef.current = failNow

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

        const nextFailureCount = stateRef.current.consecutiveFailures + 1
        const backoffMs =
          retryAfterSeconds !== null
            ? retryAfterSeconds * 1000
            : Math.min(MAX_FAILURE_BACKOFF_MS, 2000 * 2 ** (nextFailureCount - 1))
        const backoffUntilMs = failNow + backoffMs
        backoffUntilMsRef.current = backoffUntilMs

        dispatch({
          type: 'FAIL_ANALYSIS',
          error: { message, code, retryAfterSeconds },
          backoffUntilMs,
          fallbackPhase:
            lastPersistentCountRef.current > 0 ||
            lastMovingFractionRef.current >= CALM_MOVING_FRACTION
              ? 'WRITING'
              : 'WATCHING',
        })
        settledPhaseHandled = true
      } finally {
        window.clearTimeout(deadlineTimer)
        if (inFlightRef.current?.seq === seq) {
          inFlightRef.current = null
          if (
            runtimeRef.current.monitoring &&
            !runtimeRef.current.calibrationEditing &&
            pendingIntentRef.current === 'manual'
          ) {
            pendingIntentRef.current = null
            queueMicrotask(() => {
              void dispatchAnalysisRef.current?.()
            })
          } else if (!settledPhaseHandled && runtimeRef.current.monitoring) {
            dispatch({ type: 'SET_PHASE', phase: 'WATCHING' })
          }
        }
      }
    },
    [getMaskForSample, getOrCreateCanvas],
  )
  dispatchAnalysisRef.current = dispatchAnalysis

  const tick = useCallback(() => {
    const rt = runtimeRef.current
    const curState = stateRef.current
    const nowMs = rt.deps.now()

    if (!rt.monitoring || rt.calibrationEditing) {
      return
    }
    if (!rt.mediaSource || !rt.mediaReady) {
      if (inFlightRef.current === null) {
        dispatch({ type: 'SET_PHASE', phase: 'WATCHING' })
      }
      return
    }

    const sampleCanvas = getOrCreateCanvas(sampleCanvasRef)
    const sample = rt.deps.sampleFrame(rt.mediaSource, sampleCanvas)
    if (!sample) return
    lastSampleRef.current = sample

    const mask = getMaskForSample(rt.committedCorners, sample)
    const det = updateDetector(
      detectorStateRef.current,
      sample,
      baselineRef.current,
      mask,
    )
    detectorStateRef.current = det.state
    lastMovingFractionRef.current = det.movingFraction
    lastPersistentCountRef.current = det.persistentChangedTiles

    if (inFlightRef.current !== null) {
      return
    }

    // Manual Check Now bypasses backoff and quiet waits.
    if (pendingIntentRef.current === 'manual') {
      pendingIntentRef.current = null
      void dispatchAnalysis()
      return
    }

    const activeBackoffUntil = backoffUntilMsRef.current ?? curState.backoffUntilMs
    const inBackoff = activeBackoffUntil !== null && nowMs < activeBackoffUntil
    const gapElapsed = nowMs - lastSettledAtRef.current >= MIN_DISPATCH_GAP_MS

    // No baseline yet (first start, reset, seek, calibration change) -> analyze promptly.
    if (baselineRef.current === null) {
      if (!inBackoff) {
        pendingIntentRef.current = null
        void dispatchAnalysis()
      } else {
        dispatch({ type: 'SET_PHASE', phase: 'WATCHING' })
      }
      return
    }

    const hasActiveChange =
      det.activeChangedTiles > 0 ||
      det.persistentChangedTiles > 0 ||
      pendingIntentRef.current === 'auto'

    if (hasActiveChange) {
      if (changeFirstSeenAtRef.current === null) {
        changeFirstSeenAtRef.current = nowMs
      }
      const hasPersistentChange =
        det.persistentChangedTiles > 0 || pendingIntentRef.current === 'auto'

      if (hasPersistentChange) {
        const changeAgeMs = nowMs - changeFirstSeenAtRef.current
        const calmEnough = det.movingFraction <= CALM_MOVING_FRACTION
        const waitedMax = changeAgeMs >= MAX_CHANGE_WAIT_MS

        if ((calmEnough || waitedMax) && gapElapsed && !inBackoff) {
          pendingIntentRef.current = null
          void dispatchAnalysis()
          return
        }
      }
      dispatch({ type: 'SET_PHASE', phase: 'WRITING' })
      return
    }

    changeFirstSeenAtRef.current = null

    // Quiet verification recheck: if an open finding was absent on the previous check
    // (either awaiting a second unchanged miss or previously obscured by motion), dispatch
    // one follow-up verification once its region is calm so fixed errors resolve automatically.
    const pendingRecheck = getIssuesPendingRecheck(curState.tracker)
    if (
      pendingRecheck.length > 0 &&
      !inBackoff &&
      nowMs - lastSettledAtRef.current >= VERIFY_RECHECK_DELAY_MS &&
      pendingRecheck.some((issue) =>
        isRegionCalm(issue.box_2d, sample.width, sample.height, det.stillTicks, mask),
      )
    ) {
      void dispatchAnalysis()
      return
    }

    dispatch({
      type: 'SET_PHASE',
      phase: det.movingFraction > CALM_MOVING_FRACTION ? 'WRITING' : 'WATCHING',
    })
  }, [dispatchAnalysis, getMaskForSample, getOrCreateCanvas])

  // Single Strict-Mode-safe loop running strictly while monitoring && mediaReady && !calibrationEditing.
  useEffect(() => {
    if (!monitoring || !mediaReady || calibrationEditing) {
      return
    }

    let disposed = false
    const timer = window.setInterval(() => {
      if (!disposed) {
        tick()
      }
    }, SAMPLE_INTERVAL_MS)

    tick()

    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [calibrationEditing, mediaReady, monitoring, tick])

  useEffect(() => {
    return () => {
      abortInFlightAndClearPending()
    }
  }, [abortInFlightAndClearPending])

  const requestCheckNow = useCallback(() => {
    if (!runtimeRef.current.monitoring || runtimeRef.current.calibrationEditing) return
    if (!runtimeRef.current.mediaSource || !runtimeRef.current.mediaReady) return

    lastSampleRef.current = null
    backoffUntilMsRef.current = null
    dispatch({ type: 'CLEAR_API_ERROR' })
    if (inFlightRef.current !== null) {
      pendingIntentRef.current = 'manual'
      return
    }
    pendingIntentRef.current = null
    void dispatchAnalysis()
  }, [dispatchAnalysis])

  const handleVideoSeek = useCallback(() => {
    resetSession()
  }, [resetSession])

  const dismiss = useCallback((issueId: string) => {
    dispatch({ type: 'DISMISS_ISSUE', issueId })
  }, [])

  const undoDismissal = useCallback(() => {
    dispatch({ type: 'UNDO_DISMISSAL' })
  }, [])

  const restoreDismissed = useCallback(() => {
    dispatch({ type: 'RESET_DISMISSED' })
  }, [])

  const markFixed = useCallback(
    (issueId: string) => {
      dispatch({ type: 'REQUEST_VERIFICATION', issueId })
      requestCheckNow()
    },
    [requestCheckNow],
  )

  const markSpoken = useCallback((issueId: string) => {
    dispatch({ type: 'MARK_SPOKEN', issueId })
  }, [])

  return {
    state,
    requestCheckNow,
    resetSession,
    handleVideoSeek,
    dismiss,
    undoDismissal,
    restoreDismissed,
    markFixed,
    markSpoken,
  }
}

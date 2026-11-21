import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchHealth } from './api/client'
import { CalibrationCorners, HealthResponse, SubjectHint } from './api/schemas'
import { FindingsSidebar } from './components/FindingsSidebar'
import { AlertMode, ControlBar, HeaderBar } from './components/HeaderBar'
import { StageViewport } from './components/StageViewport'
import { useBoardMonitor } from './hooks/useBoardMonitor'
import { useMediaSource } from './hooks/useMediaSource'
import { useSpeechAlerts } from './hooks/useSpeechAlerts'
import { DEFAULT_CALIBRATION_CORNERS } from './lib/geometry'
import { TrackedIssue } from './lib/issueTracker'

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)

  const [paused, setPaused] = useState(false)
  const [alertMode, setAlertMode] = useState<AlertMode>('voice_visual')
  const [subjectHint, setSubjectHint] = useState<SubjectHint>('auto')
  const [deepMode, setDeepMode] = useState(false)
  const [enhanceChalkboard, setEnhanceChalkboard] = useState(false)
  const [stabilizationMs, setStabilizationMs] = useState(1800)

  const [calibrationEditing, setCalibrationEditing] = useState(false)
  const [committedCorners, setCommittedCorners] = useState<CalibrationCorners | null>(null)
  const [draftCorners, setDraftCorners] = useState<CalibrationCorners>(
    DEFAULT_CALIBRATION_CORNERS,
  )

  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null)
  const [hoveredIssueId, setHoveredIssueId] = useState<string | null>(null)

  // Check backend health flags on mount (no Gemini probe).
  useEffect(() => {
    const controller = new AbortController()
    fetchHealth(controller.signal)
      .then((res) => {
        setHealth(res)
        setHealthError(null)
        if (!res.deep_mode_configured) {
          setDeepMode(false)
        }
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setHealthError(err instanceof Error ? err.message : 'Backend unavailable.')
      })
    return () => controller.abort()
  }, [])

  const markSpokenRef = useRef<(id: string) => void>(() => {})
  const speech = useSpeechAlerts({
    onUtteranceStarted: (id) => markSpokenRef.current(id),
  })

  const handleResetAllOnSourceChange = useCallback(() => {
    setCalibrationEditing(false)
    setCommittedCorners(null)
    setDraftCorners(DEFAULT_CALIBRATION_CORNERS)
    setSelectedIssueId(null)
    setHoveredIssueId(null)
    speech.resetHistory()
  }, [speech])

  const monitorCallbacksRef = useRef<{
    onGeometryChange: () => void
    onVideoSeek: () => void
  }>({
    onGeometryChange: () => {},
    onVideoSeek: () => {},
  })

  const media = useMediaSource({
    onSourceReset: handleResetAllOnSourceChange,
    onGeometryChange: () => {
      // Reset calibration when intrinsic stream/video dimensions change so coordinates stay valid.
      setCalibrationEditing(false)
      setCommittedCorners(null)
      setDraftCorners(DEFAULT_CALIBRATION_CORNERS)
      monitorCallbacksRef.current.onGeometryChange()
    },
    onVideoSeek: () => {
      monitorCallbacksRef.current.onVideoSeek()
    },
  })

  const activeMediaElement =
    media.state.kind === 'image' ? media.imageElRef.current : media.videoElRef.current

  const alertModeRef = useRef(alertMode)
  alertModeRef.current = alertMode

  const handleAcceptedFindings = useCallback(
    (newlyActivated: readonly TrackedIssue[]) => {
      if (alertModeRef.current === 'visual_only') return
      const unsuppressed = newlyActivated.filter((item) => !item.spoken)
      if (unsuppressed.length > 0) {
        speech.enqueueAutoAlerts(unsuppressed)
      }
    },
    [speech],
  )

  const monitor = useBoardMonitor({
    mediaSource: activeMediaElement,
    mediaReady: media.state.ready,
    sourceGeneration: media.state.sourceGeneration,
    paused,
    calibrationEditing,
    committedCorners,
    subjectHint,
    deepMode: deepMode && Boolean(health?.deep_mode_configured),
    enhanceChalkboard,
    stabilizationMs,
    onAcceptedFindings: handleAcceptedFindings,
    onInvalidateSpeech: speech.cancelAll,
  })

  markSpokenRef.current = monitor.markSpoken
  monitorCallbacksRef.current = {
    onGeometryChange: monitor.handleGeometryChange,
    onVideoSeek: monitor.handleVideoSeek,
  }

  // Cancel speech immediately if user switches to Visual Only mode.
  const handleChangeAlertMode = (mode: AlertMode) => {
    setAlertMode(mode)
    if (mode === 'visual_only') {
      speech.cancelAll()
    }
  }

  const activeIssues = useMemo(
    () =>
      monitor.state.tracker.issues.filter(
        (item) => item.status === 'active' || item.status === 'verifying',
      ),
    [monitor.state.tracker.issues],
  )

  const noLongerDetectedIssues = useMemo(
    () =>
      monitor.state.tracker.issues.filter(
        (item) => item.status === 'no_longer_detected',
      ),
    [monitor.state.tracker.issues],
  )

  const dismissedCount = monitor.state.tracker.dismissalHistoryIds.length

  const showVisualFindings = alertMode !== 'voice_only'
  const showOverlayBoxes =
    showVisualFindings &&
    !monitor.state.isResultStale &&
    monitor.state.phase !== 'WRITING' &&
    monitor.state.phase !== 'STABILIZING'

  const handleNewBoard = () => {
    speech.resetHistory()
    setSelectedIssueId(null)
    setHoveredIssueId(null)
    monitor.resetSession()
  }

  const handleToggleCalibration = () => {
    if (!media.state.ready) return
    if (calibrationEditing) {
      setCalibrationEditing(false)
    } else {
      setDraftCorners(committedCorners ?? DEFAULT_CALIBRATION_CORNERS)
      setCalibrationEditing(true)
    }
  }

  const handleApplyCalibration = () => {
    speech.resetHistory()
    setCommittedCorners(draftCorners)
    setCalibrationEditing(false)
  }

  const handleResetCrop = () => {
    speech.resetHistory()
    setCommittedCorners(null)
    setDraftCorners(DEFAULT_CALIBRATION_CORNERS)
    setCalibrationEditing(false)
  }

  const handleDismissIssue = (issueId: string) => {
    speech.cancelAll()
    if (selectedIssueId === issueId) {
      setSelectedIssueId(null)
    }
    monitor.dismiss(issueId)
  }

  return (
    <div className="flex min-h-screen flex-col bg-slate-950 text-slate-100">
      <HeaderBar
        phase={monitor.state.phase}
        mediaKind={media.state.kind}
        mediaLabel={media.state.label}
        mediaReady={media.state.ready}
        health={health}
        healthError={healthError}
        lastLatencyMs={monitor.state.lastLatencyMs}
        lastAnalyzedAt={monitor.state.lastAnalyzedAt}
        isResultStale={monitor.state.isResultStale}
        isSpeaking={speech.isSpeaking}
      />

      <ControlBar
        mediaKind={media.state.kind}
        mediaReady={media.state.ready}
        videoDevices={media.videoDevices}
        selectedDeviceId={media.selectedDeviceId}
        onSelectDeviceId={media.setSelectedDeviceId}
        onStartCamera={(id) => void media.startCamera(id)}
        onStartScreenShare={() => void media.startScreenShare()}
        onUploadFile={media.loadUploadedFile}
        onLoadSample={() => void media.loadSampleMistake()}
        paused={paused}
        onTogglePause={() => setPaused((prev) => !prev)}
        onCheckNow={monitor.requestCheckNow}
        onNewBoard={handleNewBoard}
        calibrationEditing={calibrationEditing}
        hasCalibration={committedCorners !== null}
        onToggleCalibration={handleToggleCalibration}
        alertMode={alertMode}
        onChangeAlertMode={handleChangeAlertMode}
        subjectHint={subjectHint}
        onChangeSubjectHint={setSubjectHint}
        deepMode={deepMode}
        deepModeAvailable={Boolean(health?.deep_mode_configured)}
        onChangeDeepMode={setDeepMode}
        enhanceChalkboard={enhanceChalkboard}
        onChangeEnhanceChalkboard={setEnhanceChalkboard}
        stabilizationMs={stabilizationMs}
        onChangeStabilizationMs={setStabilizationMs}
        isAnalyzing={monitor.state.phase === 'ANALYZING'}
      />

      <main className="flex flex-1 flex-col gap-4 p-4 lg:flex-row lg:overflow-hidden">
        <StageViewport
          mediaState={media.state}
          videoElRef={media.videoElRef}
          imageElRef={media.imageElRef}
          showOverlays={showOverlayBoxes}
          activeIssues={activeIssues}
          selectedIssueId={selectedIssueId}
          hoveredIssueId={hoveredIssueId}
          onSelectIssue={setSelectedIssueId}
          onHoverIssue={setHoveredIssueId}
          calibrationEditing={calibrationEditing}
          draftCorners={draftCorners}
          committedCorners={committedCorners}
          onChangeDraftCorners={setDraftCorners}
          onApplyCalibration={handleApplyCalibration}
          onResetCrop={handleResetCrop}
          onCancelCalibration={() => setCalibrationEditing(false)}
        />

        <FindingsSidebar
          alertMode={alertMode}
          phase={monitor.state.phase}
          hasAnalyzed={monitor.state.hasAnalyzedCurrentSession}
          isResultStale={monitor.state.isResultStale}
          boardSummary={monitor.state.boardSummary}
          apiError={monitor.state.apiError}
          speechError={speech.speechError}
          speechSupported={speech.isSupported}
          analysisConfigured={health?.analysis_configured ?? true}
          activeIssues={activeIssues}
          noLongerDetectedIssues={noLongerDetectedIssues}
          dismissedCount={dismissedCount}
          selectedIssueId={selectedIssueId}
          hoveredIssueId={hoveredIssueId}
          onSelectIssue={setSelectedIssueId}
          onHoverIssue={setHoveredIssueId}
          onSpeakIssue={speech.speakNow}
          onMarkFixed={monitor.markFixed}
          onDismissIssue={handleDismissIssue}
          onClearNoLongerDetected={monitor.dismissNoLongerDetected}
          onUndoDismissal={monitor.undoDismissal}
          onResetDismissed={monitor.clearAllDismissals}
          onRetryAnalysis={monitor.requestCheckNow}
        />
      </main>
    </div>
  )
}

export default App

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { detectBoardCorners, fetchHealth } from './api/client'
import { CalibrationCorners, HealthResponse } from './api/schemas'
import { CalibrationDetectStatus } from './components/CalibrationOverlay'
import { FindingsPanel } from './components/FindingsPanel'
import { NotesPanel } from './components/NotesPanel'
import { Stage } from './components/Stage'
import { ToastItem, Toasts } from './components/Toasts'
import { TopBar } from './components/TopBar'
import { VerificationResultSummary, useBoardMonitor } from './hooks/useBoardMonitor'
import { useMediaSource } from './hooks/useMediaSource'
import { useNotesBuilder } from './hooks/useNotesBuilder'
import { useSpeechAlerts } from './hooks/useSpeechAlerts'
import { AlertMode } from './lib/categoryColors'
import { captureJpegBlob } from './lib/frameCapture'
import { DEFAULT_CALIBRATION_CORNERS, validateCalibrationQuad } from './lib/geometry'
import { TrackedIssue } from './lib/issueTracker'
import { exportMarkdown, exportPrintHtml } from './lib/notes'

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)

  // Monitoring is always stopped by default when the application opens.
  const [monitoring, setMonitoring] = useState(false)
  const [alertMode, setAlertMode] = useState<AlertMode>('voice_visual')

  const [calibrationEditing, setCalibrationEditing] = useState(false)
  const [calibrationDetectStatus, setCalibrationDetectStatus] =
    useState<CalibrationDetectStatus>('idle')
  const [committedCorners, setCommittedCorners] = useState<CalibrationCorners | null>(null)
  const [draftCorners, setDraftCorners] = useState<CalibrationCorners>(
    DEFAULT_CALIBRATION_CORNERS,
  )
  const detectAbortRef = useRef<AbortController | null>(null)
  const userEditedDraftRef = useRef(false)
  const calibrationCanvasRef = useRef<HTMLCanvasElement | null>(null)

  const [panelOpen, setPanelOpen] = useState(false)
  // Notes recording is its own opt-in toggle, independent of mistake monitoring.
  const [notesRecording, setNotesRecording] = useState(false)
  const [notesOpen, setNotesOpen] = useState(false)
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null)
  const [hoveredIssueId, setHoveredIssueId] = useState<string | null>(null)
  const [pulseBadge, setPulseBadge] = useState(false)
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const toastTimersRef = useRef<Map<string, number>>(new Map())

  const abortBoardDetection = useCallback(() => {
    if (detectAbortRef.current) {
      detectAbortRef.current.abort()
      detectAbortRef.current = null
    }
  }, [])

  const pushToast = useCallback(
    (toast: Omit<ToastItem, 'id'>, autoDismissMs = 4000) => {
      const id = `toast-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`
      setToasts((prev) => [{ ...toast, id }, ...prev].slice(0, 3))
      if (autoDismissMs > 0) {
        const timer = window.setTimeout(() => {
          toastTimersRef.current.delete(id)
          setToasts((prev) => prev.filter((item) => item.id !== id))
        }, autoDismissMs)
        toastTimersRef.current.set(id, timer)
      }
    },
    [],
  )

  const dismissToast = useCallback((id: string) => {
    const timer = toastTimersRef.current.get(id)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      toastTimersRef.current.delete(id)
    }
    setToasts((prev) => prev.filter((item) => item.id !== id))
  }, [])

  useEffect(() => {
    const timers = toastTimersRef.current
    return () => {
      abortBoardDetection()
      for (const timer of timers.values()) {
        window.clearTimeout(timer)
      }
      timers.clear()
    }
  }, [abortBoardDetection])

  useEffect(() => {
    const controller = new AbortController()
    fetchHealth(controller.signal)
      .then((res) => {
        setHealth(res)
        setHealthError(null)
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setHealthError(err instanceof Error ? err.message : 'Backend unavailable.')
      })
    return () => controller.abort()
  }, [])

  const markSpokenRef = useRef<(id: string) => void>(() => {})
  const fallbackNoticeShownRef = useRef(false)
  const speech = useSpeechAlerts({
    elevenLabsConfigured: health?.speech_configured ?? false,
    onUtteranceStarted: (id) => markSpokenRef.current(id),
    onProviderFallback: (reason) => {
      if (fallbackNoticeShownRef.current) return
      fallbackNoticeShownRef.current = true
      pushToast({ message: `${reason} Using browser voice.`, tone: 'info' }, 6000)
    },
  })
  const { syncActiveIssueIds } = speech

  const speechUnavailableNotifiedRef = useRef(false)
  useEffect(() => {
    if (
      monitoring &&
      alertMode !== 'visual_only' &&
      !speech.isSupported &&
      !speechUnavailableNotifiedRef.current
    ) {
      speechUnavailableNotifiedRef.current = true
      pushToast({
        message: 'Speech synthesis is unavailable in this browser; showing visual alerts.',
        tone: 'info',
      })
    }
  }, [alertMode, monitoring, pushToast, speech.isSupported])

  const monitorCallbacksRef = useRef<{
    onGeometryChange: () => void
    onVideoSeek: () => void
  }>({
    onGeometryChange: () => {},
    onVideoSeek: () => {},
  })

  const handleResetAllOnSourceChange = useCallback(() => {
    abortBoardDetection()
    setMonitoring(false)
    setCalibrationEditing(false)
    setCalibrationDetectStatus('idle')
    setCommittedCorners(null)
    setDraftCorners(DEFAULT_CALIBRATION_CORNERS)
    setSelectedIssueId(null)
    setHoveredIssueId(null)
    speech.resetHistory()
  }, [abortBoardDetection, speech])

  const media = useMediaSource({
    onSourceReset: handleResetAllOnSourceChange,
    onGeometryChange: () => {
      abortBoardDetection()
      setCalibrationEditing(false)
      setCalibrationDetectStatus('idle')
      setCommittedCorners(null)
      setDraftCorners(DEFAULT_CALIBRATION_CORNERS)
      monitorCallbacksRef.current.onGeometryChange()
    },
    onVideoSeek: () => {
      monitorCallbacksRef.current.onVideoSeek()
    },
  })

  useEffect(() => {
    if (media.state.error) {
      pushToast({ message: media.state.error, tone: 'error' }, 5000)
    }
  }, [media.state.error, pushToast])

  const activeMediaElement =
    media.state.kind === 'image' ? media.imageElRef.current : media.videoElRef.current

  const alertModeRef = useRef(alertMode)
  alertModeRef.current = alertMode
  const monitoringRef = useRef(monitoring)
  monitoringRef.current = monitoring

  const handleNewFindings = useCallback(
    (newlyOpened: readonly TrackedIssue[]) => {
      if (newlyOpened.length > 0) {
        setPulseBadge(true)
        window.setTimeout(() => setPulseBadge(false), 1200)
      }
      if (!monitoringRef.current || alertModeRef.current === 'visual_only') return
      const unsuppressed = newlyOpened.filter((item) => !item.spoken)
      if (unsuppressed.length > 0) {
        speech.enqueueAutoAlerts(unsuppressed)
      }
    },
    [speech],
  )

  const handleVerificationResult = useCallback(
    (result: VerificationResultSummary) => {
      for (const resolved of result.resolved) {
        pushToast({
          message: `Fixed: ${resolved.detected_text}`,
          tone: 'success',
        })
      }
      if (result.stillPresent.length > 0) {
        pushToast({
          message: `Still visible: ${result.stillPresent[0]!.detected_text}`,
          tone: 'info',
        })
      }
    },
    [pushToast],
  )

  const monitor = useBoardMonitor({
    mediaSource: activeMediaElement,
    mediaReady: media.state.ready,
    sourceGeneration: media.state.sourceGeneration,
    monitoring,
    calibrationEditing,
    committedCorners,
    onNewFindings: handleNewFindings,
    onInvalidateSpeech: speech.cancelAll,
    onVerificationResult: handleVerificationResult,
  })

  const notesBuilder = useNotesBuilder({
    mediaSource: activeMediaElement,
    mediaReady: media.state.ready,
    sourceGeneration: media.state.sourceGeneration,
    enabled: notesRecording,
    calibrationEditing,
    committedCorners,
  })

  const handleExportMarkdown = () => {
    const blob = new Blob([exportMarkdown(notesBuilder.notes)], {
      type: 'text/markdown;charset=utf-8',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'lecture-notes.md'
    a.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  const handleExportPrint = () => {
    const blob = new Blob([exportPrintHtml(notesBuilder.notes)], { type: 'text/html' })
    const url = URL.createObjectURL(blob)
    const win = window.open(url, '_blank')
    if (win) {
      win.addEventListener('load', () => win.print())
    } else {
      pushToast({ message: 'Allow pop-ups to open the printable notes.', tone: 'info' })
    }
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }

  markSpokenRef.current = monitor.markSpoken
  monitorCallbacksRef.current = {
    onGeometryChange: monitor.resetSession,
    onVideoSeek: monitor.handleVideoSeek,
  }

  // Surface latest API error cleanly as a single toast with Retry.
  const requestCheckRef = useRef(monitor.requestCheckNow)
  requestCheckRef.current = monitor.requestCheckNow

  useEffect(() => {
    const err = monitor.state.apiError
    if (!err) return
    const msg =
      err.retryAfterSeconds !== null
        ? `${err.message} (retrying in ${err.retryAfterSeconds}s)`
        : err.message
    pushToast(
      {
        message: msg,
        tone: 'error',
        actionLabel: monitoringRef.current ? 'Retry' : undefined,
        onAction: monitoringRef.current ? () => requestCheckRef.current() : undefined,
      },
      5500,
    )
  }, [monitor.state.apiError, pushToast])

  const runAutomaticBoardDetection = useCallback(async () => {
    const mediaEl =
      media.state.kind === 'image' ? media.imageElRef.current : media.videoElRef.current
    if (!mediaEl || !media.state.ready) {
      setCalibrationDetectStatus('fallback')
      return
    }

    abortBoardDetection()
    const controller = new AbortController()
    detectAbortRef.current = controller
    userEditedDraftRef.current = false
    setCalibrationDetectStatus('detecting')

    try {
      if (!calibrationCanvasRef.current) {
        calibrationCanvasRef.current = document.createElement('canvas')
      }
      const captured = await captureJpegBlob(mediaEl, calibrationCanvasRef.current, 1280)
      if (controller.signal.aborted) return

      const result = await detectBoardCorners(captured.blob, controller.signal)
      if (controller.signal.aborted) return

      if (result.detected && result.corners && validateCalibrationQuad(result.corners).valid) {
        if (!userEditedDraftRef.current) {
          setDraftCorners(result.corners)
        }
        setCalibrationDetectStatus('detected')
      } else {
        setCalibrationDetectStatus('fallback')
      }
    } catch (err) {
      if (controller.signal.aborted) return
      if (err instanceof DOMException && err.name === 'AbortError') return
      setCalibrationDetectStatus('error')
    } finally {
      if (detectAbortRef.current === controller) {
        detectAbortRef.current = null
      }
    }
  }, [abortBoardDetection, media.imageElRef, media.state.kind, media.state.ready, media.videoElRef])

  const handleToggleMonitoring = () => {
    if (!media.state.ready) return
    if (!monitoring) {
      speech.unlockAudio()
    }
    setMonitoring((prev) => {
      const next = !prev
      if (!next) {
        speech.cancelAll()
      }
      return next
    })
  }

  const handleChangeAlertMode = (mode: AlertMode) => {
    setAlertMode(mode)
    if (mode === 'visual_only') {
      speech.cancelAll()
    }
    if (mode === 'voice_only') {
      setPanelOpen(false)
    }
  }

  const openIssues = useMemo(
    () => monitor.state.tracker.issues.filter((item) => item.status === 'open'),
    [monitor.state.tracker.issues],
  )

  useEffect(() => {
    syncActiveIssueIds(new Set(openIssues.map((item) => item.id)))
  }, [openIssues, syncActiveIssueIds])

  const dismissedCount = monitor.state.tracker.dismissalHistoryIds.length
  const showVisualFindings = alertMode !== 'voice_only'

  const handleSelectOverlayIssue = (issueId: string) => {
    setSelectedIssueId(issueId)
    if (showVisualFindings) {
      setPanelOpen(true)
    }
  }

  const handleToggleCalibration = () => {
    if (!media.state.ready) return
    if (calibrationEditing) {
      abortBoardDetection()
      setCalibrationEditing(false)
      setCalibrationDetectStatus('idle')
    } else {
      userEditedDraftRef.current = false
      setDraftCorners(committedCorners ?? DEFAULT_CALIBRATION_CORNERS)
      setCalibrationEditing(true)
      if (!committedCorners) {
        void runAutomaticBoardDetection()
      } else {
        setCalibrationDetectStatus('idle')
      }
    }
  }

  const handleChangeDraftCorners = (next: CalibrationCorners) => {
    userEditedDraftRef.current = true
    setDraftCorners(next)
  }

  const handleApplyCalibration = () => {
    abortBoardDetection()
    speech.resetHistory()
    setCommittedCorners(draftCorners)
    setCalibrationEditing(false)
    setCalibrationDetectStatus('idle')
  }

  const handleResetCrop = () => {
    abortBoardDetection()
    speech.resetHistory()
    setCommittedCorners(null)
    setDraftCorners(DEFAULT_CALIBRATION_CORNERS)
    setCalibrationEditing(false)
    setCalibrationDetectStatus('idle')
  }

  const handleCancelCalibration = () => {
    abortBoardDetection()
    setCalibrationEditing(false)
    setCalibrationDetectStatus('idle')
  }

  const handleDismissIssue = (issueId: string) => {
    speech.cancelAll()
    if (selectedIssueId === issueId) {
      setSelectedIssueId(null)
    }
    monitor.dismiss(issueId)
    pushToast({
      message: 'Finding dismissed',
      tone: 'info',
      actionLabel: 'Undo',
      onAction: () => monitor.undoDismissal(),
    })
  }

  const backendNeedsSetup =
    healthError !== null || (health !== null && !health.analysis_configured)

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-surface text-zinc-100">
      <TopBar
        mediaKind={media.state.kind}
        mediaReady={media.state.ready}
        videoDevices={media.videoDevices}
        selectedDeviceId={media.selectedDeviceId}
        onStartCamera={(id) => void media.startCamera(id)}
        onStartScreenShare={() => void media.startScreenShare()}
        onUploadFile={media.loadUploadedFile}
        monitoring={monitoring}
        onToggleMonitoring={handleToggleMonitoring}
        alertMode={alertMode}
        onChangeAlertMode={handleChangeAlertMode}
      />

      {backendNeedsSetup && (
        <div
          role="alert"
          className="flex items-center justify-center border-b border-amber-500/20 bg-amber-950/30 px-4 py-1.5 text-xs text-amber-200"
        >
          {healthError
            ? 'Backend unreachable — start the FastAPI server on port 8000.'
            : 'Set GEMINI_API_KEY in .env and restart the backend.'}
        </div>
      )}

      <Toasts toasts={toasts} onDismiss={dismissToast} />

      <div className="relative flex flex-1 min-h-0 flex-col md:flex-row overflow-hidden">
        <Stage
          mediaState={media.state}
          videoElRef={media.videoElRef}
          imageElRef={media.imageElRef}
          onStartCamera={() => void media.startCamera()}
          onStartScreenShare={() => void media.startScreenShare()}
          onUploadFile={media.loadUploadedFile}
          monitoring={monitoring}
          phase={monitor.state.phase}
          showOverlays={showVisualFindings}
          openIssues={openIssues}
          locationsUnverified={monitor.state.locationsUnverified}
          selectedIssueId={selectedIssueId}
          hoveredIssueId={hoveredIssueId}
          onSelectIssue={handleSelectOverlayIssue}
          onHoverIssue={setHoveredIssueId}
          calibrationEditing={calibrationEditing}
          calibrationDetectStatus={calibrationDetectStatus}
          draftCorners={draftCorners}
          committedCorners={committedCorners}
          onChangeDraftCorners={handleChangeDraftCorners}
          onToggleCalibration={handleToggleCalibration}
          onAutoDetectCalibration={() => void runAutomaticBoardDetection()}
          onApplyCalibration={handleApplyCalibration}
          onResetCrop={handleResetCrop}
          onCancelCalibration={handleCancelCalibration}
          onCheckNow={monitor.requestCheckNow}
          onUserVideoSeekOrRestart={monitor.handleVideoSeek}
        />

        <NotesPanel
          open={notesOpen}
          recording={notesRecording}
          mediaReady={media.state.ready}
          phase={notesBuilder.phase}
          error={notesBuilder.error}
          notes={notesBuilder.notes}
          onToggleOpen={() => setNotesOpen((prev) => !prev)}
          onToggleRecording={() => {
            setNotesRecording((prev) => !prev)
            setNotesOpen(true)
          }}
          onSnapshotNow={() => void notesBuilder.snapshotNow()}
          onExportMarkdown={handleExportMarkdown}
          onExportPrint={handleExportPrint}
          onClear={() => {
            if (window.confirm('Clear all lecture notes? This cannot be undone.')) {
              notesBuilder.clear()
            }
          }}
        />

        {showVisualFindings && (
          <FindingsPanel
            open={panelOpen}
            monitoring={monitoring}
            onToggle={() => setPanelOpen((prev) => !prev)}
            onClose={() => setPanelOpen(false)}
            hasAnalyzed={monitor.state.hasAnalyzed}
            openIssues={openIssues}
            dismissedCount={dismissedCount}
            selectedIssueId={selectedIssueId}
            hoveredIssueId={hoveredIssueId}
            speechSupported={speech.isSupported}
            pulseBadge={pulseBadge}
            onSelectIssue={setSelectedIssueId}
            onHoverIssue={setHoveredIssueId}
            onSpeakIssue={speech.speakNow}
            onMarkFixed={monitor.markFixed}
            onDismissIssue={handleDismissIssue}
            onRestoreDismissed={monitor.restoreDismissed}
          />
        )}
      </div>
    </div>
  )
}

export default App

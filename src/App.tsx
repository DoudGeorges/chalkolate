import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { detectBoardCorners, fetchHealth } from './api/client'
import {
  AnswerFormat,
  AnswerFormatSchema,
  CalibrationCorners,
  HealthResponse,
} from './api/schemas'
import { CalibrationDetectStatus } from './components/CalibrationOverlay'
import { FindingsPanel, SidePanelTab } from './components/FindingsPanel'
import { NotesPanel } from './components/NotesPanel'
import { SettingsContent } from './components/SettingsContent'
import { Stage } from './components/Stage'
import { WelcomeGuide, WelcomeSource } from './components/WelcomeGuide'
import { ToastItem, Toasts } from './components/Toasts'
import { TopBar } from './components/TopBar'
import { VerificationResultSummary, useBoardMonitor } from './hooks/useBoardMonitor'
import { useMediaSource } from './hooks/useMediaSource'
import { useNotesBuilder } from './hooks/useNotesBuilder'
import { useSpeechAlerts } from './hooks/useSpeechAlerts'
import { AlertMode } from './lib/categoryColors'
import {
  VoicePreferences,
  loadVoicePreferences,
  sanitizeVoicePreferences,
  saveVoicePreferences,
} from './lib/voicePreferences'
import { captureJpegBlob } from './lib/frameCapture'
import { DEFAULT_CALIBRATION_CORNERS, validateCalibrationQuad } from './lib/geometry'
import { TrackedIssue } from './lib/issueTracker'
import { exportMarkdown, exportPrintHtml } from './lib/notes'
import { exportLatex } from './lib/notesLatex'

const ANSWER_FORMAT_KEY = 'chalkolate.answerFormat.v1'

const LAUNCH_TIMEOUT_MS = 60_000

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)

  // Monitoring is always stopped by default when the application opens.
  const [monitoring, setMonitoring] = useState(false)
  const [alertMode, setAlertMode] = useState<AlertMode>('voice_visual')
  const [answerFormat, setAnswerFormat] = useState<AnswerFormat>(() => {
    try {
      const parsed = AnswerFormatSchema.safeParse(window.localStorage.getItem(ANSWER_FORMAT_KEY))
      return parsed.success ? parsed.data : 'exact'
    } catch {
      return 'exact'
    }
  })
  const handleChangeAnswerFormat = (format: AnswerFormat) => {
    setAnswerFormat(format)
    try {
      window.localStorage.setItem(ANSWER_FORMAT_KEY, format)
    } catch {
      /* preference simply is not remembered */
    }
  }
  const [voicePreferences, setVoicePreferences] =
    useState<VoicePreferences>(loadVoicePreferences)

  const handleChangeVoicePreferences = useCallback((patch: Partial<VoicePreferences>) => {
    setVoicePreferences((prev) => {
      const next = sanitizeVoicePreferences({ ...prev, ...patch })
      saveVoicePreferences(next)
      return next
    })
  }, [])

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

  // One right-side panel hosts both Findings and Settings as tabs.
  const [panelOpen, setPanelOpen] = useState(false)
  // Notes build automatically once a source is live.
  const [notesOpen, setNotesOpen] = useState(false)
  const [sidebarTab, setSidebarTab] = useState<SidePanelTab>('findings')
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

  const speechConfigured = health?.speech_configured ?? false

  const markSpokenRef = useRef<(id: string) => void>(() => {})
  const speech = useSpeechAlerts({
    elevenLabsConfigured: speechConfigured,
    preferences: voicePreferences,
    onUtteranceStarted: (id) => markSpokenRef.current(id),
    // The hook already deduplicates: once per session.
    onProviderFallback: (reason) => {
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

  // The welcome guide's Start button opens the chosen source and then begins checking.
  // Nothing is opened before that explicit click.
  const [launchPending, setLaunchPending] = useState(false)
  // Source generation and error at launch, so stale state from earlier attempts is ignored.
  const launchBaselineRef = useRef({ generation: 0, error: null as string | null })
  const handleWelcomeLaunch = useCallback(
    (source: WelcomeSource) => {
      speech.unlockAudio()
      launchBaselineRef.current = {
        generation: media.state.sourceGeneration,
        error: media.state.error,
      }
      setLaunchPending(true)
      if (source === 'camera') void media.startCamera()
      else void media.startScreenShare()
    },
    [media, speech],
  )

  useEffect(() => {
    if (!launchPending) return
    const baseline = launchBaselineRef.current
    if (media.state.sourceGeneration !== baseline.generation) {
      if (media.state.kind === 'none') {
        // Permission denied or capture failed; the error toast explains why.
        setLaunchPending(false)
        return
      }
      if (media.state.ready) {
        setLaunchPending(false)
        setMonitoring(true)
        return
      }
    } else if (media.state.error && media.state.error !== baseline.error) {
      setLaunchPending(false)
      return
    }
    // Give up if the permission prompt is dismissed without an error being reported.
    const timer = window.setTimeout(() => setLaunchPending(false), LAUNCH_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [
    launchPending,
    media.state.error,
    media.state.kind,
    media.state.ready,
    media.state.sourceGeneration,
  ])

  // Home screen: the welcome guide is the only path until a source is live.
  const onboarding = media.state.kind === 'none'

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
    answerFormat,
    onNewFindings: handleNewFindings,
    onInvalidateSpeech: speech.cancelAll,
    onVerificationResult: handleVerificationResult,
  })

  const notesActive = health?.analysis_configured ?? false
  const notesBuilder = useNotesBuilder({
    mediaSource: activeMediaElement,
    mediaReady: media.state.ready,
    sourceGeneration: media.state.sourceGeneration,
    enabled: notesActive,
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

  const handleExportLatex = () => {
    const blob = new Blob([exportLatex(notesBuilder.notes)], { type: 'application/x-tex' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'lecture-notes.tex'
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

  // Back to the landing page: release the camera/screen/file. clearSource triggers the normal
  // source reset, which stops monitoring and clears findings, calibration, and speech history.
  const handleGoHome = () => {
    speech.cancelAll()
    setLaunchPending(false)
    setPanelOpen(false)
    media.clearSource()
  }

  const handleToggleMonitoring = () => {
    if (!media.state.ready) return
    setLaunchPending(false)
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
    // Voice only keeps a clean board: close Findings, but leave Settings open if the
    // user is changing the mode from there.
    if (mode === 'voice_only' && !(panelOpen && sidebarTab === 'settings')) {
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
  const activeSidebarTab: SidePanelTab = showVisualFindings ? sidebarTab : 'settings'
  const handleSelectOverlayIssue = (issueId: string) => {
    setSelectedIssueId(issueId)
    if (showVisualFindings) {
      setSidebarTab('findings')
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
    <div className="flex h-screen flex-col overflow-hidden bg-surface text-zinc-900">
      <TopBar
        mediaReady={media.state.ready}
        monitoring={monitoring}
        onToggleMonitoring={handleToggleMonitoring}
        onboarding={onboarding}
        onGoHome={handleGoHome}
        notesOpen={notesOpen}
        notesCount={notesBuilder.notes.sections.length}
        notesActive={notesActive && media.state.ready && !calibrationEditing}
        onToggleNotes={() => setNotesOpen((prev) => !prev)}
        canCrop={media.state.ready && media.state.kind !== 'screen' && !calibrationEditing}
        cropped={committedCorners !== null}
        onToggleCrop={handleToggleCalibration}
      />

      {backendNeedsSetup && (
        <div
          role="alert"
          className="flex items-center justify-center border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-800"
        >
          {healthError
            ? 'Backend unreachable — start the FastAPI server on port 8000.'
            : 'Set GEMINI_API_KEY in .env and restart the backend.'}
        </div>
      )}

      <Toasts toasts={toasts} onDismiss={dismissToast} />

      <div className="relative flex flex-1 min-h-0 flex-col md:flex-row overflow-hidden">
        <NotesPanel
          open={notesOpen}
          active={notesActive && media.state.ready && !calibrationEditing}
          configured={health?.analysis_configured ?? false}
          phase={notesBuilder.phase}
          error={notesBuilder.error}
          notes={notesBuilder.notes}
          onToggleOpen={() => setNotesOpen((prev) => !prev)}
          onExportMarkdown={handleExportMarkdown}
          onExportLatex={handleExportLatex}
          onExportPrint={handleExportPrint}
          onClear={() => {
            if (window.confirm('Clear all lecture notes? This cannot be undone.')) {
              notesBuilder.clear()
            }
          }}
        />
        <Stage
          mediaState={media.state}
          videoElRef={media.videoElRef}
          imageElRef={media.imageElRef}
          onStartCamera={() => void media.startCamera()}
          onStartScreenShare={() => void media.startScreenShare()}
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
          onAutoDetectCalibration={() => void runAutomaticBoardDetection()}
          onApplyCalibration={handleApplyCalibration}
          onResetCrop={handleResetCrop}
          onCancelCalibration={handleCancelCalibration}
          onUserVideoSeekOrRestart={monitor.handleVideoSeek}
          startHint
          welcome={
            <WelcomeGuide
              onLaunch={handleWelcomeLaunch}
              launching={launchPending && media.state.kind === 'none'}
              talkativeness={voicePreferences.talkativeness}
              onChangeTalkativeness={(talkativeness) =>
                handleChangeVoicePreferences({ talkativeness })
              }
              alertMode={alertMode}
              onChangeAlertMode={handleChangeAlertMode}
            />
          }
        />

        {!onboarding && (
          <FindingsPanel
            open={panelOpen}
            tab={activeSidebarTab}
            onChangeTab={setSidebarTab}
            findingsEnabled={showVisualFindings}
            settingsContent={
              <SettingsContent
                alertMode={alertMode}
                onChangeAlertMode={handleChangeAlertMode}
                answerFormat={answerFormat}
                onChangeAnswerFormat={handleChangeAnswerFormat}
                talkativeness={voicePreferences.talkativeness}
                onChangeTalkativeness={(talkativeness) =>
                  handleChangeVoicePreferences({ talkativeness })
                }
              />
            }
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

import { CircleAlert } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { detectBoardCorners, fetchHealth, fetchVoices } from './api/client'
import {
  AnswerFormat,
  AnswerFormatSchema,
  CalibrationCorners,
  HealthResponse,
  SpeechVoiceOption,
} from './api/schemas'
import { CalibrationDetectStatus } from './components/CalibrationOverlay'
import { NotesPanel } from './components/NotesPanel'
import { SettingsPanel } from './components/SettingsPanel'
import { Stage } from './components/Stage'
import { LiveSource, WelcomeGuide, WelcomeSource } from './components/WelcomeGuide'
import { ToastItem, Toasts } from './components/Toasts'
import { TopBar } from './components/TopBar'
import { VerificationResultSummary, useBoardMonitor } from './hooks/useBoardMonitor'
import { useMediaSource } from './hooks/useMediaSource'
import { useNotesBuilder } from './hooks/useNotesBuilder'
import { useSpeechAlerts } from './hooks/useSpeechAlerts'
import { isAbortError } from './lib/abort'
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
const PREVIEW_TIMEOUT_MS = 15_000

/** Saves generated text as a local file download; nothing leaves the browser. */
function downloadText(text: string, type: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [healthFailed, setHealthFailed] = useState(false)
  const [checkingHealth, setCheckingHealth] = useState(true)
  const [healthCheck, setHealthCheck] = useState(0)

  // Monitoring is always stopped by default when the application opens.
  const [monitoring, setMonitoring] = useState(false)
  const [starting, setStarting] = useState(false)
  const startSequenceRef = useRef(0)
  const [selectedSource, setSelectedSource] = useState<WelcomeSource | null>(null)
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
  const [voicePreferences, setVoicePreferences] = useState<VoicePreferences>(loadVoicePreferences)

  const handleChangeVoicePreferences = useCallback((patch: Partial<VoicePreferences>) => {
    setVoicePreferences((prev) => sanitizeVoicePreferences({ ...prev, ...patch }))
  }, [])
  useEffect(() => saveVoicePreferences(voicePreferences), [voicePreferences])

  const [calibrationEditing, setCalibrationEditing] = useState(false)
  const [calibrationDetectStatus, setCalibrationDetectStatus] =
    useState<CalibrationDetectStatus>('idle')
  const [committedCorners, setCommittedCorners] = useState<CalibrationCorners | null>(null)
  const [draftCorners, setDraftCorners] = useState<CalibrationCorners>(DEFAULT_CALIBRATION_CORNERS)
  const detectAbortRef = useRef<AbortController | null>(null)
  const calibrationCanvasRef = useRef<HTMLCanvasElement | null>(null)

  const [activePanel, setActivePanel] = useState<'notes' | 'settings' | null>(null)
  const settingsOpen = activePanel === 'settings'
  const notesOpen = activePanel === 'notes'
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null)
  const [hoveredIssueId, setHoveredIssueId] = useState<string | null>(null)
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const toastTimersRef = useRef<Map<string, number>>(new Map())

  const abortBoardDetection = useCallback(() => {
    if (detectAbortRef.current) {
      detectAbortRef.current.abort()
      detectAbortRef.current = null
    }
  }, [])

  const pushToast = useCallback((toast: Omit<ToastItem, 'id'>, autoDismissMs = 4000) => {
    const id = `toast-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`
    setToasts((prev) => [{ ...toast, id }, ...prev].slice(0, 3))
    if (autoDismissMs > 0) {
      const timer = window.setTimeout(() => {
        toastTimersRef.current.delete(id)
        setToasts((prev) => prev.filter((item) => item.id !== id))
      }, autoDismissMs)
      toastTimersRef.current.set(id, timer)
    }
  }, [])

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
        if (controller.signal.aborted) return
        setHealth(res)
        setHealthFailed(false)
      })
      .catch((err) => {
        if (controller.signal.aborted || isAbortError(err)) return
        setHealthFailed(true)
      })
      .finally(() => {
        if (!controller.signal.aborted) setCheckingHealth(false)
      })
    return () => controller.abort()
  }, [healthCheck])

  const retryHealth = () => {
    setCheckingHealth(true)
    setHealthCheck((value) => value + 1)
  }

  const speechConfigured = health?.speech_configured ?? false

  const [elevenLabsVoices, setElevenLabsVoices] = useState<SpeechVoiceOption[]>([])
  const [voicesError, setVoicesError] = useState<string | null>(null)
  const [voicesLoading, setVoicesLoading] = useState(false)
  const [voicesReloadKey, setVoicesReloadKey] = useState(0)
  const retryVoices = useCallback(() => setVoicesReloadKey((k) => k + 1), [])

  useEffect(() => {
    if (!speechConfigured) {
      setElevenLabsVoices([])
      setVoicesError(null)
      setVoicesLoading(false)
      return
    }
    const controller = new AbortController()
    setVoicesLoading(true)
    setVoicesError(null)
    fetchVoices(controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return
        setElevenLabsVoices(res.voices)
        setVoicesError(null)
      })
      .catch((err) => {
        if (controller.signal.aborted || isAbortError(err)) return
        setVoicesError(err instanceof Error ? err.message : 'The voice list could not be loaded.')
      })
      .finally(() => {
        if (!controller.signal.aborted) setVoicesLoading(false)
      })
    return () => controller.abort()
  }, [speechConfigured, voicesReloadKey])

  // A saved voice the backend no longer offers falls back to the configured default.
  const effectiveVoicePreferences = useMemo<VoicePreferences>(() => {
    return elevenLabsVoices.some((v) => v.id === voicePreferences.elevenLabsVoice)
      ? voicePreferences
      : { ...voicePreferences, elevenLabsVoice: 'default' }
  }, [elevenLabsVoices, voicePreferences])

  const markSpokenRef = useRef<(id: string) => void>(() => {})
  const speech = useSpeechAlerts({
    elevenLabsConfigured: speechConfigured,
    preferences: effectiveVoicePreferences,
    onUtteranceStarted: (id) => markSpokenRef.current(id),
    // The hook already deduplicates: once per session for account-wide failures and
    // once per voice for voices the account cannot use.
    onProviderFallback: (reason) => {
      pushToast({ message: reason, tone: 'info' }, 6000)
    },
  })
  const { syncActiveIssueIds } = speech

  const speechUnavailableNotifiedRef = useRef(false)
  useEffect(() => {
    if (speech.isSupported && speech.speechError && alertMode !== 'visual_only') {
      pushToast({ message: speech.speechError, tone: 'info' }, 5000)
    }
  }, [alertMode, pushToast, speech.isSupported, speech.speechError])
  useEffect(() => {
    if (
      monitoring &&
      alertMode !== 'visual_only' &&
      !speech.isSupported &&
      !speechUnavailableNotifiedRef.current
    ) {
      speechUnavailableNotifiedRef.current = true
      pushToast({
        message: 'Spoken alerts are unavailable. Corrections appear on the board.',
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
    startSequenceRef.current += 1
    setStarting(false)
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
      speech.resetHistory()
      monitorCallbacksRef.current.onVideoSeek()
    },
  })
  const { clearSource } = media

  useEffect(() => {
    if (media.state.error) {
      pushToast({ message: media.state.error, tone: 'error' }, 5000)
    }
  }, [media.state.error, media.state.sourceGeneration, pushToast])

  const [launchPending, setLaunchPending] = useState(false)
  const launchSequenceRef = useRef(0)
  const handleWelcomeLaunch = async (source: LiveSource) => {
    const sequence = ++launchSequenceRef.current
    setLaunchPending(true)
    try {
      if (source === 'camera') await media.startCamera()
      else await media.startScreenShare()
    } finally {
      if (sequence === launchSequenceRef.current) setLaunchPending(false)
    }
  }

  useEffect(() => {
    if (!launchPending) return
    // Browsers may leave a permission request unresolved when the prompt is dismissed.
    const timer = window.setTimeout(() => {
      launchSequenceRef.current += 1
      setLaunchPending(false)
      clearSource('The source took too long to open. Try again.')
    }, LAUNCH_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [clearSource, launchPending])
  useEffect(() => {
    if (!starting) return
    const timer = window.setTimeout(() => {
      startSequenceRef.current += 1
      setStarting(false)
      pushToast({ message: 'The preview took too long to start. Try again.', tone: 'error' })
    }, PREVIEW_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [pushToast, starting])

  // Home screen: the welcome guide is the only path until a source is live.
  const onboarding = media.state.kind === 'none'

  const activeMediaElement = media.videoElRef.current
  const processingReady = media.state.ready && media.state.videoPlaying

  const alertModeRef = useRef(alertMode)
  alertModeRef.current = alertMode
  const monitoringRef = useRef(monitoring)
  monitoringRef.current = monitoring

  const handleNewFindings = useCallback(
    (newlyOpened: readonly TrackedIssue[]) => {
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

  const analysisConfigured = health?.analysis_configured ?? false
  const monitor = useBoardMonitor({
    mediaSource: activeMediaElement,
    mediaReady: processingReady && analysisConfigured && !healthFailed,
    sourceGeneration: media.state.sourceGeneration,
    monitoring,
    calibrationEditing,
    committedCorners,
    answerFormat,
    onNewFindings: handleNewFindings,
    onInvalidateSpeech: speech.cancelAll,
    onVerificationResult: handleVerificationResult,
  })

  const notesBuilder = useNotesBuilder({
    mediaSource: activeMediaElement,
    mediaReady: processingReady,
    sourceGeneration: media.state.sourceGeneration,
    enabled: analysisConfigured && !healthFailed,
    calibrationEditing,
    committedCorners,
  })

  const handleExportMarkdown = () => {
    downloadText(exportMarkdown(notesBuilder.notes), 'text/markdown;charset=utf-8', 'lecture-notes.md')
  }

  const handleExportLatex = () => {
    downloadText(exportLatex(notesBuilder.notes), 'application/x-tex', 'lecture-notes.tex')
  }

  const handleExportPrint = () => {
    const win = window.open('', '_blank')
    if (!win) {
      pushToast({ message: 'Allow pop-ups to open the printable notes.', tone: 'info' })
      return
    }
    win.opener = null
    win.document.open()
    win.addEventListener('load', async () => {
      // A print window has its own font set. Load the studio face before opening the dialog.
      try {
        const url = new URL('./app/fonts/dm-sans.woff2', import.meta.url)
        const font = new FontFace('DM Sans', 'url("' + url.href + '")', { weight: '100 1000' })
        win.document.fonts.add(await font.load())
      } catch {
        // The printable document also has a built-in sans serif fallback.
      }
      if (win.closed) return
      win.focus()
      win.print()
    }, { once: true })
    win.document.write(exportPrintHtml(notesBuilder.notes))
    win.document.close()
  }

  markSpokenRef.current = monitor.markSpoken
  monitorCallbacksRef.current = {
    onGeometryChange: () => {
      monitor.resetSession()
      notesBuilder.resetTracking()
    },
    onVideoSeek: () => {
      monitor.handleVideoSeek()
      notesBuilder.resetTracking()
    },
  }

  // Surface latest API error cleanly as a single toast with Retry.
  const requestCheckRef = useRef(monitor.requestCheckNow)
  requestCheckRef.current = monitor.requestCheckNow

  useEffect(() => {
    const err = monitor.state.apiError
    if (!err) return
    // The setup banner already explains an unreachable or unconfigured backend.
    if (healthFailed || !analysisConfigured) return
    const msg =
      err.retryAfterSeconds !== null
        ? `${err.message} Retrying in ${err.retryAfterSeconds}s.`
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
  }, [monitor.state.apiError, pushToast, analysisConfigured, healthFailed])

  const runAutomaticBoardDetection = async () => {
    const mediaEl = media.videoElRef.current
    if (!mediaEl || !media.state.ready) {
      setCalibrationDetectStatus('fallback')
      return
    }

    abortBoardDetection()
    const controller = new AbortController()
    detectAbortRef.current = controller
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
        setDraftCorners(result.corners)
        setCalibrationDetectStatus('detected')
      } else {
        setCalibrationDetectStatus('fallback')
      }
    } catch (err) {
      if (controller.signal.aborted) return
      if (isAbortError(err)) return
      setCalibrationDetectStatus('error')
    } finally {
      if (detectAbortRef.current === controller) {
        detectAbortRef.current = null
      }
    }
  }

  // Back to the landing page: release the camera/screen/file. clearSource triggers the normal
  // source reset, which stops monitoring and clears findings, calibration, and speech history.
  const handleGoHome = () => {
    speech.cancelAll()
    launchSequenceRef.current += 1
    setLaunchPending(false)
    setSelectedSource(null)
    setActivePanel(null)
    clearSource()
  }

  const playCurrentVideo = async () => {
    const video = media.videoElRef.current
    const { stream, objectUrl } = media.state
    if (!video || (!stream && !objectUrl)) return false

    const isCurrentSource = () => stream ? video.srcObject === stream : video.src === objectUrl
    if (!isCurrentSource()) return false
    try {
      await video.play()
      return isCurrentSource()
    } catch (err) {
      if (isCurrentSource() && !isAbortError(err)) {
        pushToast({ message: 'The preview couldn’t start. Try playing it again.', tone: 'error' })
      }
      return false
    }
  }

  const handleToggleVideoPlayback = () => {
    const video = media.videoElRef.current
    if (!video) return
    if (video.paused || video.ended) void playCurrentVideo()
    else video.pause()
  }

  const handleToggleMonitoring = async () => {
    if (monitoring) {
      setMonitoring(false)
      speech.cancelAll()
      return
    }
    if (starting || media.state.kind === 'none') return
    if ((!analysisConfigured || healthFailed) && !checkingHealth) retryHealth()

    speech.unlockAudio()
    const sequence = ++startSequenceRef.current
    setStarting(true)
    const started = await playCurrentVideo()
    if (sequence !== startSequenceRef.current) return
    setStarting(false)
    if (started) setMonitoring(true)
  }

  const handleChangeAlertMode = (mode: AlertMode) => {
    setAlertMode(mode)
    if (mode === 'visual_only') {
      speech.cancelAll()
    }
  }

  const openIssues = useMemo(
    () => monitor.state.tracker.issues.filter((item) => item.status === 'open'),
    [monitor.state.tracker.issues],
  )

  useEffect(() => {
    syncActiveIssueIds(new Set(openIssues.map((item) => item.id)))
  }, [openIssues, syncActiveIssueIds])

  const showVisualFindings = alertMode !== 'voice_only' || !speech.isSupported || speech.speechError !== null
  const closeCalibration = () => {
    abortBoardDetection()
    setCalibrationEditing(false)
    setCalibrationDetectStatus('idle')
    document.getElementById('crop-toggle')?.focus()
  }

  const handleToggleCalibration = () => {
    if (!media.state.ready) return
    if (calibrationEditing) {
      closeCalibration()
    } else {
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
    if (detectAbortRef.current) {
      abortBoardDetection()
      setCalibrationDetectStatus('idle')
    }
    setDraftCorners(next)
  }

  const handleApplyCalibration = () => {
    speech.resetHistory()
    setCommittedCorners(draftCorners)
    closeCalibration()
  }

  const handleResetCrop = () => {
    speech.resetHistory()
    setCommittedCorners(null)
    setDraftCorners(DEFAULT_CALIBRATION_CORNERS)
    closeCalibration()
  }

  const backendNeedsSetup = healthFailed || (health !== null && !analysisConfigured)

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-surface text-ink">
      <TopBar
        starting={starting}
        monitoring={monitoring}
        onToggleMonitoring={() => void handleToggleMonitoring()}
        onboarding={onboarding}
        onGoHome={handleGoHome}
        notesOpen={notesOpen}
        notesCount={notesBuilder.notes.sections.length}
        onToggleNotes={() => setActivePanel((panel) => panel === 'notes' ? null : 'notes')}
        settingsOpen={settingsOpen}
        onToggleSettings={() => setActivePanel((panel) => panel === 'settings' ? null : 'settings')}
        canCrop={media.state.ready && media.state.kind !== 'screen'}
        cropped={committedCorners !== null}
        calibrationEditing={calibrationEditing}
        onToggleCrop={handleToggleCalibration}
      />

      {backendNeedsSetup && (
        <div className="flex shrink-0 items-center justify-center gap-3 border-b border-warn-line bg-warn-soft px-4 py-2 text-sm text-warn animate-fade-in">
          <p role="status" className="flex items-start gap-2">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            {healthFailed ? 'Board checks and notes are offline. Check your connection and try again.' : 'Board checks and notes need a Gemini connection. You can still use the preview.'}
          </p>
          <button type="button" className="ui-button ui-compact" disabled={checkingHealth} onClick={retryHealth}>
            {checkingHealth ? 'Checking…' : 'Retry'}
          </button>
        </div>
      )}

      <Toasts toasts={toasts} onDismiss={dismissToast} />

      <div data-panel-open={activePanel !== null && !onboarding} className={onboarding
        ? 'relative flex min-h-0 flex-1 overflow-hidden'
        : 'group relative flex min-h-0 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto p-2 sm:gap-3 sm:p-3 lg:flex-row lg:overflow-hidden'}
      >
        <NotesPanel
          open={notesOpen && !onboarding}
          active={analysisConfigured && !healthFailed && processingReady && !calibrationEditing}
          configured={analysisConfigured && !healthFailed}
          editingCrop={calibrationEditing}
          phase={notesBuilder.phase}
          error={notesBuilder.error}
          notes={notesBuilder.notes}
          onClose={() => setActivePanel(null)}
          onExportMarkdown={handleExportMarkdown}
          onExportLatex={handleExportLatex}
          onExportPrint={handleExportPrint}
          onClear={() => notesBuilder.clear()}
        />
        <Stage
          mediaState={media.state}
          videoElRef={media.videoElRef}
          onToggleVideoPlayback={handleToggleVideoPlayback}
          onPlayPreview={() => void playCurrentVideo()}
          canMonitor={analysisConfigured && !healthFailed}
          monitoring={monitoring}
          starting={starting}
          phase={monitor.state.phase}
          showOverlays={showVisualFindings}
          openIssues={openIssues}
          selectedIssueId={selectedIssueId}
          hoveredIssueId={hoveredIssueId}
          onSelectIssue={setSelectedIssueId}
          onHoverIssue={setHoveredIssueId}
          calibrationEditing={calibrationEditing}
          calibrationDetectStatus={calibrationDetectStatus}
          draftCorners={draftCorners}
          committedCorners={committedCorners}
          onChangeDraftCorners={handleChangeDraftCorners}
          onAutoDetectCalibration={() => void runAutomaticBoardDetection()}
          onApplyCalibration={handleApplyCalibration}
          onResetCrop={handleResetCrop}
          onCancelCalibration={closeCalibration}
          welcome={
            <WelcomeGuide
              source={selectedSource}
              onChangeSource={setSelectedSource}
              onLaunch={(source) => void handleWelcomeLaunch(source)}
              onUpload={media.loadUploadedFile}
              launching={launchPending && media.state.kind === 'none'}
              speechStyle={voicePreferences.speechStyle}
              onChangeSpeechStyle={(speechStyle) => handleChangeVoicePreferences({ speechStyle })}
              alertMode={alertMode}
              onChangeAlertMode={handleChangeAlertMode}
            />
          }
        />

        {!onboarding && (
          <SettingsPanel
            open={settingsOpen}
            onClose={() => setActivePanel(null)}
            alertMode={alertMode}
            onChangeAlertMode={handleChangeAlertMode}
            answerFormat={answerFormat}
            onChangeAnswerFormat={handleChangeAnswerFormat}
            voiceSettings={{
              preferences: effectiveVoicePreferences,
              onChange: handleChangeVoicePreferences,
              elevenLabsConfigured: speechConfigured,
              voices: elevenLabsVoices,
              voicesLoading,
              voicesError,
              onRetryVoices: retryVoices,
              previewingVoice: speech.previewingVoice,
              onPreviewVoice: speech.isSupported ? speech.previewVoice : undefined,
              onStopPreview: speech.stopPreview,
            }}
          />
        )}
      </div>
    </div>
  )
}

export default App

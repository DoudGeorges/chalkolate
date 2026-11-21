import {
  Activity,
  Camera,
  Crop,
  MonitorUp,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Upload,
  Volume2,
  VolumeX,
  Eye,
} from 'lucide-react'
import { useRef } from 'react'
import { HealthResponse, SubjectHint } from '../api/schemas'
import { MonitorPhase } from '../hooks/useBoardMonitor'
import { MediaSourceKind, VideoDeviceOption } from '../hooks/useMediaSource'

export type AlertMode = 'visual_only' | 'voice_visual' | 'voice_only'

export interface HeaderBarProps {
  phase: MonitorPhase
  mediaKind: MediaSourceKind
  mediaLabel: string
  mediaReady: boolean
  health: HealthResponse | null
  healthError: string | null
  lastLatencyMs: number | null
  lastAnalyzedAt: number | null
  isResultStale: boolean
  isSpeaking: boolean
}

const PHASE_BADGE: Record<MonitorPhase, { label: string; tone: string }> = {
  PAUSED: {
    label: 'Paused',
    tone: 'border-slate-700 bg-slate-800/90 text-slate-300',
  },
  WATCHING: {
    label: 'Watching',
    tone: 'border-emerald-700/60 bg-emerald-950/60 text-emerald-300',
  },
  WRITING: {
    label: 'Writing detected',
    tone: 'border-amber-600/60 bg-amber-950/60 text-amber-200',
  },
  STABILIZING: {
    label: 'Stabilizing',
    tone: 'border-sky-600/60 bg-sky-950/60 text-sky-200',
  },
  ANALYZING: {
    label: 'Analyzing',
    tone: 'border-indigo-500/70 bg-indigo-950/70 text-indigo-200',
  },
}

export function HeaderBar({
  phase,
  mediaKind,
  mediaLabel,
  mediaReady,
  health,
  healthError,
  lastLatencyMs,
  lastAnalyzedAt,
  isResultStale,
  isSpeaking,
}: HeaderBarProps) {
  const badge = PHASE_BADGE[phase]
  const analyzedClock =
    lastAnalyzedAt !== null
      ? new Date(lastAnalyzedAt).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      : null

  return (
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 bg-slate-900/90 px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-amber-500/40 bg-amber-500/15 text-amber-300 font-semibold">
          C
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-base font-semibold tracking-tight text-slate-100">
              Chalkolate
            </h1>
            <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[11px] font-medium text-slate-400">
              Lecture Board Monitor
            </span>
          </div>
          <p className="text-xs text-slate-400">
            {mediaKind === 'none'
              ? 'Select a camera, screen share, sample board, or uploaded media'
              : `${mediaLabel}${mediaReady ? '' : ' (loading...)'}`}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span
          role="status"
          aria-live="polite"
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium ${badge.tone}`}
        >
          <Activity className="h-3.5 w-3.5" aria-hidden="true" />
          {badge.label}
        </span>

        {isResultStale && (
          <span className="rounded-full border border-amber-700/70 bg-amber-950/60 px-2.5 py-1 font-medium text-amber-200">
            Stale results
          </span>
        )}

        {isSpeaking && (
          <span className="inline-flex items-center gap-1 rounded-full border border-sky-700/70 bg-sky-950/60 px-2.5 py-1 font-medium text-sky-200">
            <Volume2 className="h-3.5 w-3.5" aria-hidden="true" />
            Speaking
          </span>
        )}

        {lastLatencyMs !== null && (
          <span className="rounded-md border border-slate-800 bg-slate-950/80 px-2.5 py-1 text-slate-300">
            Last check: {lastLatencyMs} ms{analyzedClock ? ` (${analyzedClock})` : ''}
          </span>
        )}

        {healthError ? (
          <span className="rounded-md border border-rose-700/70 bg-rose-950/60 px-2.5 py-1 text-rose-200">
            Backend offline
          </span>
        ) : health ? (
          <span
            className={`rounded-md border px-2.5 py-1 ${
              health.analysis_configured
                ? 'border-emerald-800/70 bg-emerald-950/50 text-emerald-300'
                : 'border-amber-700/70 bg-amber-950/50 text-amber-200'
            }`}
          >
            {health.analysis_configured ? 'Gemini configured' : 'API key missing'}
          </span>
        ) : (
          <span className="rounded-md border border-slate-800 bg-slate-950/80 px-2.5 py-1 text-slate-400">
            Checking backend...
          </span>
        )}
      </div>
    </header>
  )
}

export interface ControlBarProps {
  mediaKind: MediaSourceKind
  mediaReady: boolean
  videoDevices: readonly VideoDeviceOption[]
  selectedDeviceId: string
  onSelectDeviceId: (id: string) => void
  onStartCamera: (deviceId?: string) => void
  onStartScreenShare: () => void
  onUploadFile: (file: File) => void
  onLoadSample: () => void
  paused: boolean
  onTogglePause: () => void
  onCheckNow: () => void
  onNewBoard: () => void
  calibrationEditing: boolean
  hasCalibration: boolean
  onToggleCalibration: () => void
  alertMode: AlertMode
  onChangeAlertMode: (mode: AlertMode) => void
  subjectHint: SubjectHint
  onChangeSubjectHint: (hint: SubjectHint) => void
  deepMode: boolean
  deepModeAvailable: boolean
  onChangeDeepMode: (enabled: boolean) => void
  enhanceChalkboard: boolean
  onChangeEnhanceChalkboard: (enabled: boolean) => void
  stabilizationMs: number
  onChangeStabilizationMs: (ms: number) => void
  isAnalyzing: boolean
}

export function ControlBar({
  mediaKind,
  mediaReady,
  videoDevices,
  selectedDeviceId,
  onSelectDeviceId,
  onStartCamera,
  onStartScreenShare,
  onUploadFile,
  onLoadSample,
  paused,
  onTogglePause,
  onCheckNow,
  onNewBoard,
  calibrationEditing,
  hasCalibration,
  onToggleCalibration,
  alertMode,
  onChangeAlertMode,
  subjectHint,
  onChangeSubjectHint,
  deepMode,
  deepModeAvailable,
  onChangeDeepMode,
  enhanceChalkboard,
  onChangeEnhanceChalkboard,
  stabilizationMs,
  onChangeStabilizationMs,
  isAnalyzing,
}: ControlBarProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) {
      onUploadFile(file)
    }
    event.target.value = ''
  }

  return (
    <section
      aria-label="Board monitoring controls"
      className="flex flex-col gap-2.5 border-b border-slate-800 bg-slate-900/60 px-4 py-2.5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => onStartCamera()}
            className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400 ${
              mediaKind === 'camera'
                ? 'border-amber-500/70 bg-amber-500/20 text-amber-100'
                : 'border-slate-700 bg-slate-800/80 text-slate-200 hover:bg-slate-800'
            }`}
          >
            <Camera className="h-3.5 w-3.5" aria-hidden="true" />
            Live Camera
          </button>

          {videoDevices.length > 0 && (
            <label className="sr-only" htmlFor="camera-device-select">
              Camera device
            </label>
          )}
          {videoDevices.length > 0 && (
            <select
              id="camera-device-select"
              aria-label="Camera device"
              value={selectedDeviceId}
              onChange={(e) => {
                onSelectDeviceId(e.target.value)
                if (mediaKind === 'camera') {
                  onStartCamera(e.target.value)
                }
              }}
              className="max-w-44 rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-200 focus-visible:outline-2 focus-visible:outline-amber-400"
            >
              {videoDevices.map((dev) => (
                <option key={dev.deviceId} value={dev.deviceId}>
                  {dev.label}
                </option>
              ))}
            </select>
          )}

          <button
            type="button"
            onClick={onStartScreenShare}
            title="Share a browser tab, window, or mirrored screen (for iPad mirroring, share the AirPlay/capture window)"
            className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400 ${
              mediaKind === 'screen'
                ? 'border-amber-500/70 bg-amber-500/20 text-amber-100'
                : 'border-slate-700 bg-slate-800/80 text-slate-200 hover:bg-slate-800'
            }`}
          >
            <MonitorUp className="h-3.5 w-3.5" aria-hidden="true" />
            Screen Share
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,video/*"
            onChange={handleFileChange}
            className="hidden"
            aria-label="Upload lecture board image or video"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400"
          >
            <Upload className="h-3.5 w-3.5" aria-hidden="true" />
            Upload Media
          </button>

          <button
            type="button"
            onClick={onLoadSample}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400"
          >
            <Sparkles className="h-3.5 w-3.5 text-amber-300" aria-hidden="true" />
            Load Sample Mistake
          </button>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={onToggleCalibration}
            disabled={!mediaReady}
            className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400 ${
              calibrationEditing
                ? 'border-sky-500 bg-sky-500/20 text-sky-100'
                : hasCalibration
                  ? 'border-sky-700/80 bg-sky-950/50 text-sky-200 hover:bg-sky-900/50'
                  : 'border-slate-700 bg-slate-800/80 text-slate-200 hover:bg-slate-800'
            }`}
          >
            <Crop className="h-3.5 w-3.5" aria-hidden="true" />
            {calibrationEditing
              ? 'Editing Crop'
              : hasCalibration
                ? 'Recalibrate'
                : 'Calibrate Board'}
          </button>

          <button
            type="button"
            onClick={onTogglePause}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400"
          >
            {paused ? (
              <>
                <Play className="h-3.5 w-3.5 text-emerald-300" aria-hidden="true" />
                Resume
              </>
            ) : (
              <>
                <Pause className="h-3.5 w-3.5 text-amber-300" aria-hidden="true" />
                Pause
              </>
            )}
          </button>

          <button
            type="button"
            onClick={onCheckNow}
            disabled={!mediaReady || paused || calibrationEditing}
            className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/70 bg-amber-500/20 px-3 py-1.5 text-xs font-semibold text-amber-100 transition hover:bg-amber-500/30 disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${isAnalyzing ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            Check Now
          </button>

          <button
            type="button"
            onClick={onNewBoard}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            New Board
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-300">
        <div className="flex items-center gap-1.5" role="group" aria-label="Alert presentation mode">
          <span className="text-slate-400">Alerts:</span>
          {(
            [
              { id: 'visual_only', label: 'Visual Only', Icon: Eye },
              { id: 'voice_visual', label: 'Voice + Visual', Icon: Volume2 },
              { id: 'voice_only', label: 'Voice Only', Icon: VolumeX },
            ] as const
          ).map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              aria-pressed={alertMode === id}
              onClick={() => onChangeAlertMode(id)}
              className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-xs transition focus-visible:outline-2 focus-visible:outline-amber-400 ${
                alertMode === id
                  ? 'border-amber-500/70 bg-amber-500/20 text-amber-100'
                  : 'border-slate-800 bg-slate-900/70 text-slate-300 hover:bg-slate-800'
              }`}
            >
              <Icon className="h-3 w-3" aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>

        <label className="flex items-center gap-1.5">
          <span className="text-slate-400">Subject:</span>
          <select
            aria-label="Subject hint"
            value={subjectHint}
            onChange={(e) => onChangeSubjectHint(e.target.value as SubjectHint)}
            className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200 focus-visible:outline-2 focus-visible:outline-amber-400"
          >
            <option value="auto">Auto</option>
            <option value="math">Math</option>
            <option value="physics">Physics</option>
            <option value="general">General</option>
          </select>
        </label>

        <label
          className={`flex items-center gap-1.5 ${
            deepModeAvailable ? 'cursor-pointer' : 'cursor-not-allowed opacity-55'
          }`}
          title={
            deepModeAvailable
              ? 'Use Deep Mode reasoning model (slower, higher accuracy budget)'
              : 'Deep Mode is disabled on the backend (GEMINI_DEEP_MODEL is empty)'
          }
        >
          <input
            type="checkbox"
            checked={deepMode && deepModeAvailable}
            disabled={!deepModeAvailable}
            onChange={(e) => onChangeDeepMode(e.target.checked)}
            className="h-3.5 w-3.5 accent-amber-400"
          />
          <span>Deep Mode</span>
          {!deepModeAvailable && <span className="text-[11px] text-slate-500">(disabled)</span>}
        </label>

        <label className="flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            checked={enhanceChalkboard}
            onChange={(e) => onChangeEnhanceChalkboard(e.target.checked)}
            className="h-3.5 w-3.5 accent-amber-400"
          />
          <span>Chalkboard Enhance</span>
        </label>

        <label className="flex items-center gap-2">
          <span className="text-slate-400">
            Stabilize: {(stabilizationMs / 1000).toFixed(1)}s
          </span>
          <input
            type="range"
            min={800}
            max={4000}
            step={200}
            value={stabilizationMs}
            onChange={(e) => onChangeStabilizationMs(Number(e.target.value))}
            aria-label="Stabilization delay seconds"
            className="w-24 accent-amber-400"
          />
        </label>
      </div>
    </section>
  )
}

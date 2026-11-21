import {
  AudioLines,
  Camera,
  Check,
  ChevronDown,
  Eye,
  MonitorUp,
  Play,
  Settings,
  Square,
  Upload,
  Volume2,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { MediaSourceKind, VideoDeviceOption } from '../hooks/useMediaSource'
import { AlertMode } from '../lib/categoryColors'

export interface TopBarProps {
  mediaKind: MediaSourceKind
  mediaReady: boolean
  videoDevices: readonly VideoDeviceOption[]
  selectedDeviceId: string
  onStartCamera: (deviceId?: string) => void
  onStartScreenShare: () => void
  onUploadFile: (file: File) => void
  monitoring: boolean
  onToggleMonitoring: () => void
  alertMode: AlertMode
  onChangeAlertMode: (mode: AlertMode) => void
}

const ALERT_MODE_OPTIONS: ReadonlyArray<{
  id: AlertMode
  label: string
  description: string
  icon: typeof Volume2
}> = [
  {
    id: 'voice_visual',
    label: 'Voice + Visual',
    description: 'Board highlights, findings list, and spoken alerts',
    icon: Volume2,
  },
  {
    id: 'visual_only',
    label: 'Visual only',
    description: 'Board highlights and findings list without speech',
    icon: Eye,
  },
  {
    id: 'voice_only',
    label: 'Voice only',
    description: 'Spoken alerts only with a clean board view',
    icon: AudioLines,
  },
]

export function TopBar({
  mediaKind,
  mediaReady,
  videoDevices,
  selectedDeviceId,
  onStartCamera,
  onStartScreenShare,
  onUploadFile,
  monitoring,
  onToggleMonitoring,
  alertMode,
  onChangeAlertMode,
}: TopBarProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const cameraMenuRef = useRef<HTMLDivElement | null>(null)
  const settingsMenuRef = useRef<HTMLDivElement | null>(null)

  const [cameraMenuOpen, setCameraMenuOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  useEffect(() => {
    if (!cameraMenuOpen && !settingsOpen) return

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (cameraMenuOpen && cameraMenuRef.current && !cameraMenuRef.current.contains(target)) {
        setCameraMenuOpen(false)
      }
      if (settingsOpen && settingsMenuRef.current && !settingsMenuRef.current.contains(target)) {
        setSettingsOpen(false)
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setCameraMenuOpen(false)
        setSettingsOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [cameraMenuOpen, settingsOpen])

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) {
      onUploadFile(file)
    }
    event.target.value = ''
  }

  return (
    <header className="relative z-40 grid h-14 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 border-b border-line bg-surface/95 px-4 backdrop-blur-md">
      {/* Left: Minimal wordmark */}
      <div className="justify-self-start min-w-0">
        <span className="text-sm font-semibold tracking-tight text-zinc-100 select-none">
          Chalkolate
        </span>
      </div>

      {/* Center: Strictly centered, height-locked source switcher */}
      <div
        role="group"
        aria-label="Board source"
        className="justify-self-center inline-flex h-8 items-center rounded-lg border border-line bg-zinc-900/80 p-0.5 text-xs"
      >
        <div
          ref={cameraMenuRef}
          className={`relative inline-flex h-7 items-center rounded-md transition duration-150 ${
            mediaKind === 'camera'
              ? 'bg-zinc-800 text-zinc-100'
              : 'text-zinc-400 hover:bg-white/[0.04]'
          }`}
        >
          <button
            type="button"
            aria-label="Camera"
            onClick={() => {
              setCameraMenuOpen(false)
              onStartCamera()
            }}
            className="inline-flex h-7 items-center gap-1.5 rounded-l-md pl-2.5 pr-2 font-medium leading-none transition duration-150 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            <Camera className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="hidden sm:inline">Camera</span>
          </button>
          <span
            className={`h-3.5 w-px ${mediaKind === 'camera' ? 'bg-white/15' : 'bg-white/10'}`}
            aria-hidden="true"
          />
          <button
            type="button"
            aria-label="Select camera device"
            aria-expanded={cameraMenuOpen}
            aria-haspopup="menu"
            onClick={() => setCameraMenuOpen((prev) => !prev)}
            className="inline-flex h-7 w-6 items-center justify-center rounded-r-md transition duration-150 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            <ChevronDown
              className={`h-3.5 w-3.5 shrink-0 transition-transform duration-150 ${
                cameraMenuOpen ? 'rotate-180' : ''
              }`}
              aria-hidden="true"
            />
          </button>

          {cameraMenuOpen && (
            <div
              role="menu"
              aria-label="Available cameras"
              className="absolute top-full left-0 mt-2 w-64 rounded-xl border border-line bg-panel p-1.5 shadow-2xl backdrop-blur-xl"
            >
              {videoDevices.length === 0 ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setCameraMenuOpen(false)
                    onStartCamera()
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-zinc-200 transition hover:bg-white/10"
                >
                  <Camera className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
                  <span>Enable camera to list devices</span>
                </button>
              ) : (
                videoDevices.map((device) => {
                  const isActive =
                    mediaKind === 'camera' && device.deviceId === selectedDeviceId
                  return (
                    <button
                      key={device.deviceId}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setCameraMenuOpen(false)
                        onStartCamera(device.deviceId)
                      }}
                      className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition ${
                        isActive
                          ? 'bg-white/10 font-medium text-zinc-100'
                          : 'text-zinc-300 hover:bg-white/5 hover:text-zinc-100'
                      }`}
                    >
                      <span className="truncate">{device.label}</span>
                      {isActive && (
                        <Check
                          className="h-3.5 w-3.5 shrink-0 text-accent"
                          aria-hidden="true"
                        />
                      )}
                    </button>
                  )
                })
              )}
            </div>
          )}
        </div>

        <span className="mx-0.5 h-3.5 w-px bg-white/10" aria-hidden="true" />

        <button
          type="button"
          aria-label="Screen"
          onClick={onStartScreenShare}
          className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 font-medium leading-none transition duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
            mediaKind === 'screen'
              ? 'bg-zinc-800 text-zinc-100'
              : 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100'
          }`}
        >
          <MonitorUp className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="hidden sm:inline">Screen</span>
        </button>

        <span className="mx-0.5 h-3.5 w-px bg-white/10" aria-hidden="true" />

        <input
          ref={fileInputRef}
          type="file"
          accept="video/*,image/*"
          onChange={handleFileChange}
          className="hidden"
          aria-label="Upload lecture video or image"
        />
        <button
          type="button"
          aria-label="Upload"
          onClick={() => fileInputRef.current?.click()}
          className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 font-medium leading-none transition duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
            mediaKind === 'video' || mediaKind === 'image'
              ? 'bg-zinc-800 text-zinc-100'
              : 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100'
          }`}
        >
          <Upload className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="hidden sm:inline">Upload</span>
        </button>
      </div>

      {/* Right: Start/Stop + Settings gear */}
      <div className="justify-self-end flex items-center gap-2">
        <button
          type="button"
          disabled={!mediaReady}
          aria-pressed={monitoring}
          onClick={onToggleMonitoring}
          className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-xs font-semibold leading-none transition duration-150 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
            monitoring
              ? 'border border-line bg-zinc-800 text-zinc-100 hover:bg-zinc-700'
              : 'bg-accent text-zinc-950 hover:brightness-105'
          }`}
        >
          {monitoring ? (
            <>
              <Square className="h-3 w-3 shrink-0 fill-rose-400 text-rose-400" aria-hidden="true" />
              <span>Stop</span>
            </>
          ) : (
            <>
              <Play className="h-3 w-3 shrink-0 fill-current" aria-hidden="true" />
              <span>Start</span>
            </>
          )}
        </button>

        <div ref={settingsMenuRef} className="relative">
          <button
            type="button"
            aria-label="Settings"
            aria-expanded={settingsOpen}
            aria-haspopup="dialog"
            onClick={() => setSettingsOpen((prev) => !prev)}
            className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border transition duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
              settingsOpen
                ? 'border-accent/50 bg-zinc-800 text-zinc-100'
                : 'border-line bg-zinc-900/80 text-zinc-400 hover:text-zinc-100'
            }`}
          >
            <Settings className="h-4 w-4 shrink-0" aria-hidden="true" />
          </button>

          {settingsOpen && (
            <div
              role="dialog"
              aria-label="Settings"
              className="absolute top-full right-0 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-line bg-panel shadow-2xl backdrop-blur-xl"
            >
              <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
                <h2 className="text-xs font-semibold tracking-wide text-zinc-100">
                  Settings
                </h2>
                <button
                  type="button"
                  aria-label="Close settings"
                  onClick={() => setSettingsOpen(false)}
                  className="rounded-md p-1 text-zinc-400 transition hover:bg-white/10 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>

              <div className="p-3.5 space-y-2.5">
                <span className="block text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                  Alert mode
                </span>
                <div role="radiogroup" aria-label="Alert mode" className="space-y-1.5">
                  {ALERT_MODE_OPTIONS.map((option) => {
                    const Icon = option.icon
                    const selected = alertMode === option.id
                    return (
                      <button
                        key={option.id}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => onChangeAlertMode(option.id)}
                        className={`flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
                          selected
                            ? 'border-accent/50 bg-accent/[0.08] text-zinc-100'
                            : 'border-transparent bg-white/[0.02] text-zinc-300 hover:border-line hover:bg-white/[0.05]'
                        }`}
                      >
                        <Icon
                          className={`mt-0.5 h-4 w-4 shrink-0 ${
                            selected ? 'text-accent' : 'text-zinc-400'
                          }`}
                          aria-hidden="true"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-medium">{option.label}</span>
                            {selected && (
                              <Check
                                className="h-3.5 w-3.5 shrink-0 text-accent"
                                aria-hidden="true"
                              />
                            )}
                          </div>
                          <p className="mt-0.5 text-[11px] leading-snug text-zinc-400">
                            {option.description}
                          </p>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}

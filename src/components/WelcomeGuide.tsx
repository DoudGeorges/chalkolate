import { Camera, ChevronDown, MonitorUp, Play, Square, Upload } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AlertMode } from '../lib/categoryColors'
import { Talkativeness } from '../lib/voicePreferences'
import { ALERT_MODE_OPTIONS } from './alertModeOptions'
import { TalkativenessPicker } from './TalkativenessPicker'

export type WelcomeSource = 'camera' | 'screen' | 'upload'

/** Natural height of the voice dropdown (header, search, list, Done). */
const MENU_PREFERRED_HEIGHT = 360
const MENU_MIN_HEIGHT = 160
const MENU_VIEWPORT_MARGIN = 12

export interface WelcomeGuideProps {
  /**
   * Called only from the final Start button, after every choice is made. Opens the chosen
   * source (camera/screen permission prompt or the picked file) and begins checking.
   */
  onLaunch: (source: WelcomeSource, file?: File) => void
  /** e.g. "Anuj" or "Browser voice"; null when alerts are visual only. */
  voiceName: string | null
  talkativeness: Talkativeness
  onChangeTalkativeness: (value: Talkativeness) => void
  alertMode: AlertMode
  onChangeAlertMode: (mode: AlertMode) => void
  onOpenSettings: () => void
  onPreviewVoice?: () => void
  previewing?: boolean
  onStopPreview?: () => void
  /** True while the chosen source is opening after Start was pressed. */
  launching?: boolean
  /**
   * Contents of the "Change voice" dropdown; receives a close callback. Without it the
   * button falls back to opening the settings panel.
   */
  renderVoiceMenu?: (close: () => void) => React.ReactNode
}

const SOURCES: ReadonlyArray<{
  id: WelcomeSource
  label: string
  detail: string
  icon: typeof Camera
  startLabel: string
}> = [
  {
    id: 'camera',
    label: 'Camera',
    detail: 'Point it at a board',
    icon: Camera,
    startLabel: 'Start with camera',
  },
  {
    id: 'screen',
    label: 'Screen',
    detail: 'Share a window or tab',
    icon: MonitorUp,
    startLabel: 'Start with screen share',
  },
  {
    id: 'upload',
    label: 'Upload',
    detail: 'A lecture video or photo',
    icon: Upload,
    startLabel: 'Choose a file to start',
  },
]

function StepNumber({ n }: { n: number }) {
  return (
    <span
      aria-hidden="true"
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/10 text-[11px] font-semibold text-accent"
    >
      {n}
    </span>
  )
}

/** First-visit guide on the empty stage: choose a source and voice, then press Start. */
export function WelcomeGuide({
  onLaunch,
  voiceName,
  talkativeness,
  onChangeTalkativeness,
  alertMode,
  onChangeAlertMode,
  onOpenSettings,
  onPreviewVoice,
  previewing = false,
  onStopPreview,
  launching = false,
  renderVoiceMenu,
}: WelcomeGuideProps) {
  const fileRef = useRef<HTMLInputElement | null>(null)
  const voiceMenuRef = useRef<HTMLDivElement | null>(null)
  const [voiceMenuOpen, setVoiceMenuOpen] = useState(false)
  // Keep the voice dropdown inside the window: open upward when there is more room above,
  // and cap its height to the space available on the chosen side.
  const [voiceMenuPlacement, setVoiceMenuPlacement] = useState<{
    up: boolean
    maxHeight: number
  }>({ up: false, maxHeight: MENU_PREFERRED_HEIGHT })

  useLayoutEffect(() => {
    if (!voiceMenuOpen) return
    const place = () => {
      const trigger = voiceMenuRef.current
      if (!trigger || typeof window === 'undefined') return
      const rect = trigger.getBoundingClientRect()
      const below = window.innerHeight - rect.bottom - MENU_VIEWPORT_MARGIN
      const above = rect.top - MENU_VIEWPORT_MARGIN
      const up = below < MENU_PREFERRED_HEIGHT && above > below
      setVoiceMenuPlacement({
        up,
        maxHeight: Math.max(MENU_MIN_HEIGHT, Math.min(MENU_PREFERRED_HEIGHT, up ? above : below)),
      })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [voiceMenuOpen])

  useEffect(() => {
    if (!voiceMenuOpen) return
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (target && voiceMenuRef.current && !voiceMenuRef.current.contains(target)) {
        setVoiceMenuOpen(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setVoiceMenuOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [voiceMenuOpen])
  const [source, setSource] = useState<WelcomeSource | null>(null)
  const selected = SOURCES.find((s) => s.id === source) ?? null

  const handleStart = () => {
    if (!source || launching) return
    if (source === 'upload') {
      // The file picker must open from this click; launching happens once a file is chosen.
      fileRef.current?.click()
      return
    }
    onLaunch(source)
  }

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto px-6 py-8">
      <div className="w-full max-w-lg">
        <div className="rounded-xl border border-line bg-white shadow-sm">
          <ol className="divide-y divide-zinc-200">
            <li className="flex gap-3.5 p-4">
              <StepNumber n={1} />
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-medium text-zinc-900">Choose what to watch</h2>
                <div
                  role="radiogroup"
                  aria-label="What to watch"
                  className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3"
                >
                  {SOURCES.map((option) => {
                    const Icon = option.icon
                    const isSelected = source === option.id
                    return (
                      <button
                        key={option.id}
                        type="button"
                        role="radio"
                        aria-checked={isSelected}
                        onClick={() => setSource(option.id)}
                        className={`flex flex-col items-start gap-1 rounded-lg border px-3 py-2.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
                          isSelected
                            ? 'border-accent bg-accent/[0.06]'
                            : 'border-line bg-white hover:border-zinc-300 hover:bg-zinc-50'
                        }`}
                      >
                        <Icon
                          className={`h-4 w-4 ${isSelected ? 'text-accent' : 'text-zinc-500'}`}
                          aria-hidden="true"
                        />
                        <span className="text-xs font-medium text-zinc-900">{option.label}</span>
                        <span className="text-[11px] leading-snug text-zinc-500">
                          {option.detail}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
            </li>

            <li className="flex gap-3.5 p-4">
              <StepNumber n={2} />
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-medium text-zinc-900">Choose an alert mode</h2>
                <div
                  role="radiogroup"
                  aria-label="Alert mode"
                  className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3"
                >
                  {ALERT_MODE_OPTIONS.map((option) => {
                    const Icon = option.icon
                    const isSelected = alertMode === option.id
                    return (
                      <button
                        key={option.id}
                        type="button"
                        role="radio"
                        aria-checked={isSelected}
                        onClick={() => onChangeAlertMode(option.id)}
                        className={`flex flex-col items-start gap-1 rounded-lg border px-3 py-2.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
                          isSelected
                            ? 'border-accent bg-accent/[0.06]'
                            : 'border-line bg-white hover:border-zinc-300 hover:bg-zinc-50'
                        }`}
                      >
                        <Icon
                          className={`h-4 w-4 ${isSelected ? 'text-accent' : 'text-zinc-500'}`}
                          aria-hidden="true"
                        />
                        <span className="text-xs font-medium text-zinc-900">{option.label}</span>
                        <span className="text-[11px] leading-snug text-zinc-500">
                          {option.short}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
            </li>

            <li className="flex gap-3.5 p-4">
              <StepNumber n={3} />
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-medium text-zinc-900">
                  Pick a voice and how much it talks
                </h2>
                <p className="mt-0.5 text-xs text-zinc-500">
                  Choose who reads the alerts and whether you want a quick heads-up or a full
                  explanation for each mistake.
                </p>
                {voiceName ? (
                  <div className="mt-3 space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <div ref={voiceMenuRef} className="relative">
                        <button
                          type="button"
                          aria-label={`Change voice (current: ${voiceName})`}
                          aria-haspopup="dialog"
                          aria-expanded={voiceMenuOpen}
                          onClick={() =>
                            renderVoiceMenu ? setVoiceMenuOpen((prev) => !prev) : onOpenSettings()
                          }
                          className={`inline-flex max-w-full items-center gap-1.5 rounded-lg border bg-white px-2.5 py-1.5 text-[11px] shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
                            voiceMenuOpen
                              ? 'border-accent'
                              : 'border-line hover:border-zinc-300 hover:bg-zinc-50'
                          }`}
                        >
                          <span className="text-zinc-500">Voice</span>
                          <span className="truncate font-medium text-zinc-900">{voiceName}</span>
                          <ChevronDown
                            className={`h-3.5 w-3.5 shrink-0 text-zinc-500 transition-transform ${
                              voiceMenuOpen ? 'rotate-180' : ''
                            }`}
                            aria-hidden="true"
                          />
                        </button>
                        {voiceMenuOpen && renderVoiceMenu && (
                          <div
                            role="dialog"
                            aria-label="Choose a voice"
                            data-placement={voiceMenuPlacement.up ? 'up' : 'down'}
                            style={{ maxHeight: `${voiceMenuPlacement.maxHeight}px` }}
                            className={`absolute left-0 z-30 w-80 max-w-[calc(100vw-3rem)] overflow-y-auto overscroll-contain rounded-xl border border-line bg-white p-3 shadow-lg [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${
                              voiceMenuPlacement.up ? 'bottom-full mb-2' : 'top-full mt-2'
                            }`}
                          >
                            {renderVoiceMenu(() => setVoiceMenuOpen(false))}
                          </div>
                        )}
                      </div>
                      {onPreviewVoice && (
                        <button
                          type="button"
                          onClick={() => (previewing ? onStopPreview?.() : onPreviewVoice())}
                          className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-medium text-accent transition hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                        >
                          {previewing ? (
                            <Square className="h-2.5 w-2.5 fill-current" aria-hidden="true" />
                          ) : (
                            <Play className="h-2.5 w-2.5 fill-current" aria-hidden="true" />
                          )}
                          {previewing ? 'Stop' : 'Hear it'}
                        </button>
                      )}
                    </div>
                    <TalkativenessPicker value={talkativeness} onChange={onChangeTalkativeness} />
                  </div>
                ) : (
                  <p className="mt-3 rounded-lg bg-zinc-100 px-2.5 py-1.5 text-[11px] text-zinc-600">
                    Voice is off in Visual only mode. Choose an alert mode with voice in step 2 to
                    pick a voice.
                  </p>
                )}
              </div>
            </li>
          </ol>

          <div className="border-t border-line p-4">
            <p className="mb-2 text-xs text-zinc-600">
              When configured, Gemini processes board snapshots for corrections and lecture notes.
              You can pause notes separately in the Notes panel.
            </p>
            <input
              ref={fileRef}
              type="file"
              accept="video/*,image/*"
              aria-label="Upload lecture video or image"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) onLaunch('upload', file)
                e.target.value = ''
              }}
              className="hidden"
            />
            <button
              type="button"
              onClick={handleStart}
              disabled={!source || launching}
              className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-semibold text-white shadow-sm transition hover:brightness-110 disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-500 disabled:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2"
            >
              <Play className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
              {launching ? 'Starting…' : selected ? selected.startLabel : 'Start'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

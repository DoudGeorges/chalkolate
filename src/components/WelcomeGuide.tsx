import { Camera, MonitorUp, Play, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { AlertMode } from '../lib/categoryColors'
import { Talkativeness } from '../lib/voicePreferences'
import { ALERT_MODE_OPTIONS } from './alertModeOptions'
import { TalkativenessPicker } from './TalkativenessPicker'

export type WelcomeSource = 'camera' | 'screen' | 'upload'

export interface WelcomeGuideProps {
  /**
   * Called only from the final Start button, after every choice is made. Opens the chosen
   * source (camera/screen permission prompt or the picked file) and begins checking.
   */
  onLaunch: (source: WelcomeSource, file?: File) => void
  talkativeness: Talkativeness
  onChangeTalkativeness: (value: Talkativeness) => void
  alertMode: AlertMode
  onChangeAlertMode: (mode: AlertMode) => void
  /** True while the chosen source is opening after Start was pressed. */
  launching?: boolean
}

const SOURCES: ReadonlyArray<{ id: WelcomeSource; label: string; icon: typeof Camera }> = [
  { id: 'camera', label: 'Camera', icon: Camera },
  { id: 'screen', label: 'Screen', icon: MonitorUp },
  { id: 'upload', label: 'Upload', icon: Upload },
]

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3.5 p-4">
      <span
        aria-hidden="true"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/10 text-[11px] font-semibold text-accent"
      >
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-medium text-zinc-900">{title}</h2>
        <div className="mt-3">{children}</div>
      </div>
    </li>
  )
}

function OptionCard({
  label,
  icon: Icon,
  selected,
  onSelect,
}: {
  label: string
  icon: typeof Camera
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`flex flex-col items-start gap-1.5 rounded-lg border px-3 py-2.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
        selected
          ? 'border-accent bg-accent/[0.06]'
          : 'border-line bg-white hover:border-zinc-300 hover:bg-zinc-50'
      }`}
    >
      <Icon className={`h-4 w-4 ${selected ? 'text-accent' : 'text-zinc-500'}`} aria-hidden="true" />
      <span className="text-xs font-medium text-zinc-900">{label}</span>
    </button>
  )
}

/** First-visit guide on the empty stage: choose a source and alert style, then press Start. */
export function WelcomeGuide({
  onLaunch,
  talkativeness,
  onChangeTalkativeness,
  alertMode,
  onChangeAlertMode,
  launching = false,
}: WelcomeGuideProps) {
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [source, setSource] = useState<WelcomeSource | null>(null)

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
        <div className="mb-6 text-center">
          <h1 className="text-lg font-semibold tracking-tight text-zinc-900">
            Catch mistakes on the board as they&apos;re written
          </h1>
          <p className="mx-auto mt-1.5 max-w-md text-xs leading-relaxed text-zinc-500">
            Chalkolate watches a whiteboard or lecture and points out math, physics, and spelling
            mistakes on screen and out loud. Nothing turns on until you press Start.
          </p>
        </div>

        <div className="rounded-xl border border-line bg-white shadow-sm">
          <ol className="divide-y divide-line">
            <Step n={1} title="Choose what to watch">
              <div
                role="radiogroup"
                aria-label="What to watch"
                className="grid grid-cols-1 gap-2 sm:grid-cols-3"
              >
                {SOURCES.map((option) => (
                  <OptionCard
                    key={option.id}
                    label={option.label}
                    icon={option.icon}
                    selected={source === option.id}
                    onSelect={() => setSource(option.id)}
                  />
                ))}
              </div>
            </Step>

            <Step n={2} title="Choose an alert mode">
              <div
                role="radiogroup"
                aria-label="Alert mode"
                className="grid grid-cols-1 gap-2 sm:grid-cols-3"
              >
                {ALERT_MODE_OPTIONS.map((option) => (
                  <OptionCard
                    key={option.id}
                    label={option.label}
                    icon={option.icon}
                    selected={alertMode === option.id}
                    onSelect={() => onChangeAlertMode(option.id)}
                  />
                ))}
              </div>
            </Step>

            {alertMode !== 'visual_only' && (
              <Step n={3} title="Choose how much it says">
                <TalkativenessPicker value={talkativeness} onChange={onChangeTalkativeness} />
              </Step>
            )}
          </ol>

          <div className="space-y-2.5 border-t border-line p-4">
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
              {launching ? 'Starting…' : 'Start'}
            </button>
            <p className="text-center text-[11px] leading-snug text-zinc-500">
              When configured, Gemini processes board snapshots for corrections and lecture notes.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

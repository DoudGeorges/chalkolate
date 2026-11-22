import { ArrowRight, Camera, FileVideo, LoaderCircle, MonitorUp } from 'lucide-react'
import { useRef } from 'react'
import { AlertMode } from '../lib/categoryColors'
import type { SpeechStyle } from '../lib/voicePreferences'
import { ALERT_MODE_OPTIONS } from './alertModeOptions'
import { OptionGroup } from './OptionGroup'
import { SpeechStylePicker } from './SpeechStylePicker'

export type LiveSource = 'camera' | 'screen'
export type WelcomeSource = LiveSource | 'upload'

export interface WelcomeGuideProps {
  source: WelcomeSource | null
  onChangeSource: (source: WelcomeSource) => void
  onLaunch: (source: LiveSource) => void
  onUpload: (file: File) => void
  speechStyle: SpeechStyle
  onChangeSpeechStyle: (style: SpeechStyle) => void
  alertMode: AlertMode
  onChangeAlertMode: (mode: AlertMode) => void
  launching?: boolean
}

const SOURCES = [
  { id: 'camera', label: 'Camera', icon: Camera },
  { id: 'screen', label: 'Screen', icon: MonitorUp },
  { id: 'upload', label: 'Video file', icon: FileVideo },
] as const

const OPEN_LABELS = { camera: 'Open camera', screen: 'Share screen', upload: 'Choose video' } as const

export function WelcomeGuide({
  source,
  onChangeSource,
  onLaunch,
  onUpload,
  speechStyle,
  onChangeSpeechStyle,
  alertMode,
  onChangeAlertMode,
  launching = false,
}: WelcomeGuideProps) {
  const fileInput = useRef<HTMLInputElement>(null)

  return (
    <div className="flex h-full overflow-y-auto px-4 py-6 sm:py-10">
      <form
        className="m-auto w-full max-w-[30rem] rounded-2xl border border-line bg-panel p-5 shadow-pop animate-rise-in sm:p-8"
        onSubmit={(event) => {
          event.preventDefault()
          if (launching || !source) return
          if (source === 'upload') fileInput.current?.click()
          else onLaunch(source)
        }}
        aria-labelledby="session-heading"
      >
        <h1 id="session-heading" className="ui-title">
          Logo
        </h1>
        <p className="ui-copy mt-2">
          Open a board preview, then select Start when you want to check for mistakes.
        </p>
        <div className="mt-6 space-y-5 border-t border-line pt-6">
          <OptionGroup label="Source" value={source} onChange={onChangeSource} options={SOURCES} disabled={launching} />
          <OptionGroup label="Feedback" value={alertMode} onChange={onChangeAlertMode} options={ALERT_MODE_OPTIONS} />
          {alertMode !== 'visual_only' && (
            <SpeechStylePicker value={speechStyle} onChange={onChangeSpeechStyle} />
          )}
        </div>

        <button
          type="submit"
          data-variant="primary"
          disabled={!source || launching}
          aria-busy={launching}
          className="ui-button mt-6 min-h-11 w-full"
        >
          {launching ? 'Opening preview…' : source ? OPEN_LABELS[source] : 'Open preview'}
          {launching ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <ArrowRight aria-hidden="true" />}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="video/*,.mp4,.m4v,.mov,.webm,.ogv"
          aria-label="Video file"
          hidden
          onChange={(event) => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ''
            if (file) onUpload(file)
          }}
        />
      </form>
    </div>
  )
}

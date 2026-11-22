import { LoaderCircle, Play, Settings, Square } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Brand } from './Brand'

export interface TopBarProps {
  starting: boolean
  monitoring: boolean
  onToggleMonitoring: () => void
  onboarding?: boolean
  onGoHome: () => void
  settingsOpen: boolean
  onToggleSettings: () => void
}

export function TopBar({
  starting,
  monitoring,
  onToggleMonitoring,
  onboarding = false,
  onGoHome,
  settingsOpen,
  onToggleSettings,
}: TopBarProps) {
  const startButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!onboarding) startButton.current?.focus({ preventScroll: true })
  }, [onboarding])

  return (
    <header className="relative z-40 shrink-0 border-b border-line bg-panel">
      <div className="px-4 sm:px-6">
        <div className="flex min-h-16 flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2">
          <button
            type="button"
            onClick={onGoHome}
            aria-label="Chalkolate home"
            title="Return to setup"
            className="inline-flex -m-1 rounded-lg p-1 transition-opacity hover:opacity-80"
          >
            <Brand />
          </button>

          {!onboarding && (
            <div className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                ref={startButton}
                disabled={starting}
                aria-busy={starting}
                title={monitoring ? 'Stop checking the board' : 'Start checking the board'}
                onClick={onToggleMonitoring}
                className="ui-button px-2.5 sm:px-3"
                data-variant={monitoring ? 'danger' : 'primary'}
              >
                {starting ? (
                  <LoaderCircle className="animate-spin" aria-hidden="true" />
                ) : monitoring ? (
                  <Square className="fill-current" aria-hidden="true" />
                ) : (
                  <Play className="fill-current" aria-hidden="true" />
                )}
                {starting ? 'Starting…' : monitoring ? 'Stop checking' : 'Start checking'}
              </button>
              <button
                type="button"
                id="settings-toggle"
                onClick={onToggleSettings}
                aria-label="Settings"
                title="Settings"
                aria-expanded={settingsOpen}
                aria-controls="studio-settings-panel"
                className="ui-button w-10 px-0"
              >
                <Settings aria-hidden="true" />
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}

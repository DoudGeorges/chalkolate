import { Crop, LoaderCircle, NotebookPen, Play, SlidersHorizontal, Square } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Brand } from './Brand'

export interface TopBarProps {
  starting: boolean
  monitoring: boolean
  onToggleMonitoring: () => void
  onboarding?: boolean
  onGoHome: () => void
  notesOpen: boolean
  notesCount: number
  settingsOpen: boolean
  onToggleSettings: () => void
  onToggleNotes: () => void
  canCrop: boolean
  cropped: boolean
  calibrationEditing: boolean
  onToggleCrop: () => void
}

export function TopBar({
  starting,
  monitoring,
  onToggleMonitoring,
  onboarding = false,
  onGoHome,
  notesOpen,
  notesCount,
  settingsOpen,
  onToggleSettings,
  onToggleNotes,
  canCrop,
  cropped,
  calibrationEditing,
  onToggleCrop,
}: TopBarProps) {
  const cropLabel = calibrationEditing ? 'Cancel crop' : cropped ? 'Adjust crop' : 'Crop board'
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
            title="Return to session setup"
            className="inline-flex -mx-1 rounded-md px-1 transition-opacity hover:opacity-80"
          >
            <Brand />
          </button>

          {!onboarding && (
            <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
              <button
                type="button"
                id="notes-toggle"
                onClick={onToggleNotes}
                aria-expanded={notesOpen}
                aria-controls="lecture-notes-panel"
                className="ui-button px-2.5 sm:px-3"
              >
                <NotebookPen aria-hidden="true" />
                Notes
                {notesCount > 0 && (
                  <span className="ui-badge">{notesCount}<span className="sr-only">{notesCount === 1 ? ' section' : ' sections'}</span></span>
                )}
              </button>
              <button
                type="button"
                id="settings-toggle"
                onClick={onToggleSettings}
                aria-label="Settings"
                title="Settings"
                aria-expanded={settingsOpen}
                aria-controls="studio-settings-panel"
                className="ui-button px-2.5 sm:px-3"
              >
                <SlidersHorizontal aria-hidden="true" />
                <span className="hidden min-[360px]:inline">Settings</span>
              </button>
              {canCrop && (
                <button
                  type="button"
                  id="crop-toggle"
                  onClick={onToggleCrop}
                  title={cropLabel}
                  aria-label={cropLabel}
                  aria-expanded={calibrationEditing}
                  className="ui-button px-2.5 sm:px-3"
                  data-selected={cropped}
                >
                  <Crop aria-hidden="true" />
                  <span className="hidden lg:inline">{cropLabel}</span>
                </button>
              )}
              <span aria-hidden="true" className="mx-1 hidden h-5 w-px bg-line sm:block" />
              <button
                type="button"
                ref={startButton}
                disabled={starting}
                aria-busy={starting}
                title={monitoring ? 'Stop board checks and spoken alerts' : 'Start board checks'}
                onClick={onToggleMonitoring}
                className="ui-button ml-auto px-2.5 sm:ml-0 sm:px-3"
                data-variant={monitoring ? 'danger' : 'primary'}
              >
                {starting ? (
                  <LoaderCircle className="animate-spin" aria-hidden="true" />
                ) : monitoring ? (
                  <Square className="fill-current" aria-hidden="true" />
                ) : (
                  <Play className="fill-current" aria-hidden="true" />
                )}
                {starting ? 'Starting…' : monitoring ? 'Stop' : 'Start'}
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}

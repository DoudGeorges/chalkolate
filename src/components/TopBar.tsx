import { ArrowLeft, Play, Settings, Square } from 'lucide-react'

export interface TopBarProps {
  mediaReady: boolean
  monitoring: boolean
  onToggleMonitoring: () => void
  /** Whether the left settings panel is open. */
  settingsOpen?: boolean
  onToggleSettings?: () => void
  /** Landing page: hide Start/Stop and Settings so the welcome guide is the one path. */
  onboarding?: boolean
  /** Close the current source and return to the welcome guide (shown when not onboarding). */
  onGoHome?: () => void
}

export function TopBar({
  mediaReady,
  monitoring,
  onToggleMonitoring,
  settingsOpen = false,
  onToggleSettings,
  onboarding = false,
  onGoHome,
}: TopBarProps) {
  return (
    <header className="relative z-40 flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line bg-white px-4">
      {/* Left: wordmark + way back to the landing page once a source is live */}
      <div className="flex min-w-0 items-center gap-3">
        <span className="text-sm font-semibold tracking-tight text-zinc-900 select-none">
          Chalkolate
        </span>
        {!onboarding && onGoHome && (
          <button
            type="button"
            onClick={onGoHome}
            title="Close this source and go back to the start page"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-white px-2.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-50 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            Back to start
          </button>
        )}
      </div>

      {/* Right: Start/Stop + Settings gear */}
      <div className="flex items-center gap-2">
        {!onboarding && (
          <button
            type="button"
            disabled={!mediaReady}
            aria-pressed={monitoring}
            onClick={onToggleMonitoring}
            className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-xs font-semibold leading-none transition duration-150 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
              monitoring
                ? 'border border-line bg-white text-zinc-900 shadow-sm hover:bg-zinc-100'
                : 'bg-accent text-white hover:brightness-105'
            }`}
          >
            {monitoring ? (
              <>
                <Square className="h-3 w-3 shrink-0 fill-rose-500 text-rose-500" aria-hidden="true" />
                <span>Stop</span>
              </>
            ) : (
              <>
                <Play className="h-3 w-3 shrink-0 fill-current" aria-hidden="true" />
                <span>Start</span>
              </>
            )}
          </button>
        )}

        {!onboarding && onToggleSettings && (
          <button
            type="button"
            aria-label="Settings"
            aria-expanded={settingsOpen}
            aria-controls="findings-sidebar-content"
            title={settingsOpen ? 'Hide settings' : 'Show settings'}
            onClick={onToggleSettings}
            className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border transition duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
              settingsOpen
                ? 'border-accent bg-accent/[0.06] text-accent'
                : 'border-line bg-white text-zinc-500 hover:bg-zinc-50 hover:text-zinc-900'
            }`}
          >
            <Settings className="h-4 w-4 shrink-0" aria-hidden="true" />
          </button>
        )}
      </div>
    </header>
  )
}

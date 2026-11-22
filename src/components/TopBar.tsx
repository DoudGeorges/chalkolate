import { ArrowLeft, Crop, FileText, Play, Square } from 'lucide-react'

export interface TopBarProps {
  mediaReady: boolean
  monitoring: boolean
  onToggleMonitoring: () => void
  /** Landing page: hide Start/Stop so the welcome guide is the one path. */
  onboarding?: boolean
  /** Close the current source and return to the welcome guide (shown when not onboarding). */
  onGoHome?: () => void
  notesOpen: boolean
  notesCount: number
  /** Notes are being built automatically right now. */
  notesActive: boolean
  onToggleNotes: () => void
  /** Show the crop control (a ready camera/video source; not screen shares). */
  canCrop: boolean
  cropped: boolean
  onToggleCrop: () => void
}
export function TopBar({
  mediaReady,
  monitoring,
  onToggleMonitoring,
  onboarding = false,
  onGoHome,
  notesOpen,
  notesCount,
  notesActive,
  onToggleNotes,
  canCrop,
  cropped,
  onToggleCrop,
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
        <button
          type="button"
          onClick={onToggleNotes}
          aria-expanded={notesOpen}
          aria-label="Toggle lecture notes"
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-white px-2.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-50 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <FileText className="h-3.5 w-3.5" aria-hidden="true" />
          Notes{notesCount > 0 ? ` (${notesCount})` : ''}
          {notesActive && (
            <span className="h-1.5 w-1.5 rounded-full bg-rose-500" aria-hidden="true" />
          )}
        </button>
      </div>

      {/* Right: Crop + Start/Stop */}
      <div className="flex items-center gap-2">
        {!onboarding && canCrop && (
          <button
            type="button"
            onClick={onToggleCrop}
            title={cropped ? 'Adjust the board crop' : 'Crop to just the board'}
            className={`inline-flex h-8 items-center gap-1.5 rounded-lg border bg-white px-2.5 text-xs font-medium transition hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
              cropped ? 'border-accent text-zinc-900' : 'border-line text-zinc-700'
            }`}
          >
            <Crop className="h-3.5 w-3.5" aria-hidden="true" />
            {cropped ? 'Adjust crop' : 'Crop board'}
          </button>
        )}
        {!onboarding && (
          <button
            type="button"
            disabled={!mediaReady}
            aria-pressed={monitoring}
            title={monitoring ? 'Stop mistake checks and spoken alerts' : 'Start mistake checks'}
            onClick={onToggleMonitoring}
            className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-xs font-semibold leading-none transition duration-150 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
              monitoring
                ? 'border border-line bg-white text-zinc-900 shadow-sm hover:bg-zinc-100'
                : 'bg-accent text-white hover:brightness-105'
            }`}
          >
            {monitoring ? (
              <>
                <Square
                  className="h-3 w-3 shrink-0 fill-rose-500 text-rose-500"
                  aria-hidden="true"
                />
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
      </div>
    </header>
  )
}

import { AlertCircle, Check, RefreshCw, RotateCcw, VolumeX } from 'lucide-react'
import { MonitorApiError, MonitorPhase } from '../hooks/useBoardMonitor'
import { TrackedIssue } from '../lib/issueTracker'
import { AlertMode } from './HeaderBar'
import { IssueCard } from './IssueCard'

export interface FindingsSidebarProps {
  alertMode: AlertMode
  phase: MonitorPhase
  hasAnalyzed: boolean
  isResultStale: boolean
  boardSummary: string
  apiError: MonitorApiError | null
  speechError: string | null
  speechSupported: boolean
  analysisConfigured: boolean
  activeIssues: readonly TrackedIssue[]
  noLongerDetectedIssues: readonly TrackedIssue[]
  dismissedCount: number
  selectedIssueId: string | null
  hoveredIssueId: string | null
  onSelectIssue: (id: string) => void
  onHoverIssue: (id: string | null) => void
  onSpeakIssue: (issue: TrackedIssue) => void
  onMarkFixed: (id: string) => void
  onDismissIssue: (id: string) => void
  onClearNoLongerDetected: (id: string) => void
  onUndoDismissal: () => void
  onResetDismissed: () => void
  onRetryAnalysis: () => void
}

export function FindingsSidebar({
  alertMode,
  phase,
  hasAnalyzed,
  isResultStale,
  boardSummary,
  apiError,
  speechError,
  speechSupported,
  analysisConfigured,
  activeIssues,
  noLongerDetectedIssues,
  dismissedCount,
  selectedIssueId,
  hoveredIssueId,
  onSelectIssue,
  onHoverIssue,
  onSpeakIssue,
  onMarkFixed,
  onDismissIssue,
  onClearNoLongerDetected,
  onUndoDismissal,
  onResetDismissed,
  onRetryAnalysis,
}: FindingsSidebarProps) {
  return (
    <aside
      aria-label="Board findings and status"
      className="flex w-full shrink-0 flex-col gap-3 rounded-xl border border-slate-800 bg-slate-900/60 p-3 lg:w-96 lg:overflow-y-auto"
    >
      {!analysisConfigured && (
        <div
          role="note"
          className="rounded-lg border border-amber-700/60 bg-amber-950/40 p-2.5 text-xs text-amber-200"
        >
          Backend analysis is not configured yet (<code className="font-mono">GEMINI_API_KEY</code>{' '}
          is unset). Previewing, uploading, and board calibration still work; analysis requests will
          return a configuration notice.
        </div>
      )}

      {apiError && (
        <div
          role="alert"
          className="rounded-lg border border-rose-700/70 bg-rose-950/50 p-2.5 text-xs text-rose-200"
        >
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" aria-hidden="true" />
            <div className="flex-1 space-y-1.5">
              <p className="font-medium">{apiError.message}</p>
              {apiError.retryAfterSeconds !== null && (
                <p className="text-[11px] text-rose-300">
                  Rate-limit cooldown: wait ~{apiError.retryAfterSeconds}s before retrying.
                </p>
              )}
              <button
                type="button"
                onClick={onRetryAnalysis}
                className="inline-flex items-center gap-1 rounded border border-rose-500/60 bg-rose-900/60 px-2 py-1 text-[11px] font-semibold text-rose-100 hover:bg-rose-800/70 focus-visible:outline-2 focus-visible:outline-amber-400"
              >
                <RefreshCw className="h-3 w-3" aria-hidden="true" />
                Retry
              </button>
            </div>
          </div>
        </div>
      )}

      {speechError && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-2 text-xs text-slate-300"
        >
          <VolumeX className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
          <span>{speechError}</span>
        </div>
      )}

      {alertMode === 'voice_only' ? (
        <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-4 text-xs text-slate-300 space-y-2">
          <p className="font-semibold text-slate-100">Voice Only mode active</p>
          <p className="text-slate-400">
            Visual error boxes and correction cards are hidden to minimize screen distraction.
            Spoken alerts remain active while controls and monitoring status stay visible.
          </p>
          <p className="text-slate-400">
            Current monitor state: <span className="font-medium text-slate-200">{phase}</span>
            {activeIssues.length > 0 ? ` • ${activeIssues.length} active issue(s)` : ''}
          </p>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Findings ({activeIssues.length})
              {isResultStale && hasAnalyzed ? ' — Stale' : ''}
            </h2>
            {dismissedCount > 0 && (
              <div className="flex items-center gap-2 text-[11px]">
                <button
                  type="button"
                  onClick={onUndoDismissal}
                  className="inline-flex items-center gap-1 text-sky-300 hover:text-sky-100 focus-visible:outline-2 focus-visible:outline-amber-400"
                >
                  <RotateCcw className="h-3 w-3" aria-hidden="true" />
                  Undo Dismiss
                </button>
                <button
                  type="button"
                  onClick={onResetDismissed}
                  className="text-slate-400 hover:text-slate-200 focus-visible:outline-2 focus-visible:outline-amber-400"
                >
                  Reset ({dismissedCount})
                </button>
              </div>
            )}
          </div>

          {noLongerDetectedIssues.length > 0 && (
            <div className="space-y-1.5">
              {noLongerDetectedIssues.map((item) => (
                <div
                  key={`resolved-${item.id}`}
                  className="flex items-center justify-between gap-2 rounded-lg border border-emerald-800/60 bg-emerald-950/35 px-2.5 py-2 text-xs text-emerald-200"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
                    <span>
                      No longer detected:{' '}
                      <strong className="font-mono">{item.detected_text}</strong>
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => onClearNoLongerDetected(item.id)}
                    className="text-[11px] text-emerald-300 underline hover:text-emerald-100"
                  >
                    Hide
                  </button>
                </div>
              ))}
            </div>
          )}

          {activeIssues.length === 0 ? (
            <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4 text-xs text-slate-400">
              {hasAnalyzed ? (
                <p className="text-slate-200 font-medium">
                  No high-confidence issues detected
                  {isResultStale ? ' (previous check is now stale)' : '.'}
                </p>
              ) : (
                <p>
                  Waiting for a stable board frame. Start a source or click{' '}
                  <strong className="text-slate-200">Check Now</strong>.
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-2.5">
              {activeIssues.map((issue) => (
                <IssueCard
                  key={issue.id}
                  issue={issue}
                  isSelected={issue.id === selectedIssueId}
                  isHovered={issue.id === hoveredIssueId}
                  isStale={isResultStale}
                  speechSupported={speechSupported}
                  onSelect={() => onSelectIssue(issue.id)}
                  onHover={(hovered) => onHoverIssue(hovered ? issue.id : null)}
                  onSpeak={() => onSpeakIssue(issue)}
                  onMarkFixed={() => onMarkFixed(issue.id)}
                  onDismiss={() => onDismissIssue(issue.id)}
                />
              ))}
            </div>
          )}

          {boardSummary && (
            <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-2.5 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  Visible Board Summary
                </span>
                {isResultStale && (
                  <span className="text-[10px] text-amber-300">Stale</span>
                )}
              </div>
              <p className="mt-1 text-slate-300 leading-relaxed">{boardSummary}</p>
            </div>
          )}

          <p className="mt-auto text-[11px] leading-relaxed text-slate-500">
            Session scope: Dismiss suppresses matching text at that location for the current board
            session only (identical text erased and rewritten at the same spot cannot be
            distinguished automatically). Confidence values are uncalibrated model scores.
          </p>
        </>
      )}
    </aside>
  )
}

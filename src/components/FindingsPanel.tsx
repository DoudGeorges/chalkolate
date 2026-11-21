import {
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  RotateCcw,
} from 'lucide-react'
import { useEffect } from 'react'
import { TrackedIssue } from '../lib/issueTracker'
import { IssueCard } from './IssueCard'

export interface FindingsPanelProps {
  open: boolean
  monitoring: boolean
  onToggle: () => void
  onClose: () => void
  hasAnalyzed: boolean
  openIssues: readonly TrackedIssue[]
  dismissedCount: number
  selectedIssueId: string | null
  hoveredIssueId: string | null
  speechSupported: boolean
  pulseBadge: boolean
  onSelectIssue: (id: string) => void
  onHoverIssue: (id: string | null) => void
  onSpeakIssue: (issue: TrackedIssue) => void
  onMarkFixed: (id: string) => void
  onDismissIssue: (id: string) => void
  onRestoreDismissed: () => void
}

export function FindingsPanel({
  open,
  monitoring,
  onToggle,
  onClose,
  hasAnalyzed,
  openIssues,
  dismissedCount,
  selectedIssueId,
  hoveredIssueId,
  speechSupported,
  pulseBadge,
  onSelectIssue,
  onHoverIssue,
  onSpeakIssue,
  onMarkFixed,
  onDismissIssue,
  onRestoreDismissed,
}: FindingsPanelProps) {
  useEffect(() => {
    if (!open || !selectedIssueId) return
    const el = document.getElementById(`issue-card-${selectedIssueId}`)
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [open, selectedIssueId])

  useEffect(() => {
    if (!open) return
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose, open])

  const count = openIssues.length

  const emptyState = hasAnalyzed
    ? {
        title: 'Board looks clear',
        detail: 'No math, physics, or spelling mistakes detected.',
        clear: true,
      }
    : monitoring
      ? {
          title: 'Watching the board',
          detail: 'Mistakes and corrections will appear here.',
          clear: false,
        }
      : {
          title: 'Monitoring paused',
          detail: 'Click Start to scan the board for mistakes.',
          clear: false,
        }

  return (
    <div
      data-testid="findings-panel-container"
      className={`relative z-30 shrink-0 transition-[width,height] duration-200 ease-out
        ${
          open
            ? 'h-[42vh] w-full border-t border-line md:h-auto md:w-[360px] md:border-t-0 md:border-l'
            : 'h-0 w-full border-transparent md:h-auto md:w-0'
        }`}
    >
      {/* Subtle edge toggle chevron: right edge on desktop, bottom edge on mobile */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls="findings-sidebar-content"
        aria-label={
          open
            ? 'Collapse findings panel'
            : count > 0
              ? `Expand findings panel (${count} open)`
              : 'Expand findings panel'
        }
        title={open ? 'Collapse findings' : 'Show findings'}
        className="group pointer-events-auto absolute z-30 flex cursor-pointer items-center justify-center border border-line bg-panel/90 text-zinc-400 shadow-lg backdrop-blur-md transition duration-150 hover:bg-zinc-800/95 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70
          -top-7 left-1/2 h-7 min-w-12 -translate-x-1/2 flex-row gap-1 rounded-t-lg border-b-0 px-2.5
          md:top-1/2 md:-left-7 md:h-auto md:min-h-14 md:w-7 md:min-w-0 md:translate-x-0 md:-translate-y-1/2 md:flex-col md:gap-1 md:rounded-t-none md:rounded-l-lg md:border-b md:border-r-0 md:px-0 md:py-2.5"
      >
        {/* Desktop chevron */}
        <span className="hidden md:flex items-center justify-center" aria-hidden="true">
          {open ? (
            <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          ) : (
            <ChevronLeft className="h-4 w-4 transition-transform group-hover:-translate-x-0.5" />
          )}
        </span>

        {/* Mobile chevron */}
        <span className="flex md:hidden items-center justify-center" aria-hidden="true">
          {open ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronUp className="h-4 w-4" />
          )}
        </span>

        {/* Discreet open-issue count when collapsed */}
        {!open && count > 0 && (
          <span
            className={`tabular-nums inline-flex min-w-4 items-center justify-center rounded-full bg-accent px-1 py-0.5 text-[10px] font-bold leading-none text-zinc-950 ${
              pulseBadge ? 'animate-pulse' : ''
            }`}
          >
            {count}
          </span>
        )}
      </button>

      {/* Fixed-width inner surface prevents card reflow jitter during expand/collapse */}
      <aside
        id="findings-sidebar-content"
        aria-label="Findings panel"
        aria-hidden={!open}
        className={`h-full w-full overflow-hidden bg-panel/95 backdrop-blur-xl ${open ? 'pointer-events-auto' : 'pointer-events-none'}`}
      >
        <div className="flex h-full w-full flex-col md:w-[360px]">
          <div className="flex h-11 shrink-0 items-center justify-between border-b border-line px-4">
            <div className="flex items-center gap-2">
              <h2 className="text-xs font-semibold tracking-wide text-zinc-100">
                Findings
              </h2>
              {count > 0 && (
                <span className="tabular-nums rounded-full bg-white/[0.08] px-2 py-0.5 text-[10px] font-medium text-zinc-300">
                  {count}
                </span>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-3.5 space-y-3">
            {count === 0 ? (
              <div className="flex h-full min-h-36 flex-col items-center justify-center px-4 py-8 text-center">
                {emptyState.clear && (
                  <CheckCircle2
                    className="mb-2 h-5 w-5 text-emerald-400/80"
                    aria-hidden="true"
                  />
                )}
                <p className="text-xs font-medium text-zinc-200">{emptyState.title}</p>
                <p className="mt-1 max-w-[230px] text-[11px] leading-relaxed text-zinc-400">
                  {emptyState.detail}
                </p>
              </div>
            ) : (
              openIssues.map((issue) => (
                <IssueCard
                  key={issue.id}
                  issue={issue}
                  isSelected={issue.id === selectedIssueId}
                  isHovered={issue.id === hoveredIssueId}
                  speechSupported={speechSupported}
                  onSelect={() => onSelectIssue(issue.id)}
                  onHover={(hovered) => onHoverIssue(hovered ? issue.id : null)}
                  onSpeak={() => onSpeakIssue(issue)}
                  onMarkFixed={() => onMarkFixed(issue.id)}
                  onDismiss={() => onDismissIssue(issue.id)}
                />
              ))
            )}
          </div>

          {dismissedCount > 0 && (
            <div className="shrink-0 border-t border-line px-4 py-2.5">
              <button
                type="button"
                onClick={onRestoreDismissed}
                className="inline-flex items-center gap-1.5 text-[11px] font-medium text-accent transition hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
              >
                <RotateCcw className="h-3 w-3" aria-hidden="true" />
                <span>Restore dismissed ({dismissedCount})</span>
              </button>
            </div>
          )}
        </div>
      </aside>
    </div>
  )
}

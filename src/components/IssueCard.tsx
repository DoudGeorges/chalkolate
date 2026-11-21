import { Check, EyeOff, Volume2 } from 'lucide-react'
import { CATEGORY_COLORS, CATEGORY_LABELS } from '../lib/categoryColors'
import { TrackedIssue } from '../lib/issueTracker'
import { MathCorrection } from './MathCorrection'

export interface IssueCardProps {
  issue: TrackedIssue
  isSelected: boolean
  isHovered: boolean
  speechSupported: boolean
  onSelect: () => void
  onHover: (hovered: boolean) => void
  onSpeak: () => void
  onMarkFixed: () => void
  onDismiss: () => void
}

export function IssueCard({
  issue,
  isSelected,
  isHovered,
  speechSupported,
  onSelect,
  onHover,
  onSpeak,
  onMarkFixed,
  onDismiss,
}: IssueCardProps) {
  const accent = CATEGORY_COLORS[issue.category]
  const isChecking = issue.pendingVerification

  return (
    <article
      id={`issue-card-${issue.id}`}
      tabIndex={0}
      onClick={onSelect}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onFocus={() => onHover(true)}
      onBlur={() => onHover(false)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          if (e.target === e.currentTarget) {
            e.preventDefault()
            onSelect()
          }
        }
      }}
      className={`rounded-xl border p-4 text-xs transition duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
        isSelected || isHovered
          ? 'border-zinc-300 bg-zinc-100 shadow-lg'
          : 'border-line bg-zinc-50 hover:border-zinc-300'
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: accent }}
          aria-hidden="true"
        />
        <span
          className="text-[11px] font-semibold tracking-wide"
          style={{ color: accent }}
        >
          {CATEGORY_LABELS[issue.category]}
        </span>
      </div>

      <div className="mt-2.5 space-y-2">
        <p className="font-mono text-[12px] leading-snug text-zinc-500 line-through decoration-rose-400/65 break-words">
          {issue.detected_text}
        </p>

        <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-[13.5px] font-medium leading-snug text-zinc-950">
          <MathCorrection
            correctionText={issue.correction_text}
            correctionLatex={issue.correction_latex}
          />
        </div>

        <p className="text-xs leading-relaxed text-zinc-500">{issue.explanation}</p>
      </div>

      <div
        className="mt-3.5 flex items-center gap-1 border-t border-zinc-200 pt-2.5"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onSpeak}
          disabled={!speechSupported}
          title={speechSupported ? 'Speak alert aloud' : 'Speech unavailable'}
          className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-medium text-zinc-700 transition hover:bg-zinc-100 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <Volume2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>Speak</span>
        </button>

        <button
          type="button"
          onClick={onMarkFixed}
          disabled={isChecking}
          className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-medium text-zinc-700 transition hover:bg-zinc-100 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" aria-hidden="true" />
          <span>{isChecking ? 'Checking…' : 'Mark fixed'}</span>
        </button>

        <button
          type="button"
          onClick={onDismiss}
          className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-medium text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <EyeOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>Dismiss</span>
        </button>
      </div>
    </article>
  )
}

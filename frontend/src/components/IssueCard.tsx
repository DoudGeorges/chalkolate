import { CheckCircle2, EyeOff, Volume2 } from 'lucide-react'
import { CATEGORY_COLORS } from '../lib/categoryColors'
import { TrackedIssue } from '../lib/issueTracker'
import { MathCorrection } from './MathCorrection'

export interface IssueCardProps {
  issue: TrackedIssue
  isSelected: boolean
  isHovered: boolean
  isStale: boolean
  speechSupported: boolean
  onSelect: () => void
  onHover: (hovered: boolean) => void
  onSpeak: () => void
  onMarkFixed: () => void
  onDismiss: () => void
}

const CATEGORY_LABEL: Record<TrackedIssue['category'], string> = {
  math: 'Math',
  physics: 'Physics',
  spelling: 'Spelling',
}

export function IssueCard({
  issue,
  isSelected,
  isHovered,
  isStale,
  speechSupported,
  onSelect,
  onHover,
  onSpeak,
  onMarkFixed,
  onDismiss,
}: IssueCardProps) {
  const accent = CATEGORY_COLORS[issue.category]
  const confidencePct = Math.round(issue.confidence * 100)
  const isVerifying = issue.status === 'verifying'

  return (
    <article
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
      style={{
        borderLeftColor: accent,
      }}
      className={`rounded-lg border border-l-4 bg-slate-900/90 p-3 text-xs transition focus-visible:outline-2 focus-visible:outline-amber-400 ${
        isSelected || isHovered
          ? 'border-slate-500 ring-1 ring-white/20'
          : 'border-slate-800 hover:border-slate-700'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-semibold text-slate-950"
            style={{ backgroundColor: accent }}
          >
            {CATEGORY_LABEL[issue.category]}
          </span>
          {isStale && (
            <span className="rounded bg-amber-950/80 px-1.5 py-0.5 text-[10px] font-medium text-amber-200">
              Stale
            </span>
          )}
          {isVerifying && (
            <span className="rounded bg-sky-950/80 px-1.5 py-0.5 text-[10px] font-medium text-sky-200">
              Verification pending
            </span>
          )}
        </div>
        <span className="text-[11px] text-slate-400">
          Model confidence: {confidencePct}%
        </span>
      </div>

      <div className="mt-2 space-y-1.5">
        <div className="rounded border border-slate-800 bg-slate-950/80 px-2 py-1">
          <span className="text-[10px] uppercase tracking-wider text-slate-500">
            Observed
          </span>
          <p className="mt-0.5 font-mono text-rose-200 line-through decoration-rose-400/70 break-words">
            {issue.detected_text}
          </p>
        </div>

        <div className="rounded border border-emerald-900/50 bg-emerald-950/25 px-2 py-1.5">
          <span className="text-[10px] uppercase tracking-wider text-emerald-400/80">
            Suggested Correction
          </span>
          <div className="mt-0.5 text-sm">
            <MathCorrection
              correctionText={issue.correction_text}
              correctionLatex={issue.correction_latex}
            />
          </div>
        </div>

        <p className="text-slate-300 leading-relaxed">{issue.explanation}</p>
      </div>

      <div
        className="mt-2.5 flex flex-wrap items-center gap-1.5"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onSpeak}
          disabled={!speechSupported}
          title={speechSupported ? 'Speak alert aloud' : 'Speech synthesis unavailable in this browser'}
          className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-[11px] font-medium text-slate-200 transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-amber-400"
        >
          <Volume2 className="h-3 w-3" aria-hidden="true" />
          Speak
        </button>

        <button
          type="button"
          onClick={onMarkFixed}
          disabled={isVerifying}
          className="inline-flex items-center gap-1 rounded border border-emerald-700/70 bg-emerald-950/50 px-2 py-1 text-[11px] font-medium text-emerald-200 transition hover:bg-emerald-900/60 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-amber-400"
        >
          <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
          {isVerifying ? 'Verifying...' : 'Mark Fixed'}
        </button>

        <button
          type="button"
          onClick={onDismiss}
          className="ml-auto inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] font-medium text-slate-300 transition hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-amber-400"
        >
          <EyeOff className="h-3 w-3" aria-hidden="true" />
          Dismiss
        </button>
      </div>
    </article>
  )
}

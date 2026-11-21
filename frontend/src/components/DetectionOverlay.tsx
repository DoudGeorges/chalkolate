import { CATEGORY_COLORS } from '../lib/categoryColors'
import { ContainedImageRect, computeOverlayPillPosition } from '../lib/geometry'
import { TrackedIssue } from '../lib/issueTracker'
import { MathCorrection } from './MathCorrection'

export interface DetectionOverlayProps {
  imageRect: ContainedImageRect
  issues: readonly TrackedIssue[]
  selectedIssueId: string | null
  hoveredIssueId: string | null
  onSelectIssue: (issueId: string) => void
  onHoverIssue: (issueId: string | null) => void
}

export function DetectionOverlay({
  imageRect,
  issues,
  selectedIssueId,
  hoveredIssueId,
  onSelectIssue,
  onHoverIssue,
}: DetectionOverlayProps) {
  if (imageRect.width <= 0 || imageRect.height <= 0 || issues.length === 0) {
    return null
  }

  return (
    <div
      className="pointer-events-none absolute inset-0"
      aria-label="Detected board error overlays"
    >
      {/* Vector boxes aligned identically to the contained image rectangle */}
      <svg
        viewBox="0 0 1000 1000"
        preserveAspectRatio="none"
        style={{
          left: `${imageRect.left}px`,
          top: `${imageRect.top}px`,
          width: `${imageRect.width}px`,
          height: `${imageRect.height}px`,
        }}
        className="pointer-events-none absolute"
      >
        {issues.map((issue) => {
          const [ymin, xmin, ymax, xmax] = issue.box_2d
          const color = CATEGORY_COLORS[issue.category]
          const isHighlighted =
            issue.id === selectedIssueId || issue.id === hoveredIssueId

          return (
            <rect
              key={issue.id}
              x={xmin}
              y={ymin}
              width={xmax - xmin}
              height={ymax - ymin}
              fill={color}
              fillOpacity={isHighlighted ? 0.18 : 0.08}
              stroke={color}
              strokeWidth={isHighlighted ? 3 : 2}
              vectorEffect="non-scaling-stroke"
              rx={4}
              className="pointer-events-auto cursor-pointer transition-opacity"
              tabIndex={0}
              role="button"
              aria-pressed={issue.id === selectedIssueId}
              aria-label={`${issue.category} finding: ${issue.detected_text}. Correction: ${issue.correction_text}`}
              onClick={() => onSelectIssue(issue.id)}
              onMouseEnter={() => onHoverIssue(issue.id)}
              onMouseLeave={() => onHoverIssue(null)}
              onFocus={() => onHoverIssue(issue.id)}
              onBlur={() => onHoverIssue(null)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onSelectIssue(issue.id)
                }
              }}
            />
          )
        })}
      </svg>

      {/* Separate HTML layer so non-uniform SVG scaling never warps pill text */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {issues.map((issue) => {
          const pos = computeOverlayPillPosition(issue.box_2d, imageRect)
          const color = CATEGORY_COLORS[issue.category]
          const isHighlighted =
            issue.id === selectedIssueId || issue.id === hoveredIssueId

          return (
            <button
              key={`pill-${issue.id}`}
              type="button"
              onClick={() => onSelectIssue(issue.id)}
              onMouseEnter={() => onHoverIssue(issue.id)}
              onMouseLeave={() => onHoverIssue(null)}
              style={{
                left: `${pos.left}px`,
                top: `${pos.top}px`,
                borderColor: color,
                maxWidth: `${Math.max(120, Math.min(280, imageRect.width - 8))}px`,
              }}
              className={`pointer-events-auto absolute flex items-center gap-1.5 rounded-md border bg-slate-950/92 px-2 py-1 text-left text-xs shadow-lg transition focus-visible:outline-2 focus-visible:outline-amber-400 ${
                isHighlighted ? 'z-20 ring-2 ring-white/40' : 'z-10'
              }`}
            >
              <span
                className="inline-block h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: color }}
                aria-hidden="true"
              />
              <span className="truncate font-medium text-slate-200">
                <MathCorrection
                  correctionText={issue.correction_text}
                  correctionLatex={issue.correction_latex}
                />
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

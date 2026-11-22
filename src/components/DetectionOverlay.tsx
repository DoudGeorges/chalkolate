import { CATEGORY_COLORS } from '../lib/categoryColors'
import { ContainedImageRect, computeOverlayPillPosition } from '../lib/geometry'
import { TrackedIssue } from '../lib/issueTracker'
import { MathCorrection } from './MathCorrection'

export interface DetectionOverlayProps {
  imageRect: ContainedImageRect
  /** Visible part of the stage; pills are kept inside it. Defaults to `imageRect`. */
  visibleRect?: ContainedImageRect
  issues: readonly TrackedIssue[]
  locationsUnverified?: boolean
  selectedIssueId: string | null
  hoveredIssueId: string | null
  onSelectIssue: (issueId: string) => void
  onHoverIssue: (issueId: string | null) => void
}

export function DetectionOverlay({
  imageRect,
  visibleRect = imageRect,
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
              fillOpacity={isHighlighted ? 0.18 : 0.1}
              stroke={color}
              strokeOpacity={1}
              strokeWidth={isHighlighted ? 3 : 2}
              vectorEffect="non-scaling-stroke"
              rx={4}
              className="pointer-events-auto cursor-pointer transition-opacity duration-150"
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
          const pos = computeOverlayPillPosition(issue.box_2d, imageRect, 220, 30, visibleRect)
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
                maxWidth: `${Math.max(120, Math.min(280, visibleRect.width - 8))}px`,
              }}
              className={`pointer-events-auto absolute flex items-center gap-1.5 rounded-lg border bg-white px-2.5 py-1 text-left text-xs shadow-md transition duration-150 animate-pill-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
                isHighlighted
                  ? 'z-20 border-zinc-300 ring-1 ring-zinc-300'
                  : 'z-10 border-line hover:border-zinc-300'
              }`}
            >
              <span
                className="inline-block h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: color }}
                aria-hidden="true"
              />
              <span className="truncate font-medium text-zinc-900">
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

import { CATEGORY_COLORS, CATEGORY_LABELS } from '../lib/categoryColors'
import { ContainedImageRect, FindingBoxProjector, computeOverlayPillPosition } from '../lib/geometry'
import { TrackedIssue } from '../lib/issueTracker'
import { MathCorrection } from './MathCorrection'

export interface DetectionOverlayProps {
  projectBox: FindingBoxProjector
  /** Visible media area in stage pixels; overlays are clipped to it and pills kept inside it. */
  clipRect: ContainedImageRect
  issues: readonly TrackedIssue[]
  selectedIssueId: string | null
  hoveredIssueId: string | null
  onSelectIssue: (issueId: string) => void
  onHoverIssue: (issueId: string | null) => void
}

export function DetectionOverlay({
  projectBox,
  clipRect,
  issues,
  selectedIssueId,
  hoveredIssueId,
  onSelectIssue,
  onHoverIssue,
}: DetectionOverlayProps) {
  if (clipRect.width <= 0 || clipRect.height <= 0 || issues.length === 0) {
    return null
  }

  const left = clipRect.left
  const top = clipRect.top
  const right = clipRect.left + clipRect.width
  const bottom = clipRect.top + clipRect.height
  const clipPath = `polygon(${left}px ${top}px, ${right}px ${top}px, ${right}px ${bottom}px, ${left}px ${bottom}px)`

  // Hidden findings stay out of the tab order as well as the visible overlay.
  const projected = issues.flatMap((issue) => {
    const polygon = projectBox(issue.box_2d)
    if (polygon.length < 3 || polygon.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) {
      return []
    }
    const ys = polygon.map(([, y]) => y)
    return [
      {
        issue,
        label: `${CATEGORY_LABELS[issue.category]} correction. On the board: ${issue.detected_text}. Correction: ${issue.correction_text}`,
        points: polygon.map(([x, y]) => `${x},${y}`).join(' '),
        boxPx: {
          left: Math.min(...polygon.map(([x]) => x)),
          top: Math.min(...ys),
          bottom: Math.max(...ys),
        },
      },
    ]
  })
  const pillWidth = Math.min(280, clipRect.width - 8)
  const showPills = pillWidth >= 32 && clipRect.height >= 38

  return (
    <div
      className="pointer-events-none absolute inset-0"
      style={{ clipPath }}
      role="group"
      aria-label="Board corrections"
    >
      {/* Stage-pixel SVG so perspective-projected boxes line up with the displayed media */}
      <svg
        aria-hidden={showPills ? true : undefined}
        className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
      >
        {projected.map(({ issue, points, label }) => {
          const color = CATEGORY_COLORS[issue.category]
          const isHighlighted =
            issue.id === selectedIssueId || issue.id === hoveredIssueId

          return (
            <polygon
              key={issue.id}
              id={showPills ? undefined : 'finding-' + issue.id}
              points={points}
              fill={color}
              fillOpacity={isHighlighted ? 0.18 : 0.1}
              stroke={color}
              strokeOpacity={1}
              strokeWidth={isHighlighted ? 3 : 2}
              strokeLinejoin="round"
              style={{ transition: 'fill-opacity 150ms, stroke-width 150ms' }}
              className="pointer-events-auto cursor-pointer transition-opacity duration-150"
              tabIndex={showPills ? undefined : 0}
              role="button"
              aria-pressed={issue.id === selectedIssueId}
              aria-label={label}
              aria-controls={issue.id === selectedIssueId ? 'finding-explanation' : undefined}
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

      {/* Separate HTML layer so pill text is never warped */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {showPills && projected.map(({ issue, boxPx, label }) => {
          const pos = computeOverlayPillPosition(boxPx, clipRect, pillWidth)
          const color = CATEGORY_COLORS[issue.category]
          const isHighlighted =
            issue.id === selectedIssueId || issue.id === hoveredIssueId

          return (
            <button
              key={`pill-${issue.id}`}
              id={'finding-' + issue.id}
              type="button"
              aria-label={label}
              aria-controls={issue.id === selectedIssueId ? 'finding-explanation' : undefined}
              aria-pressed={issue.id === selectedIssueId}
              onClick={() => onSelectIssue(issue.id)}
              onMouseEnter={() => onHoverIssue(issue.id)}
              onMouseLeave={() => onHoverIssue(null)}
              onFocus={() => onHoverIssue(issue.id)}
              onBlur={() => onHoverIssue(null)}
              style={{
                left: `${pos.left}px`,
                top: `${pos.top}px`,
                maxWidth: `${pillWidth}px`,
              }}
              className={`pointer-events-auto absolute flex min-h-6 items-center gap-1.5 rounded-full border bg-panel px-2.5 py-1 text-left text-xs animate-pill-in transition-[border-color,box-shadow] duration-150 ${
                isHighlighted
                  ? 'z-20 border-accent shadow-pop'
                  : 'z-10 border-line shadow-soft hover:border-control-line'
              }`}
            >
              <span
                className="inline-block h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: color }}
                aria-hidden="true"
              />
              <span className="truncate font-medium text-ink">
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

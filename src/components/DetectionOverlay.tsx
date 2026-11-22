import { CATEGORY_COLORS } from '../lib/categoryColors'
import { ContainedImageRect, FindingBoxProjector, computeOverlayPillPosition } from '../lib/geometry'
import { TrackedIssue } from '../lib/issueTracker'
import { MathCorrection } from './MathCorrection'

export interface DetectionOverlayProps {
  projectBox: FindingBoxProjector
  /** Visible media area in stage pixels; overlays are clipped to it and pills kept inside it. */
  clipRect: ContainedImageRect
  issues: readonly TrackedIssue[]
  locationsUnverified?: boolean
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
      aria-label="Detected board error overlays"
    >
      {/* Stage-pixel SVG so perspective-projected boxes line up with the displayed media */}
      <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
        {projected.map(({ issue, points }) => {
          const color = CATEGORY_COLORS[issue.category]
          const isHighlighted =
            issue.id === selectedIssueId || issue.id === hoveredIssueId

          return (
            <polygon
              key={issue.id}
              points={points}
              fill={color}
              fillOpacity={isHighlighted ? 0.18 : 0.1}
              stroke={color}
              strokeOpacity={1}
              strokeWidth={isHighlighted ? 3 : 2}
              strokeLinejoin="round"
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

      {/* Separate HTML layer so pill text is never warped */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {showPills && projected.map(({ issue, boxPx }) => {
          const pos = computeOverlayPillPosition(boxPx, clipRect, pillWidth)
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
                maxWidth: `${pillWidth}px`,
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

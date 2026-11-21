import { AlertTriangle, Camera, Crop } from 'lucide-react'
import { useEffect, useState } from 'react'
import { CalibrationCorners } from '../api/schemas'
import { MediaSourceState } from '../hooks/useMediaSource'
import { ContainedImageRect, computeContainedImageRect } from '../lib/geometry'
import { TrackedIssue } from '../lib/issueTracker'
import { CalibrationOverlay } from './CalibrationOverlay'
import { DetectionOverlay } from './DetectionOverlay'

export interface StageViewportProps {
  mediaState: MediaSourceState
  videoElRef: React.RefObject<HTMLVideoElement | null>
  imageElRef: React.RefObject<HTMLImageElement | null>
  showOverlays: boolean
  activeIssues: readonly TrackedIssue[]
  selectedIssueId: string | null
  hoveredIssueId: string | null
  onSelectIssue: (issueId: string) => void
  onHoverIssue: (issueId: string | null) => void
  calibrationEditing: boolean
  draftCorners: CalibrationCorners
  committedCorners: CalibrationCorners | null
  onChangeDraftCorners: (next: CalibrationCorners) => void
  onApplyCalibration: () => void
  onResetCrop: () => void
  onCancelCalibration: () => void
}

export function StageViewport({
  mediaState,
  videoElRef,
  imageElRef,
  showOverlays,
  activeIssues,
  selectedIssueId,
  hoveredIssueId,
  onSelectIssue,
  onHoverIssue,
  calibrationEditing,
  draftCorners,
  committedCorners,
  onChangeDraftCorners,
  onApplyCalibration,
  onResetCrop,
  onCancelCalibration,
}: StageViewportProps) {
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null)
  const [containerSize, setContainerSize] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  })

  useEffect(() => {
    if (!containerEl) return

    const updateSize = () => {
      const rect = containerEl.getBoundingClientRect()
      setContainerSize((prev) =>
        prev.width === rect.width && prev.height === rect.height
          ? prev
          : { width: rect.width, height: rect.height },
      )
    }

    updateSize()

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => updateSize())
      observer.observe(containerEl)
      return () => observer.disconnect()
    }

    window.addEventListener('resize', updateSize)
    return () => window.removeEventListener('resize', updateSize)
  }, [containerEl])

  const imageRect: ContainedImageRect = computeContainedImageRect(
    containerSize.width,
    containerSize.height,
    mediaState.intrinsicWidth,
    mediaState.intrinsicHeight,
  )

  const isVideoLike =
    mediaState.kind === 'camera' ||
    mediaState.kind === 'screen' ||
    mediaState.kind === 'video'

  return (
    <div className="flex flex-1 flex-col gap-2 min-h-0">
      <div
        ref={setContainerEl}
        data-testid="board-stage"
        className="relative flex-1 min-h-[340px] w-full overflow-hidden rounded-xl border border-slate-800 bg-slate-950 shadow-inner"
      >
        {mediaState.kind === 'none' && (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full border border-slate-800 bg-slate-900 text-slate-400">
              <Camera className="h-6 w-6" aria-hidden="true" />
            </div>
            <div className="max-w-md space-y-1">
              <h2 className="text-sm font-semibold text-slate-200">
                No lecture board source active
              </h2>
              <p className="text-xs text-slate-400">
                Start Live Camera, Share Screen (including a mirrored iPad AirPlay or capture
                window), Upload Media, or try Load Sample Mistake. Analyzed snapshots are sent to
                the backend Gemini service.
              </p>
            </div>
          </div>
        )}

        {/* Unmirrored video element for camera, screen share, and uploaded videos */}
        <video
          ref={videoElRef}
          muted
          playsInline
          controls={mediaState.kind === 'video'}
          className={`h-full w-full object-contain ${isVideoLike ? 'block' : 'hidden'}`}
        />

        {/* Uploaded image or synthetic sample board */}
        {mediaState.kind === 'image' && mediaState.objectUrl && (
          <img
            ref={imageElRef}
            src={mediaState.objectUrl}
            alt="Active lecture board snapshot"
            className="h-full w-full object-contain select-none"
          />
        )}

        {/* Active committed calibration outline (passive visual cue when not editing) */}
        {!calibrationEditing && committedCorners && imageRect.width > 0 && (
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
            <polygon
              points={committedCorners.map(([x, y]) => `${x},${y}`).join(' ')}
              fill="none"
              stroke="rgba(56, 189, 248, 0.45)"
              strokeDasharray="6 6"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        )}

        {showOverlays && !calibrationEditing && (
          <DetectionOverlay
            imageRect={imageRect}
            issues={activeIssues}
            selectedIssueId={selectedIssueId}
            hoveredIssueId={hoveredIssueId}
            onSelectIssue={onSelectIssue}
            onHoverIssue={onHoverIssue}
          />
        )}

        {calibrationEditing && mediaState.ready && (
          <CalibrationOverlay
            imageRect={imageRect}
            draftCorners={draftCorners}
            onChangeDraft={onChangeDraftCorners}
            onApply={onApplyCalibration}
            onResetCrop={onResetCrop}
            onCancel={onCancelCalibration}
          />
        )}
      </div>

      {mediaState.error && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-rose-700/70 bg-rose-950/60 px-3 py-2 text-xs text-rose-200"
        >
          <AlertTriangle className="h-4 w-4 shrink-0 text-rose-400" aria-hidden="true" />
          <span>{mediaState.error}</span>
        </div>
      )}

      {committedCorners && !calibrationEditing && (
        <div className="flex items-center justify-between rounded-lg border border-sky-900/60 bg-sky-950/30 px-3 py-1.5 text-xs text-sky-200">
          <span className="inline-flex items-center gap-1.5">
            <Crop className="h-3.5 w-3.5 text-sky-400" aria-hidden="true" />
            Board crop active — camera assumed fixed. Recalibrate if the camera or window moves.
          </span>
          <button
            type="button"
            onClick={onResetCrop}
            className="text-sky-300 underline hover:text-sky-100 focus-visible:outline-2 focus-visible:outline-amber-400"
          >
            Reset Crop
          </button>
        </div>
      )}
    </div>
  )
}

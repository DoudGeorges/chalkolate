import { ArrowRight, Crop, LoaderCircle, Play, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { CalibrationCorners } from '../api/schemas'
import { MonitorPhase } from '../hooks/useBoardMonitor'
import { MediaSourceState } from '../hooks/useMediaSource'
import { CATEGORY_LABELS } from '../lib/categoryColors'
import {
  ContainedImageRect,
  computeContainedImageRect,
  computeRectifiedCropView,
  homographyToCssMatrix3d,
  projectBoxThroughRect,
} from '../lib/geometry'
import { TrackedIssue } from '../lib/issueTracker'
import { CalibrationDetectStatus, CalibrationOverlay, CalibrationToolbar } from './CalibrationOverlay'
import { DetectionOverlay } from './DetectionOverlay'
import { MathCorrection } from './MathCorrection'
import { VideoTransport } from './VideoTransport'

export interface StageProps {
  mediaState: MediaSourceState
  videoElRef: React.RefObject<HTMLVideoElement | null>
  onToggleVideoPlayback: () => void
  onPlayPreview: () => void
  canMonitor: boolean
  monitoring: boolean
  starting: boolean
  phase: MonitorPhase
  showOverlays: boolean
  openIssues: readonly TrackedIssue[]
  selectedIssueId: string | null
  hoveredIssueId: string | null
  onSelectIssue: (issueId: string | null) => void
  onHoverIssue: (issueId: string | null) => void
  calibrationEditing: boolean
  calibrationDetectStatus: CalibrationDetectStatus
  canCrop: boolean
  cropped: boolean
  onToggleCrop: () => void
  draftCorners: CalibrationCorners
  committedCorners: CalibrationCorners | null
  onChangeDraftCorners: (next: CalibrationCorners) => void
  onAutoDetectCalibration: () => void
  onApplyCalibration: () => void
  onResetCrop: () => void
  onCancelCalibration: () => void
  welcome: React.ReactNode
}

export function Stage({
  mediaState,
  videoElRef,
  onToggleVideoPlayback,
  onPlayPreview,
  canMonitor,
  monitoring,
  starting,
  phase,
  showOverlays,
  openIssues,
  selectedIssueId,
  hoveredIssueId,
  onSelectIssue,
  onHoverIssue,
  calibrationEditing,
  calibrationDetectStatus,
  canCrop,
  cropped,
  onToggleCrop,
  draftCorners,
  committedCorners,
  onChangeDraftCorners,
  onAutoDetectCalibration,
  onApplyCalibration,
  onResetCrop,
  onCancelCalibration,
  welcome,
}: StageProps) {
  const [containerEl, setContainerEl] = useState<HTMLElement | null>(null)
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })

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
      const observer = new ResizeObserver(updateSize)
      observer.observe(containerEl)
      return () => observer.disconnect()
    }
    window.addEventListener('resize', updateSize)
    return () => window.removeEventListener('resize', updateSize)
  }, [containerEl])

  // Full uncropped frame (used while editing the crop and when no crop is committed).
  const imageRect: ContainedImageRect = computeContainedImageRect(
    containerSize.width,
    containerSize.height,
    mediaState.intrinsicWidth,
    mediaState.intrinsicHeight,
  )

  // A committed crop (auto-detected or manual) shows ONLY the board, perspective-straightened
  // and as large as the stage allows. The full frame comes back while editing the crop.
  const cropView = useMemo(
    () =>
      calibrationEditing
        ? null
        : computeRectifiedCropView(
            containerSize.width,
            containerSize.height,
            mediaState.intrinsicWidth,
            mediaState.intrinsicHeight,
            committedCorners,
          ),
    [
      calibrationEditing,
      containerSize,
      mediaState.intrinsicWidth,
      mediaState.intrinsicHeight,
      committedCorners,
    ],
  )

  // The wrapper is always rendered (so the <video> never remounts and loses its stream); in crop
  // mode it becomes the board rectangle and clips everything outside the board.
  const mediaWrapperStyle: React.CSSProperties | undefined = cropView
    ? {
        left: `${cropView.rect.left}px`,
        top: `${cropView.rect.top}px`,
        width: `${cropView.rect.width}px`,
        height: `${cropView.rect.height}px`,
      }
    : undefined
  // Media drawn at intrinsic pixel size, then warped so the board corners hit the wrapper corners.
  const mediaStyle: React.CSSProperties | undefined = cropView
    ? {
        position: 'absolute',
        left: 0,
        top: 0,
        width: `${mediaState.intrinsicWidth}px`,
        height: `${mediaState.intrinsicHeight}px`,
        maxWidth: 'none',
        maxHeight: 'none',
        objectFit: 'fill',
        transformOrigin: '0 0',
        transform: homographyToCssMatrix3d(cropView.elementToRect),
      }
    : undefined
  const overlayProject = cropView?.projectBox ?? projectBoxThroughRect(imageRect)
  const overlayClipRect = cropView ? cropView.rect : imageRect

  const selectedIssue = showOverlays && !calibrationEditing
    ? openIssues.find((issue) => issue.id === selectedIssueId)
    : undefined
  const closeExplanation = () => {
    if (selectedIssue) document.getElementById('finding-' + selectedIssue.id)?.focus({ preventScroll: true })
    onSelectIssue(null)
  }

  const handleStageKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (calibrationEditing && event.key === 'Escape') {
      onCancelCalibration()
      return
    }
    if (selectedIssue && event.key === 'Escape') {
      closeExplanation()
      return
    }
    if (
      mediaState.kind === 'video' &&
      mediaState.ready &&
      event.code === 'Space' &&
      event.target === event.currentTarget
    ) {
      event.preventDefault()
      onToggleVideoPlayback()
    }
  }

  return (
    <main
      tabIndex={mediaState.kind === 'video' ? 0 : undefined}
      onKeyDown={handleStageKeyDown}
      aria-label={calibrationEditing ? 'Board crop editor' : 'Board studio'}
      className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden focus-visible:outline-offset-[-3px] group-data-[panel-open=true]:min-h-56 lg:group-data-[panel-open=true]:min-h-0 ${
        mediaState.kind === 'none' ? 'bg-surface' : 'rounded-xl bg-stage ring-1 ring-line'
      }`}
    >
      <div ref={setContainerEl} className="relative min-h-0 flex-1 overflow-hidden">
        {mediaState.kind === 'none' && welcome}

        {mediaState.kind !== 'none' && mediaState.previewNeedsGesture && !starting && !calibrationEditing ? (
          <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center">
            <button type="button" onClick={onPlayPreview} className="ui-button pointer-events-auto" data-variant="primary">
              <Play aria-hidden="true" /> Play preview
            </button>
          </div>
        ) : mediaState.kind !== 'none' && !mediaState.ready && (
          <div role="status" className="pointer-events-none absolute inset-0 z-20 grid place-items-center px-4">
            <p className="inline-flex items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2 text-center text-sm text-muted shadow-soft animate-fade-in">
              <LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden="true" />
              Loading preview…
            </p>
          </div>
        )}

        <div
          style={mediaWrapperStyle}
          className={`pointer-events-none absolute inset-0 overflow-hidden ${
            mediaState.kind === 'none' ? 'hidden' : ''
          }`}
        >
          {/* Unmirrored video element for camera, screen share, and uploaded lecture videos */}
          <video
            ref={videoElRef}
            muted
            preload="auto"
            playsInline
            style={mediaStyle}
            className="block h-full w-full object-contain"
          />
        </div>

        {/* Fallback outline if a committed crop could not be straightened */}
        {!calibrationEditing && committedCorners && !cropView && imageRect.width > 0 && (
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
              stroke="var(--color-accent)"
              strokeOpacity={0.7}
              strokeDasharray="6 6"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        )}

        {showOverlays && !calibrationEditing && (
          <DetectionOverlay
            projectBox={overlayProject}
            clipRect={overlayClipRect}
            issues={openIssues}
            selectedIssueId={selectedIssueId}
            hoveredIssueId={hoveredIssueId}
            onSelectIssue={(issueId) => onSelectIssue(issueId === selectedIssueId ? null : issueId)}
            onHoverIssue={onHoverIssue}
          />
        )}

        {selectedIssue && (
          <div id="finding-explanation" className="absolute inset-x-3 top-3 z-20 max-h-[calc(100%-1.5rem)] max-w-sm overflow-auto rounded-xl border border-line bg-panel p-3 shadow-pop animate-rise-in sm:inset-x-auto sm:top-4 sm:left-4">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-muted">
                {CATEGORY_LABELS[selectedIssue.category]} correction
              </span>
              <button
                type="button"
                aria-label="Close explanation"
                className="ui-icon ml-auto size-8"
                onClick={closeExplanation}
              >
                <X aria-hidden="true" />
              </button>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-sm text-faint line-through decoration-danger/60 wrap-break-word">
                <span className="sr-only">On the board: </span>
                {selectedIssue.detected_text}
              </span>
              <ArrowRight className="size-3.5 shrink-0 text-faint" aria-hidden="true" />
              <span className="sr-only">Correction: </span>
              <MathCorrection
                correctionText={selectedIssue.correction_text}
                correctionLatex={selectedIssue.correction_latex}
                className="text-sm"
              />
            </div>
            <p role="status" className="ui-copy mt-2 wrap-anywhere">
              {selectedIssue.explanation}
            </p>
          </div>
        )}

        {calibrationEditing && mediaState.ready && (
          <CalibrationOverlay
            imageRect={imageRect}
            draftCorners={draftCorners}
            detectStatus={calibrationDetectStatus}
            onChangeDraft={onChangeDraftCorners}
          />
        )}

        {monitoring && (!canMonitor || phase === 'ANALYZING') && !calibrationEditing && (
          <div
            role="status"
            aria-live="polite"
            className="pointer-events-none absolute bottom-3 left-3 z-20 inline-flex items-center gap-2 rounded-full border border-line bg-panel px-3 py-1.5 text-xs font-medium text-ink shadow-soft animate-fade-in sm:bottom-4 sm:left-4"
          >
            {canMonitor && <span className="ui-spinner-dot" aria-hidden="true" />}
            <span>{canMonitor ? 'Checking board…' : 'Waiting for board checks…'}</span>
          </div>
        )}

        {!calibrationEditing && canCrop && (
          <button
            type="button"
            id="crop-toggle"
            onClick={onToggleCrop}
            title={cropped ? 'Adjust crop' : 'Crop board'}
            aria-label={cropped ? 'Adjust crop' : 'Crop board'}
            aria-expanded={false}
            className="ui-button ui-compact absolute right-3 bottom-3 z-20 shadow-soft"
            data-selected={cropped}
          >
            <Crop aria-hidden="true" />
            <span>Crop</span>
          </button>
        )}

      </div>
      {mediaState.kind === 'video' && mediaState.ready && !calibrationEditing && (
        <div className="flex shrink-0 justify-center border-t border-line bg-panel p-3">
          <VideoTransport videoElRef={videoElRef} onTogglePlayback={onToggleVideoPlayback} />
        </div>
      )}
      {calibrationEditing && mediaState.ready && (
        <CalibrationToolbar
          draftCorners={draftCorners}
          detectStatus={calibrationDetectStatus}
          onAutoDetect={onAutoDetectCalibration}
          onApply={onApplyCalibration}
          onResetCrop={onResetCrop}
          onCancel={onCancelCalibration}
        />
      )}
    </main>
  )
}

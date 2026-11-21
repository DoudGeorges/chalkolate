import { Camera, Crop, MonitorUp, Play, Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { CalibrationCorners } from '../api/schemas'
import { MonitorPhase } from '../hooks/useBoardMonitor'
import { MediaSourceState } from '../hooks/useMediaSource'
import { ContainedImageRect, computeContainedImageRect } from '../lib/geometry'
import { TrackedIssue } from '../lib/issueTracker'
import { CalibrationDetectStatus, CalibrationOverlay } from './CalibrationOverlay'
import { DetectionOverlay } from './DetectionOverlay'
import { VideoTransport } from './VideoTransport'

export interface StageProps {
  mediaState: MediaSourceState
  videoElRef: React.RefObject<HTMLVideoElement | null>
  imageElRef: React.RefObject<HTMLImageElement | null>
  onStartCamera: () => void
  onStartScreenShare: () => void
  onUploadFile: (file: File) => void
  monitoring: boolean
  phase: MonitorPhase
  showOverlays: boolean
  openIssues: readonly TrackedIssue[]
  locationsUnverified: boolean
  selectedIssueId: string | null
  hoveredIssueId: string | null
  onSelectIssue: (issueId: string) => void
  onHoverIssue: (issueId: string | null) => void
  calibrationEditing: boolean
  calibrationDetectStatus: CalibrationDetectStatus
  draftCorners: CalibrationCorners
  committedCorners: CalibrationCorners | null
  onChangeDraftCorners: (next: CalibrationCorners) => void
  onToggleCalibration: () => void
  onAutoDetectCalibration: () => void
  onApplyCalibration: () => void
  onResetCrop: () => void
  onCancelCalibration: () => void
  onUserVideoSeekOrRestart: () => void
  /** Guided start shown when no source is chosen; falls back to plain source buttons. */
  welcome?: React.ReactNode
  /** Show a "press Start" hint once a source is ready but monitoring has not begun. */
  startHint?: boolean
}

export function Stage({
  mediaState,
  videoElRef,
  imageElRef,
  onStartCamera,
  onStartScreenShare,
  onUploadFile,
  monitoring,
  phase,
  showOverlays,
  openIssues,
  locationsUnverified,
  selectedIssueId,
  hoveredIssueId,
  onSelectIssue,
  onHoverIssue,
  calibrationEditing,
  calibrationDetectStatus,
  draftCorners,
  committedCorners,
  onChangeDraftCorners,
  onToggleCalibration,
  onAutoDetectCalibration,
  onApplyCalibration,
  onResetCrop,
  onCancelCalibration,
  onUserVideoSeekOrRestart,
  welcome,
  startHint = false,
}: StageProps) {
  const emptyFileRef = useRef<HTMLInputElement | null>(null)
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

  const handleStageKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (
      mediaState.kind === 'video' &&
      mediaState.ready &&
      event.code === 'Space' &&
      event.target === event.currentTarget
    ) {
      event.preventDefault()
      const video = videoElRef.current
      if (!video) return
      if (video.paused || video.ended) {
        void video.play().catch(() => {})
      } else {
        video.pause()
      }
    }
  }

  return (
    <main
      ref={setContainerEl}
      tabIndex={mediaState.kind === 'video' ? 0 : undefined}
      onKeyDown={handleStageKeyDown}
      data-testid="board-stage"
      className="relative flex-1 min-w-0 min-h-0 overflow-hidden bg-zinc-100 focus:outline-none"
    >
      {mediaState.kind === 'none' && welcome}

      {mediaState.kind === 'none' && !welcome && (
        <div className="flex h-full flex-col items-center justify-center gap-5 px-6 text-center">
          <p className="max-w-sm text-sm text-zinc-500">
            Choose a camera, share a screen, or upload a lecture video
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={onStartCamera}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-zinc-100 px-3 py-2 text-xs font-medium text-zinc-800 transition hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              <Camera className="h-3.5 w-3.5 text-zinc-500" aria-hidden="true" />
              Camera
            </button>
            <button
              type="button"
              onClick={onStartScreenShare}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-zinc-100 px-3 py-2 text-xs font-medium text-zinc-800 transition hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              <MonitorUp className="h-3.5 w-3.5 text-zinc-500" aria-hidden="true" />
              Screen
            </button>
            <input
              ref={emptyFileRef}
              type="file"
              accept="video/*,image/*"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) onUploadFile(file)
                e.target.value = ''
              }}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => emptyFileRef.current?.click()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-zinc-100 px-3 py-2 text-xs font-medium text-zinc-800 transition hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              <Upload className="h-3.5 w-3.5 text-zinc-500" aria-hidden="true" />
              Upload
            </button>
          </div>
        </div>
      )}

      {startHint && mediaState.kind !== 'none' && mediaState.ready && !monitoring && !calibrationEditing && (
        <div
          role="status"
          className="pointer-events-none absolute top-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border border-line bg-white px-3.5 py-1.5 text-xs text-zinc-700 shadow-md animate-pill-in"
        >
          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-accent text-white" aria-hidden="true">
            <Play className="h-2 w-2 translate-x-px fill-current" />
          </span>
          <span>
            Ready. Press <span className="font-semibold text-accent">Start</span> (top right) to
            begin checking for mistakes.
          </span>
        </div>
      )}

      {/* Unmirrored video element for camera, screen share, and uploaded lecture videos */}
      <video
        ref={videoElRef}
        muted
        playsInline
        className={`h-full w-full object-contain ${isVideoLike ? 'block' : 'hidden'}`}
      />

      {mediaState.kind === 'image' && mediaState.objectUrl && (
        <img
          ref={imageElRef}
          src={mediaState.objectUrl}
          alt="Active lecture board"
          className="h-full w-full object-contain select-none"
        />
      )}

      {/* Subtle committed crop outline when not editing */}
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
            stroke="rgba(24, 24, 27, 0.45)"
            strokeDasharray="6 6"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}

      {showOverlays && !calibrationEditing && (
        <DetectionOverlay
          imageRect={imageRect}
          issues={openIssues}
          locationsUnverified={locationsUnverified}
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
          detectStatus={calibrationDetectStatus}
          onChangeDraft={onChangeDraftCorners}
          onAutoDetect={onAutoDetectCalibration}
          onApply={onApplyCalibration}
          onResetCrop={onResetCrop}
          onCancel={onCancelCalibration}
        />
      )}

      {/* Subtle plain processing indicator shown ONLY while actively analyzing */}
      {phase === 'ANALYZING' && !calibrationEditing && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none absolute bottom-4 left-4 z-20 inline-flex items-center gap-1.5 rounded-full border border-line bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 shadow-sm"
        >
          <span
            className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse"
            aria-hidden="true"
          />
          <span>Analyzing…</span>
        </div>
      )}

      {/* Bottom-center video playback bar (uploaded videos only) */}
      {mediaState.kind === 'video' && !calibrationEditing && (
        <div
          className={`absolute left-1/2 z-20 -translate-x-1/2 ${
            showOverlays ? 'bottom-9 md:bottom-4' : 'bottom-4'
          }`}
        >
          <VideoTransport
            videoElRef={videoElRef}
            ready={mediaState.ready}
            onUserSeekOrRestart={onUserVideoSeekOrRestart}
          />
        </div>
      )}

      {/* Bottom-right crop control */}
      {mediaState.ready && !calibrationEditing && (
        <button
          type="button"
          onClick={onToggleCalibration}
          title={committedCorners ? 'Adjust the board crop' : 'Crop to just the board'}
          className={`absolute right-4 bottom-4 z-20 inline-flex h-10 items-center gap-2 rounded-full border bg-white px-4 text-sm font-medium shadow-lg transition hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
            committedCorners ? 'border-accent text-zinc-900' : 'border-line text-zinc-800'
          }`}
        >
          <Crop className="h-4.5 w-4.5" aria-hidden="true" />
          {committedCorners ? 'Adjust crop' : 'Crop board'}
        </button>
      )}
    </main>
  )
}

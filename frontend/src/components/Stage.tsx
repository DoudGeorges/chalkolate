import { Camera, Crop, MonitorUp, RefreshCw, Upload } from 'lucide-react'
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
  onCheckNow: () => void
  onUserVideoSeekOrRestart: () => void
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
  onCheckNow,
  onUserVideoSeekOrRestart,
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
      className="relative flex-1 min-w-0 min-h-0 overflow-hidden bg-black focus:outline-none"
    >
      {mediaState.kind === 'none' && (
        <div className="flex h-full flex-col items-center justify-center gap-5 px-6 text-center">
          <p className="max-w-sm text-sm text-zinc-400">
            Choose a camera, share a screen, or upload a lecture video
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={onStartCamera}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white/[0.04] px-3 py-2 text-xs font-medium text-zinc-200 transition hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              <Camera className="h-3.5 w-3.5 text-zinc-400" aria-hidden="true" />
              Camera
            </button>
            <button
              type="button"
              onClick={onStartScreenShare}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white/[0.04] px-3 py-2 text-xs font-medium text-zinc-200 transition hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              <MonitorUp className="h-3.5 w-3.5 text-zinc-400" aria-hidden="true" />
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
              className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white/[0.04] px-3 py-2 text-xs font-medium text-zinc-200 transition hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              <Upload className="h-3.5 w-3.5 text-zinc-400" aria-hidden="true" />
              Upload
            </button>
          </div>
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
            stroke="rgba(231, 178, 122, 0.35)"
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
          className="pointer-events-none absolute bottom-4 left-4 z-20 inline-flex items-center gap-1.5 text-xs font-medium text-zinc-200/85 drop-shadow-[0_1px_4px_rgba(0,0,0,0.95)]"
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

      {/* Bottom-right compact tool cluster (Crop + Check Now while monitoring) */}
      {mediaState.ready && !calibrationEditing && (
        <div className="absolute right-4 bottom-4 z-20 flex items-center gap-1 rounded-full border border-line bg-panel/90 p-1 shadow-lg backdrop-blur-xl">
          <button
            type="button"
            onClick={onToggleCalibration}
            title={committedCorners ? 'Recalibrate board crop' : 'Crop / calibrate board'}
            aria-label={committedCorners ? 'Recalibrate board crop' : 'Crop board'}
            className={`flex h-7 w-7 items-center justify-center rounded-full transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
              committedCorners ? 'text-accent' : 'text-zinc-300 hover:text-zinc-100'
            }`}
          >
            <Crop className="h-3.5 w-3.5" aria-hidden="true" />
          </button>

          {monitoring && (
            <button
              type="button"
              onClick={onCheckNow}
              title="Check now"
              aria-label="Check now"
              className="flex h-7 w-7 items-center justify-center rounded-full text-zinc-300 transition hover:bg-white/10 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${phase === 'ANALYZING' ? 'animate-spin text-accent' : ''}`}
                aria-hidden="true"
              />
            </button>
          )}
        </div>
      )}
    </main>
  )
}

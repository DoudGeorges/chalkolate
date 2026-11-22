import { Check, LoaderCircle, Scan } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { CalibrationCorners, CornerPoint } from '../api/schemas'
import {
  ContainedImageRect,
  clampNorm,
  clientPointToNormalized,
  validateCalibrationQuad,
} from '../lib/geometry'

const CORNER_LABELS = ['Top-left', 'Top-right', 'Bottom-right', 'Bottom-left'] as const

export type CalibrationDetectStatus =
  | 'idle'
  | 'detecting'
  | 'detected'
  | 'fallback'
  | 'error'

export interface CalibrationOverlayProps {
  imageRect: ContainedImageRect
  draftCorners: CalibrationCorners
  detectStatus: CalibrationDetectStatus
  onChangeDraft: (next: CalibrationCorners) => void
}

interface CalibrationToolbarProps {
  draftCorners: CalibrationCorners
  detectStatus: CalibrationDetectStatus
  onAutoDetect: () => void
  onApply: () => void
  onResetCrop: () => void
  onCancel: () => void
}

export function CalibrationOverlay({
  imageRect,
  draftCorners,
  detectStatus,
  onChangeDraft,
}: CalibrationOverlayProps) {
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const firstCornerRef = useRef<HTMLButtonElement>(null)
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null)
  const validation = validateCalibrationQuad(draftCorners)
  const hasImage = imageRect.width > 0 && imageRect.height > 0

  useEffect(() => {
    if (hasImage) firstCornerRef.current?.focus({ preventScroll: true })
  }, [hasImage])

  if (!hasImage) return null

  const updateCorner = (index: number, nextPoint: CornerPoint) => {
    const updated: CalibrationCorners = [
      index === 0 ? nextPoint : draftCorners[0],
      index === 1 ? nextPoint : draftCorners[1],
      index === 2 ? nextPoint : draftCorners[2],
      index === 3 ? nextPoint : draftCorners[3],
    ]
    onChangeDraft(updated)
  }

  const handlePointerDown = (
    index: number,
    event: React.PointerEvent<HTMLButtonElement>,
  ) => {
    event.preventDefault()
    event.currentTarget.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    setDraggingIndex(index)
  }

  const handlePointerMove = (
    index: number,
    event: React.PointerEvent<HTMLButtonElement>,
  ) => {
    if (draggingIndex !== index || !overlayRef.current) return
    const containerRect = overlayRef.current.getBoundingClientRect()
    const nextPoint = clientPointToNormalized(
      event.clientX,
      event.clientY,
      containerRect,
      imageRect,
    )
    updateCorner(index, nextPoint)
  }

  const handlePointerUp = (
    index: number,
    event: React.PointerEvent<HTMLButtonElement>,
  ) => {
    if (draggingIndex === index) {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      setDraggingIndex(null)
    }
  }

  const handleKeyDown = (
    index: number,
    event: React.KeyboardEvent<HTMLButtonElement>,
  ) => {
    const step = event.shiftKey ? 20 : 5
    const current = draftCorners[index]
    if (!current) return
    let [x, y] = current
    if (event.key === 'ArrowLeft') x = clampNorm(x - step)
    else if (event.key === 'ArrowRight') x = clampNorm(x + step)
    else if (event.key === 'ArrowUp') y = clampNorm(y - step)
    else if (event.key === 'ArrowDown') y = clampNorm(y + step)
    else return
    event.preventDefault()
    updateCorner(index, [x, y])
  }

  const polygonPoints = draftCorners.map(([x, y]) => `${x},${y}`).join(' ')
  return (
    <div
      ref={overlayRef}
      className="absolute inset-0 z-30 select-none"
    >
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
        <defs>
          <mask id="chalkolate-cal-mask">
            <rect x="0" y="0" width="1000" height="1000" fill="white" />
            <polygon points={polygonPoints} fill="black" />
          </mask>
        </defs>
        <rect
          x="0"
          y="0"
          width="1000"
          height="1000"
          fill="var(--color-ink)"
          fillOpacity={0.55}
          mask="url(#chalkolate-cal-mask)"
        />
        <polygon
          points={polygonPoints}
          fill="none"
          stroke={validation.valid ? 'white' : 'var(--color-danger)'}
          strokeWidth={2}
          strokeDasharray={detectStatus === 'detecting' ? '6 4' : undefined}
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      {draftCorners.map(([nx, ny], idx) => {
        const pxLeft = imageRect.left + (nx / 1000) * imageRect.width
        const pxTop = imageRect.top + (ny / 1000) * imageRect.height
        const cornerName = CORNER_LABELS[idx] ?? 'Board'

        return (
          <button
            key={cornerName}
            ref={idx === 0 ? firstCornerRef : undefined}
            type="button"
            aria-label={cornerName + ' corner'}
            aria-describedby="crop-keyboard-hint"
            onPointerDown={(e) => handlePointerDown(idx, e)}
            onPointerMove={(e) => handlePointerMove(idx, e)}
            onPointerUp={(e) => handlePointerUp(idx, e)}
            onPointerCancel={(e) => handlePointerUp(idx, e)}
            onKeyDown={(e) => handleKeyDown(idx, e)}
            style={{
              left: `${pxLeft}px`,
              top: `${pxTop}px`,
            }}
            className="group absolute flex size-10 -translate-x-1/2 -translate-y-1/2 touch-none cursor-grab items-center justify-center rounded-full active:cursor-grabbing focus-visible:outline-2 focus-visible:outline-white"
          >
            <span
              className={`size-4 rounded-full border-2 bg-white shadow-[0_1px_4px_rgb(0_0_0/0.35)] transition-transform duration-150 group-hover:scale-[1.15] ${
                draggingIndex === idx ? 'scale-[1.3]' : ''
              } ${validation.valid ? 'border-accent' : 'border-danger'}`}
            />
          </button>
        )
      })}
      <span id="crop-keyboard-hint" className="sr-only">Use the arrow keys to move this corner. Hold Shift for larger steps.</span>
    </div>
  )
}

export function CalibrationToolbar({
  draftCorners,
  detectStatus,
  onAutoDetect,
  onApply,
  onResetCrop,
  onCancel,
}: CalibrationToolbarProps) {
  const validation = validateCalibrationQuad(draftCorners)
  const isDetecting = detectStatus === 'detecting'
  let statusText = 'Move each handle to a corner of the board.'
  if (!validation.valid) {
    statusText = validation.reason ?? 'Move the handles to form a four-sided crop.'
  } else if (isDetecting) {
    statusText = 'Finding board corners…'
  } else if (detectStatus === 'detected') {
    statusText = 'Board found. Adjust the corners if needed.'
  } else if (detectStatus === 'fallback') {
    statusText = 'The board edges are unclear. Move the handles into place.'
  } else if (detectStatus === 'error') {
    statusText = 'Corner detection is unavailable. Move the handles into place.'
  }

  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-line bg-panel p-3">
      <span role="status" className="sr-only">
        {statusText}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onAutoDetect}
          disabled={isDetecting}
          className="ui-button ui-compact"
        >
          {isDetecting ? (
            <LoaderCircle className="animate-spin text-moss" aria-hidden="true" />
          ) : (
            <Scan aria-hidden="true" />
          )}
          {isDetecting ? 'Finding corners…' : 'Detect corners'}
        </button>
        <button
          type="button"
          onClick={onResetCrop}
          className="ui-button ui-compact"
        >
          Reset crop
        </button>
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="ui-button ui-compact"
          data-variant="quiet"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onApply}
          disabled={!validation.valid || isDetecting}
          className="ui-button ui-compact"
          data-variant="primary"
        >
          <Check aria-hidden="true" />
          Apply crop
        </button>
      </div>
    </div>
  )
}

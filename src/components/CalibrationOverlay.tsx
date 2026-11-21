import { Loader2, Scan } from 'lucide-react'
import { useRef, useState } from 'react'
import { CalibrationCorners, CornerPoint } from '../api/schemas'
import {
  ContainedImageRect,
  clampNorm,
  clientPointToNormalized,
  validateCalibrationQuad,
} from '../lib/geometry'

const CORNER_LABELS = ['TL', 'TR', 'BR', 'BL'] as const

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
  onAutoDetect,
  onApply,
  onResetCrop,
  onCancel,
}: CalibrationOverlayProps) {
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null)
  const validation = validateCalibrationQuad(draftCorners)

  if (imageRect.width <= 0 || imageRect.height <= 0) {
    return null
  }

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
  const isDetecting = detectStatus === 'detecting'

  let statusText = 'Drag corners to align with the board'
  let statusTone = 'text-zinc-700'
  if (!validation.valid) {
    statusText = validation.reason ?? 'Adjust handles into a valid quadrilateral'
    statusTone = 'text-rose-700'
  } else if (detectStatus === 'detecting') {
    statusText = 'Detecting board corners…'
    statusTone = 'text-zinc-800'
  } else if (detectStatus === 'detected') {
    statusText = 'Board detected — drag handles to refine'
    statusTone = 'text-emerald-700'
  } else if (detectStatus === 'fallback') {
    statusText = 'Could not detect board edges — drag handles manually'
    statusTone = 'text-zinc-700'
  } else if (detectStatus === 'error') {
    statusText = 'Auto-detect unavailable — drag handles manually'
    statusTone = 'text-amber-700'
  }

  return (
    <div
      ref={overlayRef}
      className="absolute inset-0 z-30 select-none"
      aria-label="Board corner calibration editor"
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
          fill="rgba(255, 255, 255, 0.72)"
          mask="url(#chalkolate-cal-mask)"
        />
        <polygon
          points={polygonPoints}
          fill="rgba(24, 24, 27, 0.04)"
          stroke={validation.valid ? '#18181b' : '#e11d48'}
          strokeWidth={2}
          strokeDasharray={isDetecting ? '6 4' : undefined}
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      {draftCorners.map(([nx, ny], idx) => {
        const pxLeft = imageRect.left + (nx / 1000) * imageRect.width
        const pxTop = imageRect.top + (ny / 1000) * imageRect.height
        const cornerName = CORNER_LABELS[idx] ?? `C${idx}`

        return (
          <button
            key={cornerName}
            type="button"
            aria-label={`Calibration corner ${cornerName}`}
            onPointerDown={(e) => handlePointerDown(idx, e)}
            onPointerMove={(e) => handlePointerMove(idx, e)}
            onPointerUp={(e) => handlePointerUp(idx, e)}
            onPointerCancel={(e) => handlePointerUp(idx, e)}
            onKeyDown={(e) => handleKeyDown(idx, e)}
            style={{
              left: `${pxLeft}px`,
              top: `${pxTop}px`,
            }}
            className="group absolute flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 cursor-grab items-center justify-center rounded-full active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/80"
          >
            <span
              className={`h-4 w-4 rounded-full border-2 bg-white shadow-[0_1px_3px_rgba(0,0,0,0.35)] transition duration-150 group-hover:scale-115 ${
                draggingIndex === idx ? 'scale-120' : ''
              } ${validation.valid ? 'border-accent' : 'border-rose-500'}`}
            />
          </button>
        )
      })}

      {/* Polished calibration control bar */}
      <div className="absolute bottom-4 left-1/2 flex w-max max-w-[94%] -translate-x-1/2 flex-wrap items-center justify-center gap-3 rounded-xl border border-line bg-white px-3.5 py-2 text-xs shadow-lg">
        <span className={`inline-flex items-center gap-1.5 ${statusTone}`}>
          {isDetecting && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" aria-hidden="true" />
          )}
          <span>{statusText}</span>
        </span>

        <span className="hidden sm:inline-block h-4 w-px bg-zinc-100" aria-hidden="true" />

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onAutoDetect}
            disabled={isDetecting}
            title="Re-run automatic corner detection"
            className="inline-flex items-center gap-1 rounded-lg border border-line bg-zinc-100 px-2.5 py-1.5 font-medium text-zinc-800 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            <Scan className="h-3.5 w-3.5 text-zinc-500" aria-hidden="true" />
            <span>Auto-detect</span>
          </button>
          <button
            type="button"
            onClick={onResetCrop}
            className="rounded-lg border border-line bg-zinc-100 px-2.5 py-1.5 font-medium text-zinc-800 transition hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            Reset
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-2.5 py-1.5 font-medium text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onApply}
            disabled={!validation.valid || isDetecting}
            className="rounded-lg bg-accent px-3 py-1.5 font-semibold text-white transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  )
}

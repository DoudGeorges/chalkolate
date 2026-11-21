import { useRef, useState } from 'react'
import { CalibrationCorners, CornerPoint } from '../api/schemas'
import {
  ContainedImageRect,
  clampNorm,
  clientPointToNormalized,
  validateCalibrationQuad,
} from '../lib/geometry'

const CORNER_LABELS = ['TL', 'TR', 'BR', 'BL'] as const

export interface CalibrationOverlayProps {
  imageRect: ContainedImageRect
  draftCorners: CalibrationCorners
  onChangeDraft: (next: CalibrationCorners) => void
  onApply: () => void
  onResetCrop: () => void
  onCancel: () => void
}

export function CalibrationOverlay({
  imageRect,
  draftCorners,
  onChangeDraft,
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
          fill="rgba(2, 6, 23, 0.55)"
          mask="url(#chalkolate-cal-mask)"
        />
        <polygon
          points={polygonPoints}
          fill="rgba(56, 189, 248, 0.08)"
          stroke={validation.valid ? '#38bdf8' : '#f43f5e'}
          strokeWidth={2}
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
            className={`absolute flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 cursor-grab items-center justify-center rounded-full border-2 text-[10px] font-bold shadow-md transition active:cursor-grabbing focus-visible:outline-2 focus-visible:outline-amber-400 ${
              validation.valid
                ? 'border-sky-300 bg-slate-950/90 text-sky-100'
                : 'border-rose-400 bg-rose-950/90 text-rose-100'
            }`}
          >
            {cornerName}
          </button>
        )
      })}

      <div className="absolute bottom-3 left-1/2 flex w-max max-w-[94%] -translate-x-1/2 flex-wrap items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-950/95 px-3 py-2 text-xs shadow-xl">
        <span className={validation.valid ? 'text-slate-300' : 'text-rose-300'}>
          {validation.valid
            ? 'Drag TL, TR, BR, BL handles to board corners (fixed camera assumed).'
            : validation.reason}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onApply}
            disabled={!validation.valid}
            className="rounded bg-sky-500 px-2.5 py-1 font-semibold text-slate-950 transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-amber-400"
          >
            Apply
          </button>
          <button
            type="button"
            onClick={onResetCrop}
            className="rounded border border-slate-700 bg-slate-800 px-2.5 py-1 font-medium text-slate-200 transition hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-amber-400"
          >
            Reset Crop
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-slate-700 bg-slate-900 px-2.5 py-1 font-medium text-slate-300 transition hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-amber-400"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

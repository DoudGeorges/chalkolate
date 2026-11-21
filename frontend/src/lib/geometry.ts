import { Box2D, CalibrationCorners, CornerPoint } from '../api/schemas'

export interface ContainedImageRect {
  left: number
  top: number
  width: number
  height: number
}

export interface ValidationResult {
  valid: boolean
  reason?: string
}

export const DEFAULT_CALIBRATION_CORNERS: CalibrationCorners = [
  [80, 80],
  [920, 80],
  [920, 920],
  [80, 920],
]

const MIN_CORNER_SEPARATION_NORM = 20
const MIN_CORNER_SIN = 0.08
const MIN_QUAD_AREA_NORM = 2500

export function computeContainedImageRect(
  containerWidth: number,
  containerHeight: number,
  intrinsicWidth: number,
  intrinsicHeight: number,
): ContainedImageRect {
  if (
    containerWidth <= 0 ||
    containerHeight <= 0 ||
    intrinsicWidth <= 0 ||
    intrinsicHeight <= 0
  ) {
    return { left: 0, top: 0, width: 0, height: 0 }
  }

  const containerAspect = containerWidth / containerHeight
  const mediaAspect = intrinsicWidth / intrinsicHeight

  if (mediaAspect > containerAspect) {
    const width = containerWidth
    const height = width / mediaAspect
    return {
      left: 0,
      top: (containerHeight - height) / 2,
      width,
      height,
    }
  }

  const height = containerHeight
  const width = height * mediaAspect
  return {
    left: (containerWidth - width) / 2,
    top: 0,
    width,
    height,
  }
}

export function clampNorm(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1000, value))
}

export function clientPointToNormalized(
  clientX: number,
  clientY: number,
  containerRect: Pick<DOMRect, 'left' | 'top'>,
  imageRect: ContainedImageRect,
): CornerPoint {
  if (imageRect.width <= 0 || imageRect.height <= 0) {
    return [0, 0]
  }
  const relX = clientX - containerRect.left - imageRect.left
  const relY = clientY - containerRect.top - imageRect.top
  return [
    clampNorm((relX / imageRect.width) * 1000),
    clampNorm((relY / imageRect.height) * 1000),
  ]
}

export function validateCalibrationQuad(corners: CalibrationCorners): ValidationResult {
  for (const [x, y] of corners) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { valid: false, reason: 'Calibration coordinates must be finite numbers.' }
    }
    if (x < 0 || x > 1000 || y < 0 || y > 1000) {
      return { valid: false, reason: 'Calibration corners must stay inside the board frame.' }
    }
  }

  for (let i = 0; i < 4; i++) {
    const a = corners[i]
    if (!a) return { valid: false, reason: 'Calibration requires four corners.' }
    for (let j = i + 1; j < 4; j++) {
      const b = corners[j]
      if (!b) return { valid: false, reason: 'Calibration requires four corners.' }
      const dist = Math.hypot(a[0] - b[0], a[1] - b[1])
      if (dist < MIN_CORNER_SEPARATION_NORM) {
        return {
          valid: false,
          reason: 'Calibration corners are too close together.',
        }
      }
    }
  }

  // Strictly clockwise in image coordinates (x right, y down) => crossZ > 0 at every corner.
  for (let i = 0; i < 4; i++) {
    const p0 = corners[i]!
    const p1 = corners[(i + 1) % 4]!
    const p2 = corners[(i + 2) % 4]!
    const e1x = p1[0] - p0[0]
    const e1y = p1[1] - p0[1]
    const e2x = p2[0] - p1[0]
    const e2y = p2[1] - p1[1]
    const n1 = Math.hypot(e1x, e1y)
    const n2 = Math.hypot(e2x, e2y)
    const crossZ = e1x * e2y - e1y * e2x
    if (crossZ <= 0) {
      return {
        valid: false,
        reason: 'Corners must form a convex quad in TL, TR, BR, BL order without crossing edges.',
      }
    }
    const sinTheta = crossZ / (n1 * n2)
    if (sinTheta < MIN_CORNER_SIN) {
      return {
        valid: false,
        reason: 'Calibration corners are nearly collinear; adjust handles into a clear quad.',
      }
    }
  }

  let area2 = 0
  for (let i = 0; i < 4; i++) {
    const p0 = corners[i]!
    const p1 = corners[(i + 1) % 4]!
    area2 += p0[0] * p1[1] - p1[0] * p0[1]
  }
  const area = Math.abs(area2) / 2
  if (area < MIN_QUAD_AREA_NORM) {
    return { valid: false, reason: 'Selected board area is too small.' }
  }

  const [tl, tr, br, bl] = corners
  if (!(tr[0] > tl[0] && br[0] > bl[0] && bl[1] > tl[1] && br[1] > tr[1])) {
    return {
      valid: false,
      reason: 'Maintain TL, TR, BR, BL orientation without swapping corners.',
    }
  }

  return { valid: true }
}

/**
 * Builds a pixel inclusion mask (1 inside calibrated quad, 0 outside) on a
 * sample grid of dimensions (width x height) using normalized [0..1000] bounds.
 */
export function buildNormalizedQuadMask(
  corners: CalibrationCorners,
  width: number,
  height: number,
): Uint8Array {
  const mask = new Uint8Array(width * height)
  if (width <= 0 || height <= 0) return mask

  for (let y = 0; y < height; y++) {
    const ny = ((y + 0.5) * 1000) / height
    for (let x = 0; x < width; x++) {
      const nx = ((x + 0.5) * 1000) / width
      let inside = true
      for (let i = 0; i < 4; i++) {
        const p0 = corners[i]!
        const p1 = corners[(i + 1) % 4]!
        // Clockwise edge p0 -> p1 in image coords: interior sits to the right (cross >= 0).
        const cross = (p1[0] - p0[0]) * (ny - p0[1]) - (p1[1] - p0[1]) * (nx - p0[0])
        if (cross < 0) {
          inside = false
          break
        }
      }
      mask[y * width + x] = inside ? 1 : 0
    }
  }
  return mask
}

export interface PillPosition {
  left: number
  top: number
  placement: 'above' | 'below'
}

export function computeOverlayPillPosition(
  box: Box2D,
  imageRect: ContainedImageRect,
  estimatedPillWidth = 220,
  estimatedPillHeight = 30,
): PillPosition {
  const [ymin, xmin, ymax] = box
  const boxLeftPx = (xmin / 1000) * imageRect.width
  const boxTopPx = (ymin / 1000) * imageRect.height
  const boxBottomPx = (ymax / 1000) * imageRect.height

  const maxLocalLeft = Math.max(4, imageRect.width - estimatedPillWidth - 4)
  const localLeft = Math.max(4, Math.min(maxLocalLeft, boxLeftPx))

  let placement: 'above' | 'below' = 'above'
  let localTop = boxTopPx - estimatedPillHeight - 6
  if (localTop < 4) {
    placement = 'below'
    localTop = Math.min(
      Math.max(4, imageRect.height - estimatedPillHeight - 4),
      boxBottomPx + 6,
    )
  }

  return {
    left: imageRect.left + localLeft,
    top: imageRect.top + localTop,
    placement,
  }
}

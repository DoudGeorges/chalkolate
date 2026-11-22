import { CalibrationCorners, CornerPoint } from '../api/schemas'

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

/** Row-major 3x3 homography with the last entry fixed to 1: `[a, b, c, d, e, f, g, h]`. */
export type Homography = readonly [number, number, number, number, number, number, number, number]

type Point = readonly [number, number]

/** Solve the homography mapping four `src` points onto four `dst` points (null if degenerate). */
export function solveHomography(
  src: readonly [Point, Point, Point, Point],
  dst: readonly [Point, Point, Point, Point],
): Homography | null {
  // 8x9 augmented system [A | b], solved by Gauss-Jordan elimination with partial pivoting.
  // Stored flat (row-major, 9 columns) to keep indexing simple under noUncheckedIndexedAccess.
  const m = new Float64Array(8 * 9)
  const at = (r: number, c: number) => m[r * 9 + c] ?? 0
  const pairs = [
    [src[0], dst[0]],
    [src[1], dst[1]],
    [src[2], dst[2]],
    [src[3], dst[3]],
  ] as const
  pairs.forEach(([[x, y], [u, v]], i) => {
    m.set([x, y, 1, 0, 0, 0, -x * u, -y * u, u], 2 * i * 9)
    m.set([0, 0, 0, x, y, 1, -x * v, -y * v, v], (2 * i + 1) * 9)
  })

  for (let col = 0; col < 8; col += 1) {
    let pivot = col
    for (let r = col + 1; r < 8; r += 1) {
      if (Math.abs(at(r, col)) > Math.abs(at(pivot, col))) pivot = r
    }
    if (Math.abs(at(pivot, col)) < 1e-12) return null
    if (pivot !== col) {
      const pivotRow = m.slice(pivot * 9, pivot * 9 + 9)
      m.copyWithin(pivot * 9, col * 9, col * 9 + 9)
      m.set(pivotRow, col * 9)
    }
    const diag = at(col, col)
    for (let r = 0; r < 8; r += 1) {
      if (r === col) continue
      const factor = at(r, col) / diag
      if (factor === 0) continue
      for (let k = col; k < 9; k += 1) m[r * 9 + k] = at(r, k) - factor * at(col, k)
    }
  }

  const h: Homography = [
    at(0, 8) / at(0, 0),
    at(1, 8) / at(1, 1),
    at(2, 8) / at(2, 2),
    at(3, 8) / at(3, 3),
    at(4, 8) / at(4, 4),
    at(5, 8) / at(5, 5),
    at(6, 8) / at(6, 6),
    at(7, 8) / at(7, 7),
  ]
  return h.every(Number.isFinite) ? h : null
}

export function applyHomography(h: Homography, x: number, y: number): [number, number] {
  const w = h[6] * x + h[7] * y + 1
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w]
}

/** CSS `matrix3d(...)` that applies `h` to an element with `transform-origin: 0 0`. */
export function homographyToCssMatrix3d(h: Homography): string {
  const [a, b, c, d, e, f, g, hh] = h
  return `matrix3d(${a}, ${d}, 0, ${g}, ${b}, ${e}, 0, ${hh}, 0, 0, 1, 0, ${c}, ${f}, 0, 1)`
}

export interface RectifiedCropView {
  /** Stage-space rectangle the straightened board fills. */
  rect: ContainedImageRect
  /** Maps media element pixels (intrinsic size) onto `rect`-local pixels. */
  elementToRect: Homography
  /** Maps canonical normalized `[0, 1000]` source coordinates onto stage pixels. */
  project: (x: number, y: number) => [number, number]
}

/**
 * Perspective-correct view of the committed crop: the board quad is straightened into a rectangle
 * that is as large as possible inside the stage. The rectified aspect ratio matches the backend
 * (`max(top, bottom)` x `max(left, right)` edge length in source pixels), so writing is not
 * stretched. Returns null when the crop cannot be rectified.
 */
export function computeRectifiedCropView(
  containerWidth: number,
  containerHeight: number,
  intrinsicWidth: number,
  intrinsicHeight: number,
  corners: CalibrationCorners | null,
): RectifiedCropView | null {
  if (
    !corners ||
    containerWidth <= 0 ||
    containerHeight <= 0 ||
    intrinsicWidth <= 0 ||
    intrinsicHeight <= 0 ||
    !validateCalibrationQuad(corners).valid
  ) {
    return null
  }

  const px = corners.map(
    ([x, y]) => [(x / 1000) * intrinsicWidth, (y / 1000) * intrinsicHeight] as const,
  ) as unknown as [Point, Point, Point, Point]
  const dist = (p: Point, q: Point) => Math.hypot(p[0] - q[0], p[1] - q[1])
  const boardWidth = Math.max(dist(px[0], px[1]), dist(px[3], px[2]))
  const boardHeight = Math.max(dist(px[0], px[3]), dist(px[1], px[2]))
  if (!(boardWidth > 0) || !(boardHeight > 0)) return null

  const rect = computeContainedImageRect(
    containerWidth,
    containerHeight,
    boardWidth,
    boardHeight,
  )
  if (rect.width <= 0 || rect.height <= 0) return null

  const elementToRect = solveHomography(px, [
    [0, 0],
    [rect.width, 0],
    [rect.width, rect.height],
    [0, rect.height],
  ])
  if (!elementToRect) return null

  return {
    rect,
    elementToRect,
    project: (x, y) => {
      const [u, v] = applyHomography(
        elementToRect,
        (x / 1000) * intrinsicWidth,
        (y / 1000) * intrinsicHeight,
      )
      return [rect.left + u, rect.top + v]
    },
  }
}

/** Linear normalized `[0, 1000]` -> stage pixel mapping for an uncropped contained image. */
export function projectThroughRect(rect: ContainedImageRect) {
  return (x: number, y: number): [number, number] => [
    rect.left + (x / 1000) * rect.width,
    rect.top + (y / 1000) * rect.height,
  ]
}

export interface PillPosition {
  left: number
  top: number
  placement: 'above' | 'below'
}

/**
 * Places a finding pill above (or below) a box given in stage pixels, kept inside `clipRect`
 * (the visible media area).
 */
export function computeOverlayPillPosition(
  boxPx: { left: number; top: number; bottom: number },
  clipRect: ContainedImageRect,
  estimatedPillWidth = 220,
  estimatedPillHeight = 30,
): PillPosition {
  const minLeft = clipRect.left + 4
  const maxLeft = Math.max(minLeft, clipRect.left + clipRect.width - estimatedPillWidth - 4)
  const left = Math.max(minLeft, Math.min(maxLeft, boxPx.left))

  const minTop = clipRect.top + 4
  let placement: 'above' | 'below' = 'above'
  let top = boxPx.top - estimatedPillHeight - 6
  if (top < minTop) {
    placement = 'below'
    top = Math.max(
      minTop,
      Math.min(clipRect.top + clipRect.height - estimatedPillHeight - 4, boxPx.bottom + 6),
    )
  }

  return { left, top, placement }
}

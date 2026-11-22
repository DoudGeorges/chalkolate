import { Box2D } from '../api/schemas'
import { GrayscaleSample } from './frameCapture'

/** Side length (in sample-grid pixels) of each change-detection tile. */
export const TILE_PX = 16
/** Per-pixel luma delta (after global brightness offset compensation) treated as changed. */
export const PIXEL_DELTA = 20
/** Fraction of masked pixels in a tile that constitutes a persistent baseline difference. */
export const CHANGED_TILE_FRACTION = 0.03
/** Fraction of masked pixels in a tile that indicates active frame-to-frame motion. */
export const MOVING_TILE_FRACTION = 0.06
/** Number of consecutive calm ticks a tile must hold before changes there count as persistent. */
export const STILL_TICKS_FOR_PERSISTENCE = 2
/** Fraction of valid tiles persistently changed from baseline that indicates a full scene shift. */
/** Minimum fraction of a tile's area inside the calibration mask for the tile to participate. */
export const MIN_TILE_COVERAGE = 0.5
/** Changed-pixel fraction inside a finding's bounding box needed to classify it as changed. */
export const REGION_CHANGED_FRACTION = 0.015

export type RegionStatus = 'unchanged' | 'changed' | 'obscured'

export interface DetectorState {
  prev: GrayscaleSample | null
  stillTicks: Uint16Array
  width: number
  height: number
}

export interface DetectorUpdate {
  state: DetectorState
  movingFraction: number
  activeChangedTiles: number
  persistentChangedTiles: number
  stillTicks: Uint16Array
}

export function createDetectorState(): DetectorState {
  return {
    prev: null,
    stillTicks: new Uint16Array(0),
    width: 0,
    height: 0,
  }
}

export function computeMaskedBrightnessOffset(
  a: GrayscaleSample,
  b: GrayscaleSample,
  mask: Uint8Array | null,
): number {
  const len = Math.min(a.data.length, b.data.length)
  if (len === 0) return 0
  const useMask = mask !== null && mask.length === len

  let sumA = 0
  let sumB = 0
  let count = 0
  for (let i = 0; i < len; i++) {
    if (useMask && mask[i] === 0) continue
    sumA += a.data[i] ?? 0
    sumB += b.data[i] ?? 0
    count++
  }
  return count > 0 ? (sumB - sumA) / count : 0
}

/**
 * Computes the per-tile fraction of masked pixels whose illumination-compensated
 * luma differs by more than PIXEL_DELTA. Tiles below MIN_TILE_COVERAGE yield NaN.
 */
export function tileChangeFractions(
  a: GrayscaleSample,
  b: GrayscaleSample,
  mask: Uint8Array | null,
): Float32Array {
  const cols = Math.ceil(b.width / TILE_PX)
  const rows = Math.ceil(b.height / TILE_PX)
  const out = new Float32Array(cols * rows)

  if (a.width !== b.width || a.height !== b.height || a.data.length !== b.data.length) {
    out.fill(1)
    return out
  }

  const w = b.width
  const h = b.height
  const useMask = mask !== null && mask.length === w * h
  const offset = computeMaskedBrightnessOffset(a, b, mask)

  for (let ty = 0; ty < rows; ty++) {
    const y0 = ty * TILE_PX
    const y1 = Math.min(h, y0 + TILE_PX)
    for (let tx = 0; tx < cols; tx++) {
      const x0 = tx * TILE_PX
      const x1 = Math.min(w, x0 + TILE_PX)
      const tileArea = (x1 - x0) * (y1 - y0)

      let inMask = 0
      let changed = 0
      for (let y = y0; y < y1; y++) {
        const rowOff = y * w
        for (let x = x0; x < x1; x++) {
          const idx = rowOff + x
          if (useMask && mask[idx] === 0) continue
          inMask++
          const diff = Math.abs((b.data[idx] ?? 0) - (a.data[idx] ?? 0) - offset)
          if (diff > PIXEL_DELTA) {
            changed++
          }
        }
      }

      const tileIdx = ty * cols + tx
      if (tileArea === 0 || inMask / tileArea < MIN_TILE_COVERAGE) {
        out[tileIdx] = Number.NaN
      } else {
        out[tileIdx] = changed / inMask
      }
    }
  }

  return out
}

export function updateDetector(
  state: DetectorState,
  sample: GrayscaleSample,
  baseline: GrayscaleSample | null,
  mask: Uint8Array | null,
): DetectorUpdate {
  const cols = Math.ceil(sample.width / TILE_PX)
  const rows = Math.ceil(sample.height / TILE_PX)
  const tileCount = cols * rows

  let nextStillTicks: Uint16Array
  let movingFraction = 0

  if (
    !state.prev ||
    state.width !== sample.width ||
    state.height !== sample.height ||
    state.stillTicks.length !== tileCount
  ) {
    nextStillTicks = new Uint16Array(tileCount)
  } else {
    const motionFracs = tileChangeFractions(state.prev, sample, mask)
    nextStillTicks = new Uint16Array(tileCount)
    let validMotionTiles = 0
    let movingTiles = 0

    for (let i = 0; i < tileCount; i++) {
      const frac = motionFracs[i] ?? Number.NaN
      if (Number.isNaN(frac)) {
        nextStillTicks[i] = 0
        continue
      }
      validMotionTiles++
      if (frac >= MOVING_TILE_FRACTION) {
        nextStillTicks[i] = 0
        movingTiles++
      } else {
        nextStillTicks[i] = Math.min(65535, (state.stillTicks[i] ?? 0) + 1)
      }
    }
    movingFraction = validMotionTiles > 0 ? movingTiles / validMotionTiles : 0
  }

  let activeChangedTiles = 0
  let persistentChangedTiles = 0

  if (baseline) {
    if (baseline.width !== sample.width || baseline.height !== sample.height) {
      activeChangedTiles = tileCount
      persistentChangedTiles = tileCount
    } else {
      const baseFracs = tileChangeFractions(baseline, sample, mask)
      for (let i = 0; i < tileCount; i++) {
        const frac = baseFracs[i] ?? Number.NaN
        if (Number.isNaN(frac)) continue
        if (frac >= CHANGED_TILE_FRACTION) {
          activeChangedTiles++
          if ((nextStillTicks[i] ?? 0) >= STILL_TICKS_FOR_PERSISTENCE) {
            persistentChangedTiles++
          }
        }
      }
    }
  }

  return {
    state: {
      prev: sample,
      stillTicks: nextStillTicks,
      width: sample.width,
      height: sample.height,
    },
    movingFraction,
    activeChangedTiles,
    persistentChangedTiles,
    stillTicks: nextStillTicks,
  }
}

function isTileCoveredByMask(
  tx: number,
  ty: number,
  w: number,
  h: number,
  mask: Uint8Array,
): boolean {
  const x0 = tx * TILE_PX
  const x1 = Math.min(w, x0 + TILE_PX)
  const y0 = ty * TILE_PX
  const y1 = Math.min(h, y0 + TILE_PX)
  const tileArea = (x1 - x0) * (y1 - y0)
  if (tileArea <= 0) return false
  let inMask = 0
  for (let y = y0; y < y1; y++) {
    const rowOff = y * w
    for (let x = x0; x < x1; x++) {
      if (mask[rowOff + x] !== 0) inMask++
    }
  }
  return inMask / tileArea >= MIN_TILE_COVERAGE
}

/**
 * Returns true when no overlapping tile is actively moving and at least half of the
 * overlapping masked tiles have held steady for STILL_TICKS_FOR_PERSISTENCE samples.
 */
export function isRegionCalm(
  box2d: Box2D,
  width: number,
  height: number,
  stillTicks: Uint16Array,
  mask: Uint8Array | null,
): boolean {
  if (width <= 0 || height <= 0 || stillTicks.length === 0) return false
  const cols = Math.ceil(width / TILE_PX)
  const useMask = mask !== null && mask.length === width * height

  const [ymin, xmin, ymax, xmax] = box2d
  const px0 = Math.max(0, Math.floor((xmin * width) / 1000) - 1)
  const py0 = Math.max(0, Math.floor((ymin * height) / 1000) - 1)
  const px1 = Math.min(width, Math.ceil((xmax * width) / 1000) + 1)
  const py1 = Math.min(height, Math.ceil((ymax * height) / 1000) + 1)
  if (px1 <= px0 || py1 <= py0) return false

  const tx0 = Math.floor(px0 / TILE_PX)
  const tx1 = Math.floor((px1 - 1) / TILE_PX)
  const ty0 = Math.floor(py0 / TILE_PX)
  const ty1 = Math.floor((py1 - 1) / TILE_PX)

  let checkedTiles = 0
  let calmTiles = 0
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      if (useMask && !isTileCoveredByMask(tx, ty, width, height, mask)) {
        continue
      }
      checkedTiles++
      const ticks = stillTicks[ty * cols + tx] ?? 0
      if (ticks === 0) {
        return false
      }
      if (ticks >= STILL_TICKS_FOR_PERSISTENCE) {
        calmTiles++
      }
    }
  }

  return checkedTiles > 0 && calmTiles * 2 >= checkedTiles
}

/**
 * Classifies whether a previously observed finding's region is currently obscured
 * by motion, materially changed since last seen, or visually unchanged.
 */
export function classifyRegion(
  box2d: Box2D,
  lastSeen: GrayscaleSample | null,
  current: GrayscaleSample,
  stillTicks: Uint16Array,
  mask: Uint8Array | null,
): RegionStatus {
  if (
    !lastSeen ||
    lastSeen.width !== current.width ||
    lastSeen.height !== current.height ||
    lastSeen.data.length !== current.data.length
  ) {
    return 'obscured'
  }

  const w = current.width
  const h = current.height
  const useMask = mask !== null && mask.length === w * h

  if (!isRegionCalm(box2d, w, h, stillTicks, mask)) {
    return 'obscured'
  }

  const [ymin, xmin, ymax, xmax] = box2d
  const px0 = Math.max(0, Math.floor((xmin * w) / 1000) - 1)
  const py0 = Math.max(0, Math.floor((ymin * h) / 1000) - 1)
  const px1 = Math.min(w, Math.ceil((xmax * w) / 1000) + 1)
  const py1 = Math.min(h, Math.ceil((ymax * h) / 1000) + 1)

  if (px1 <= px0 || py1 <= py0) {
    return 'obscured'
  }

  const offset = computeMaskedBrightnessOffset(lastSeen, current, mask)
  let count = 0
  let changed = 0
  for (let y = py0; y < py1; y++) {
    const rowOff = y * w
    for (let x = px0; x < px1; x++) {
      const idx = rowOff + x
      if (useMask && mask[idx] === 0) continue
      count++
      const diff = Math.abs((current.data[idx] ?? 0) - (lastSeen.data[idx] ?? 0) - offset)
      if (diff > PIXEL_DELTA) {
        changed++
      }
    }
  }

  if (count === 0) return 'obscured'
  return changed / count >= REGION_CHANGED_FRACTION ? 'changed' : 'unchanged'
}

import type { CalibrationCorners } from '../api/schemas'
import type { GrayscaleSample } from './frameCapture'

/** Inner margin bounds isolating the outer perimeter ring from central board writing. */
const INNER_MIN_FRACTION = 0.16
const INNER_MAX_FRACTION = 0.84

/** Maximum frame-to-frame motion allowed before treating the camera view as settled. */
export const CAMERA_MOTION_CALM_MAX = 0.025
const MOTION_PIXEL_DELTA = 18

/** Illumination-compensated intensity difference required for a shifted perimeter pixel. */
const OUTER_PIXEL_DELTA = 24
const SECTOR_SHIFT_FRACTION = 0.25

/** Hysteresis entry & release thresholds across the 4 perimeter sectors (top/bottom/left/right). */
const ENTER_MIN_SECTORS = 3
const ENTER_MIN_OUTER_FRACTION = 0.36
const HOLD_MIN_SECTORS = 2
const HOLD_MIN_OUTER_FRACTION = 0.22

export const SHIFT_STABLE_TICKS_REQUIRED = 5
export const SHIFT_PROBE_COOLDOWN_MS = 15_000

const CORNER_SHIFT_MEAN_THRESHOLD = 38
const CORNER_SHIFT_MAX_THRESHOLD = 65

export interface CameraShiftState {
  anchorSample: GrayscaleSample | null
  prevSample: GrayscaleSample | null
  stableShiftedTicks: number
  shiftedActive: boolean
  lastProbeAtMs: number | null
}

export interface CameraShiftEvaluation {
  nextState: CameraShiftState
  shouldProbe: boolean
  shiftedSectors: number
  outerShiftFraction: number
  frameMotionFraction: number
}

/**
 * Initializes or re-anchors camera movement monitoring against a calm reference frame.
 */
export function createCameraShiftState(
  anchorSample: GrayscaleSample | null = null,
  lastProbeAtMs: number | null = null,
): CameraShiftState {
  return {
    anchorSample,
    prevSample: anchorSample,
    stableShiftedTicks: 0,
    shiftedActive: false,
    lastProbeAtMs,
  }
}

/**
 * Returns true when detected board corners shifted enough in normalized [0, 1000]
 * source coordinates to warrant prompting the user to update perspective calibration.
 */
export function isSignificantCornerShift(
  previousCorners: CalibrationCorners,
  nextCorners: CalibrationCorners,
): boolean {
  let sumDist = 0
  let maxDist = 0

  for (let i = 0; i < 4; i++) {
    const dx = nextCorners[i]![0] - previousCorners[i]![0]
    const dy = nextCorners[i]![1] - previousCorners[i]![1]
    const dist = Math.hypot(dx, dy)
    sumDist += dist
    if (dist > maxDist) {
      maxDist = dist
    }
  }

  const meanDist = sumDist / 4
  return meanDist >= CORNER_SHIFT_MEAN_THRESHOLD || maxDist >= CORNER_SHIFT_MAX_THRESHOLD
}

function computeFrameMotionFraction(
  sample: GrayscaleSample,
  prevSample: GrayscaleSample | null,
): number {
  if (
    !prevSample ||
    prevSample.width !== sample.width ||
    prevSample.height !== sample.height
  ) {
    return 0
  }

  const curr = sample.data
  const prev = prevSample.data
  const total = curr.length
  if (total === 0) return 0

  let sumDelta = 0
  for (let i = 0; i < total; i++) {
    sumDelta += curr[i]! - prev[i]!
  }
  const meanOffset = sumDelta / total

  let movingCount = 0
  for (let i = 0; i < total; i++) {
    if (Math.abs(curr[i]! - (prev[i]! + meanOffset)) > MOTION_PIXEL_DELTA) {
      movingCount += 1
    }
  }
  return movingCount / total
}

/**
 * Evaluates whether the live camera view has shifted persistently outside the inner board
 * area without reacting to transient presenter motion, board writing, or lighting drift.
 */
export function evaluateCameraShift(
  state: CameraShiftState,
  sample: GrayscaleSample,
  nowMs: number,
): CameraShiftEvaluation {
  const anchor = state.anchorSample
  if (
    !anchor ||
    anchor.width !== sample.width ||
    anchor.height !== sample.height ||
    sample.width <= 0 ||
    sample.height <= 0
  ) {
    return {
      nextState: createCameraShiftState(sample, state.lastProbeAtMs),
      shouldProbe: false,
      shiftedSectors: 0,
      outerShiftFraction: 0,
      frameMotionFraction: 0,
    }
  }

  const frameMotionFraction = computeFrameMotionFraction(sample, state.prevSample)
  if (frameMotionFraction > CAMERA_MOTION_CALM_MAX) {
    return {
      nextState: {
        ...state,
        prevSample: sample,
        stableShiftedTicks: 0,
      },
      shouldProbe: false,
      shiftedSectors: 0,
      outerShiftFraction: 0,
      frameMotionFraction,
    }
  }

  const { width, height, data: currData } = sample
  const anchorData = anchor.data
  const xMin = Math.floor(width * INNER_MIN_FRACTION)
  const xMax = Math.ceil(width * INNER_MAX_FRACTION)
  const yMin = Math.floor(height * INNER_MIN_FRACTION)
  const yMax = Math.ceil(height * INNER_MAX_FRACTION)

  let outerCount = 0
  let outerDeltaSum = 0
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width
    const isTopOrBottom = y < yMin || y >= yMax
    for (let x = 0; x < width; x++) {
      if (!isTopOrBottom && x >= xMin && x < xMax) continue
      const idx = rowOffset + x
      outerDeltaSum += currData[idx]! - anchorData[idx]!
      outerCount += 1
    }
  }

  if (outerCount === 0) {
    return {
      nextState: {
        ...state,
        prevSample: sample,
        stableShiftedTicks: 0,
        shiftedActive: false,
      },
      shouldProbe: false,
      shiftedSectors: 0,
      outerShiftFraction: 0,
      frameMotionFraction,
    }
  }

  const brightnessOffset = outerDeltaSum / outerCount
  const sectorTotal = [0, 0, 0, 0]
  const sectorChanged = [0, 0, 0, 0]
  let totalChanged = 0

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width
    const topOrBottom = y < yMin ? 0 : y >= yMax ? 1 : -1
    for (let x = 0; x < width; x++) {
      let sector = topOrBottom
      if (sector === -1) {
        if (x < xMin) {
          sector = 2
        } else if (x >= xMax) {
          sector = 3
        } else {
          continue
        }
      }

      const idx = rowOffset + x
      sectorTotal[sector]! += 1
      if (
        Math.abs(currData[idx]! - (anchorData[idx]! + brightnessOffset)) > OUTER_PIXEL_DELTA
      ) {
        sectorChanged[sector]! += 1
        totalChanged += 1
      }
    }
  }

  let shiftedSectors = 0
  for (let s = 0; s < 4; s++) {
    const count = sectorTotal[s]!
    if (count > 0 && sectorChanged[s]! / count >= SECTOR_SHIFT_FRACTION) {
      shiftedSectors += 1
    }
  }
  const outerShiftFraction = totalChanged / outerCount

  let shiftedActive = state.shiftedActive
  let stableShiftedTicks = state.stableShiftedTicks

  if (!shiftedActive) {
    if (
      shiftedSectors >= ENTER_MIN_SECTORS &&
      outerShiftFraction >= ENTER_MIN_OUTER_FRACTION
    ) {
      shiftedActive = true
      stableShiftedTicks = 1
    } else {
      stableShiftedTicks = 0
    }
  } else if (shiftedSectors < HOLD_MIN_SECTORS || outerShiftFraction < HOLD_MIN_OUTER_FRACTION) {
    shiftedActive = false
    stableShiftedTicks = 0
  } else {
    stableShiftedTicks += 1
  }

  const cooldownElapsed =
    state.lastProbeAtMs === null || nowMs - state.lastProbeAtMs >= SHIFT_PROBE_COOLDOWN_MS
  const shouldProbe =
    shiftedActive && stableShiftedTicks >= SHIFT_STABLE_TICKS_REQUIRED && cooldownElapsed

  return {
    nextState: {
      anchorSample: anchor,
      prevSample: sample,
      stableShiftedTicks: shouldProbe ? 0 : stableShiftedTicks,
      shiftedActive: shouldProbe ? false : shiftedActive,
      lastProbeAtMs: shouldProbe ? nowMs : state.lastProbeAtMs,
    },
    shouldProbe,
    shiftedSectors,
    outerShiftFraction,
    frameMotionFraction,
  }
}

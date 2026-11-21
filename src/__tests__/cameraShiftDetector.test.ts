import { describe, expect, it } from 'vitest'
import { CalibrationCorners } from '../api/schemas'
import {
  SHIFT_PROBE_COOLDOWN_MS,
  SHIFT_STABLE_TICKS_REQUIRED,
  createCameraShiftState,
  evaluateCameraShift,
  isSignificantCornerShift,
} from '../lib/cameraShiftDetector'
import { GrayscaleSample } from '../lib/frameCapture'

function makeSample(
  width: number,
  height: number,
  fill: (x: number, y: number) => number,
): GrayscaleSample {
  const data = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[y * width + x] = Math.max(0, Math.min(255, Math.round(fill(x, y))))
    }
  }
  return { width, height, data }
}

describe('cameraShiftDetector', () => {
  it('distinguishes minor corner jitter from meaningful perspective shifts', () => {
    const base: CalibrationCorners = [
      [100, 100],
      [900, 100],
      [900, 900],
      [100, 900],
    ]
    const tinyJitter: CalibrationCorners = [
      [112, 108],
      [910, 114],
      [888, 890],
      [110, 912],
    ]
    const meaningfulShift: CalibrationCorners = [
      [175, 130],
      [940, 115],
      [885, 895],
      [130, 910],
    ]

    expect(isSignificantCornerShift(base, tinyJitter)).toBe(false)
    expect(isSignificantCornerShift(base, meaningfulShift)).toBe(true)
  })

  it('ignores global brightness changes and central board writing or single-edge motion', () => {
    const w = 100
    const h = 100
    const anchor = makeSample(w, h, () => 80)
    let state = createCameraShiftState(anchor)

    // Uniform lighting boost +45 everywhere
    const brighter = makeSample(w, h, () => 125)
    for (let i = 0; i < 8; i++) {
      const res = evaluateCameraShift(state, brighter, 1000 + i * 400)
      state = res.nextState
      expect(res.shouldProbe).toBe(false)
    }

    // Heavy central board writing + only right edge occluded (1 outer sector)
    const centerAndRightOnly = makeSample(w, h, (x, y) => {
      const inInner = x >= 16 && x < 84 && y >= 16 && y < 84
      const inRightBand = x >= 84 && y >= 16 && y < 84
      return inInner || inRightBand ? 180 : 80
    })
    for (let i = 0; i < 8; i++) {
      const res = evaluateCameraShift(state, centerAndRightOnly, 5000 + i * 400)
      state = res.nextState
      expect(res.shouldProbe).toBe(false)
    }
  })

  it('requires calm settled perimeter shift across >= 3 sectors and respects cooldown', () => {
    const w = 100
    const h = 100
    const anchor = makeSample(w, h, (x, y) => ((x + y) % 10 < 5 ? 60 : 120))
    let state = createCameraShiftState(anchor)

    // Shifted background affecting all 4 perimeter sectors (> 24 intensity delta)
    const shifted = makeSample(w, h, (x, y) => {
      const inInner = x >= 16 && x < 84 && y >= 16 && y < 84
      if (inInner) return (x + y) % 10 < 5 ? 60 : 120
      return (x + y) % 10 < 5 ? 190 : 30
    })

    // First shifted frame has high frame-to-frame motion relative to anchor -> ignored cleanly
    const first = evaluateCameraShift(state, shifted, 1000)
    state = first.nextState
    expect(first.shouldProbe).toBe(false)

    // Ticks 1..4 of settled shifted view build stability without firing prematurely
    for (let tick = 1; tick < SHIFT_STABLE_TICKS_REQUIRED; tick++) {
      const res = evaluateCameraShift(state, shifted, 1000 + tick * 400)
      state = res.nextState
      expect(res.shouldProbe).toBe(false)
    }

    // Tick 5 of calm settled shift fires probe
    const firedAtMs = 1000 + SHIFT_STABLE_TICKS_REQUIRED * 400
    const triggerRes = evaluateCameraShift(state, shifted, firedAtMs)
    state = triggerRes.nextState
    expect(triggerRes.shouldProbe).toBe(true)
    expect(triggerRes.shiftedSectors).toBeGreaterThanOrEqual(3)

    // Subsequent calm shifted ticks inside cooldown window must NOT re-probe
    for (let tick = 1; tick <= 6; tick++) {
      const duringCooldown = evaluateCameraShift(state, shifted, firedAtMs + tick * 500)
      state = duringCooldown.nextState
      expect(duringCooldown.shouldProbe).toBe(false)
    }

    // After cooldown expires, settled persistent shift can probe again after stable ticks
    let afterCooldownFired = false
    for (let tick = 0; tick <= SHIFT_STABLE_TICKS_REQUIRED; tick++) {
      const after = evaluateCameraShift(
        state,
        shifted,
        firedAtMs + SHIFT_PROBE_COOLDOWN_MS + tick * 400,
      )
      state = after.nextState
      if (after.shouldProbe) {
        afterCooldownFired = true
      }
    }
    expect(afterCooldownFired).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import {
  STILL_TICKS_FOR_PERSISTENCE,
  classifyRegion,
  createDetectorState,
  updateDetector,
} from '../lib/changeDetector'
import { GrayscaleSample } from '../lib/frameCapture'

function makeSample(width: number, height: number, fill = 30): GrayscaleSample {
  return {
    width,
    height,
    data: new Uint8Array(width * height).fill(fill),
  }
}

function drawRect(
  sample: GrayscaleSample,
  x0: number,
  y0: number,
  w: number,
  h: number,
  value: number,
): GrayscaleSample {
  const copy = new Uint8Array(sample.data)
  for (let y = y0; y < Math.min(sample.height, y0 + h); y++) {
    for (let x = x0; x < Math.min(sample.width, x0 + w); x++) {
      copy[y * sample.width + x] = value
    }
  }
  return { width: sample.width, height: sample.height, data: copy }
}

describe('Tile-based persistent changeDetector', () => {
  it('ignores camera sensor noise and global illumination shifts', () => {
    const baseline = makeSample(160, 96, 40)
    let state = createDetectorState()

    // Feed frames with deterministic +-6 luma jitter and +25 exposure shift
    for (let t = 0; t < 4; t++) {
      const data = new Uint8Array(baseline.data.length)
      for (let i = 0; i < data.length; i++) {
        const noise = ((i * 37 + t * 13) % 13) - 6 // -6..+6
        data[i] = 40 + 25 + noise
      }
      const res = updateDetector(
        state,
        { width: 160, height: 96, data },
        baseline,
        null,
      )
      state = res.state
      expect(res.persistentChangedTiles).toBe(0)
      expect(res.sceneShift).toBe(false)
    }
  })

  it('detects a small localized handwriting stroke after STILL_TICKS_FOR_PERSISTENCE', () => {
    const baseline = makeSample(160, 96, 30)
    const withStroke = drawRect(baseline, 20, 20, 6, 3, 95) // 18px in 256px tile (~7% > 3%)
    let state = createDetectorState()

    // Tick 0: initializes prev
    state = updateDetector(state, baseline, baseline, null).state

    // Tick 1: stroke appears (moving tile => stillTicks resets to 0)
    const r1 = updateDetector(state, withStroke, baseline, null)
    state = r1.state
    expect(r1.persistentChangedTiles).toBe(0)

    // Tick 2: stillTick=1 (< 2)
    const r2 = updateDetector(state, withStroke, baseline, null)
    state = r2.state
    expect(r2.persistentChangedTiles).toBe(0)

    // Tick 3: stillTick=2 -> persistent change detected!
    const r3 = updateDetector(state, withStroke, baseline, null)
    expect(r3.persistentChangedTiles).toBeGreaterThanOrEqual(1)
  })

  it('does not treat an actively moving blob as persistent while it moves', () => {
    const baseline = makeSample(160, 96, 30)
    let state = createDetectorState()
    state = updateDetector(state, baseline, baseline, null).state

    // Move a large 32x32 blob 20px right each tick across the board
    for (let step = 0; step < 5; step++) {
      const frame = drawRect(baseline, step * 20, 32, 32, 32, 180)
      const res = updateDetector(state, frame, baseline, null)
      state = res.state
      expect(res.movingFraction).toBeGreaterThan(0)
      // Current blob tiles just moved; old tiles match baseline -> 0 persistent changes
      expect(res.persistentChangedTiles).toBe(0)
    }
  })

  it('flags sceneShift when over half the board changes and respects calibration mask', () => {
    const baseline = makeSample(160, 96, 30)
    const shifted = drawRect(baseline, 0, 0, 140, 80, 140)
    let state = createDetectorState()
    state = updateDetector(state, baseline, baseline, null).state
    for (let i = 0; i <= STILL_TICKS_FOR_PERSISTENCE; i++) {
      const res = updateDetector(state, shifted, baseline, null)
      state = res.state
      if (i === STILL_TICKS_FOR_PERSISTENCE) {
        expect(res.sceneShift).toBe(true)
      }
    }

    // Mask excluding left half ignores stroke placed strictly in left half
    const mask = new Uint8Array(160 * 96)
    for (let y = 0; y < 96; y++) {
      for (let x = 80; x < 160; x++) {
        mask[y * 160 + x] = 1
      }
    }
    const leftStroke = drawRect(baseline, 16, 16, 10, 8, 180)
    let mState = createDetectorState()
    mState = updateDetector(mState, baseline, baseline, mask).state
    for (let i = 0; i <= STILL_TICKS_FOR_PERSISTENCE + 1; i++) {
      const r = updateDetector(mState, leftStroke, baseline, mask)
      mState = r.state
      expect(r.persistentChangedTiles).toBe(0)
    }
  })

  it('classifies bounding-box regions as obscured, changed, or unchanged', () => {
    const lastSeen = makeSample(160, 96, 30)
    const box: [number, number, number, number] = [200, 200, 400, 400]

    // Unchanged calm region
    let state = createDetectorState()
    state = updateDetector(state, lastSeen, lastSeen, null).state
    state = updateDetector(state, lastSeen, lastSeen, null).state
    const rCalm = updateDetector(state, lastSeen, lastSeen, null)
    expect(classifyRegion(box, lastSeen, lastSeen, rCalm.stillTicks, null)).toBe('unchanged')

    // Moving hand over the box -> obscured
    const handOverBox = drawRect(lastSeen, 32, 20, 20, 20, 180)
    const rMoving = updateDetector(rCalm.state, handOverBox, lastSeen, null)
    expect(classifyRegion(box, lastSeen, handOverBox, rMoving.stillTicks, null)).toBe('obscured')

    // Hand leaves / edited chalk remains calm -> changed
    const edited = drawRect(lastSeen, 34, 22, 16, 10, 150)
    let sEdit = updateDetector(rMoving.state, edited, lastSeen, null).state
    sEdit = updateDetector(sEdit, edited, lastSeen, null).state
    const rEdit = updateDetector(sEdit, edited, lastSeen, null)
    expect(classifyRegion(box, lastSeen, edited, rEdit.stillTicks, null)).toBe('changed')
  })
})

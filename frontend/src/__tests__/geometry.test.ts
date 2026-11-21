import { describe, expect, it } from 'vitest'
import {
  buildNormalizedQuadMask,
  clientPointToNormalized,
  computeContainedImageRect,
  computeOverlayPillPosition,
  validateCalibrationQuad,
} from '../lib/geometry'

describe('Stage and calibration geometry', () => {
  it('computes contained image rectangle accurately for landscape and portrait media', () => {
    // 16:9 landscape inside 1000x800 container => pillar-free, top/bottom letterboxed
    const landscapeRect = computeContainedImageRect(1000, 800, 1920, 1080)
    expect(landscapeRect.left).toBe(0)
    expect(landscapeRect.width).toBe(1000)
    expect(landscapeRect.height).toBeCloseTo(562.5, 4)
    expect(landscapeRect.top).toBeCloseTo(118.75, 4)

    // 3:4 portrait inside 1000x800 container => left/right pillarboxed
    const portraitRect = computeContainedImageRect(1000, 800, 750, 1000)
    expect(portraitRect.top).toBe(0)
    expect(portraitRect.height).toBe(800)
    expect(portraitRect.width).toBeCloseTo(600, 4)
    expect(portraitRect.left).toBeCloseTo(200, 4)

    // Resized container recomputes cleanly
    const resized = computeContainedImageRect(600, 600, 750, 1000)
    expect(resized.height).toBe(600)
    expect(resized.width).toBeCloseTo(450, 4)
    expect(resized.left).toBeCloseTo(75, 4)
  })

  it('maps pointer coordinates relative to contained image rect excluding letterboxing', () => {
    const imgRect = computeContainedImageRect(1000, 800, 750, 1000) // left=200, top=0, w=600, h=800
    const containerRect = { left: 50, top: 40 }

    // Center of displayed portrait image => clientX = 50 + 200 + 300 = 550, clientY = 40 + 400 = 440
    const center = clientPointToNormalized(550, 440, containerRect, imgRect)
    expect(center[0]).toBeCloseTo(500, 4)
    expect(center[1]).toBeCloseTo(500, 4)

    // Click inside left letterbox bar clamps cleanly to x=0
    const leftBar = clientPointToNormalized(100, 440, containerRect, imgRect)
    expect(leftBar[0]).toBe(0)
    expect(leftBar[1]).toBeCloseTo(500, 4)
  })

  it('validates calibration quads and rejects degenerate or misordered corners', () => {
    expect(
      validateCalibrationQuad([
        [100, 120],
        [900, 100],
        [920, 880],
        [80, 900],
      ]).valid,
    ).toBe(true)

    // Swapped TL/TR rejected
    expect(
      validateCalibrationQuad([
        [900, 100],
        [100, 100],
        [900, 900],
        [100, 900],
      ]).valid,
    ).toBe(false)

    // Bowtie self-intersecting rejected
    expect(
      validateCalibrationQuad([
        [100, 100],
        [900, 900],
        [900, 100],
        [100, 900],
      ]).valid,
    ).toBe(false)

    // Nearly collinear rejected
    expect(
      validateCalibrationQuad([
        [100, 100],
        [500, 104],
        [900, 108],
        [100, 800],
      ]).valid,
    ).toBe(false)
  })

  it('builds quad mask excluding outside-board pixels and clamps overlay pills inside imageRect', () => {
    const mask = buildNormalizedQuadMask(
      [
        [250, 250],
        [750, 250],
        [750, 750],
        [250, 750],
      ],
      10,
      10,
    )
    // Corner pixel (0,0) center is (50,50) => outside
    expect(mask[0]).toBe(0)
    // Center pixel (5,5) center is (550,550) => inside
    expect(mask[5 * 10 + 5]).toBe(1)

    const imgRect = { left: 100, top: 50, width: 400, height: 300 }
    // Box right at top-right edge must keep pill clamped within [100..500, 50..350]
    const pill = computeOverlayPillPosition([5, 900, 60, 995], imgRect, 200, 30)
    expect(pill.placement).toBe('below')
    expect(pill.left).toBeGreaterThanOrEqual(imgRect.left + 4)
    expect(pill.left + 200).toBeLessThanOrEqual(imgRect.left + imgRect.width)
    expect(pill.top).toBeGreaterThanOrEqual(imgRect.top)
  })
})
